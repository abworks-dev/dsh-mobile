import { describe, expect, it } from 'vitest'
import { AccessController, AccessError, BoundedRateLimiter } from '../src/access.js'
import { MemoryDeviceStore, parseDeviceSnapshot, type DeviceSnapshot, type DeviceStore } from '../src/storage.js'

function controller(store: DeviceStore, now: () => number, overrides: Partial<ConstructorParameters<typeof AccessController>[1]> = {}): AccessController {
  return new AccessController(store, {
    pairingTtlMs: 60_000,
    deviceTtlMs: 3_600_000,
    sessionTtlMs: 30_000,
    maxDevices: 4,
    maxSessions: 4,
    rateLimitWindowMs: 60_000,
    maxPairingAttempts: 4,
    maxRateLimitKeys: 4,
    now,
    ...overrides,
  })
}

describe('device and Session state', () => {
  it('persists only a device digest and consumes pairing exactly once', async () => {
    let current = 1_000_000
    const store = new MemoryDeviceStore()
    const access = controller(store, () => current)
    await access.initialize()
    const opened = await access.openPairing()
    const [first, second] = await Promise.allSettled([
      access.pair('192.168.1.3', opened.token, 'Phone'),
      access.pair('192.168.1.3', opened.token, 'Phone'),
    ])
    const successful = [first, second].find(result => result.status === 'fulfilled')
    const failed = [first, second].find(result => result.status === 'rejected')
    expect(successful?.status).toBe('fulfilled')
    expect(failed?.status).toBe('rejected')
    if (successful?.status !== 'fulfilled') throw new Error('pairing did not succeed')
    const durable = JSON.stringify(store.inspect())
    expect(durable).not.toContain(opened.token)
    expect(durable).not.toContain(successful.value.deviceToken)
    expect(store.inspect().devices[0]?.tokenDigest).toMatch(/^[a-f\d]{64}$/)

    const authorization = access.authorizeSession(successful.value.sessionToken)
    expect(() => access.assertCsrf(authorization, 'wrong')).toThrowError(AccessError)
    expect(() => access.assertCsrf(authorization, successful.value.csrfToken)).not.toThrow()

    current += 1_000
    const reloaded = controller(store, () => current)
    await reloaded.initialize()
    const renewed = await reloaded.renew(successful.value.deviceToken)
    expect(reloaded.authorizeSession(renewed.sessionToken).deviceId).toBe(successful.value.deviceId)
  })

  it('expires Sessions, logs out one Session, and revokes every Session for a device', async () => {
    let current = 5_000
    const access = controller(new MemoryDeviceStore(), () => current, { sessionTtlMs: 1_000 })
    const ended: string[] = []
    access.onSessionEnded((_authorization, reason) => { ended.push(reason) })
    await access.initialize()
    const opened = await access.openPairing()
    const paired = await access.pair('source', opened.token)
    const authorization = access.authorizeSession(paired.sessionToken)
    access.logout(authorization)
    expect(() => access.authorizeSession(paired.sessionToken)).toThrowError(AccessError)

    const renewed = await access.renew(paired.deviceToken)
    current += 1_001
    expect(() => access.authorizeSession(renewed.sessionToken)).toThrowError(AccessError)

    current += 1
    const again = await access.renew(paired.deviceToken)
    expect(await access.revokeDevice(paired.deviceId)).toBe(true)
    expect(ended).toContain('revoked')
    expect(() => access.authorizeSession(again.sessionToken)).toThrowError(AccessError)
    await expect(access.renew(paired.deviceToken)).rejects.toMatchObject({ status: 401, code: 'device_revoked' })
  })

  it('distinguishes an expired device from an explicitly revoked device', async () => {
    let current = 20_000
    const access = controller(new MemoryDeviceStore(), () => current, { deviceTtlMs: 1_000 })
    await access.initialize()
    const firstWindow = await access.openPairing()
    const first = await access.pair('source-a', firstWindow.token)
    current = 21_001
    await expect(access.renew(first.deviceToken)).rejects.toMatchObject({ status: 401, code: 'device_expired' })

    current = 30_000
    const secondWindow = await access.openPairing()
    const second = await access.pair('source-b', secondWindow.token)
    await access.revokeDevice(second.deviceId)
    await expect(access.renew(second.deviceToken)).rejects.toMatchObject({ status: 401, code: 'device_revoked' })
  })

  it('probes a device without creating a short-lived Session', async () => {
    let current = 25_000
    const access = controller(new MemoryDeviceStore(), () => current)
    await access.initialize()
    const opened = await access.openPairing()
    const paired = await access.pair('source', opened.token)
    const before = access.metrics().sessions

    const result = await access.probe(paired.deviceToken)

    expect(result).toMatchObject({ deviceId: paired.deviceId, deviceExpiresAt: paired.deviceExpiresAt })
    expect(access.metrics().sessions).toBe(before)
    await access.revokeDevice(paired.deviceId)
    await expect(access.probe(paired.deviceToken)).rejects.toMatchObject({ status: 401, code: 'device_revoked' })
  })

  it('caps a renewed Session at the persistent device expiry', async () => {
    let current = 30_000
    const access = controller(new MemoryDeviceStore(), () => current, {
      deviceTtlMs: 2_000,
      sessionTtlMs: 1_500,
    })
    await access.initialize()
    const opened = await access.openPairing()
    const paired = await access.pair('source', opened.token)
    current += 1_500

    const renewed = await access.renew(paired.deviceToken)
    expect(renewed.sessionExpiresAt).toBe(32_000)
    current = renewed.sessionExpiresAt
    expect(() => access.authorizeSession(renewed.sessionToken)).toThrowError(AccessError)
  })

  it('bounds Session eviction and attacker-controlled limiter keys', async () => {
    let current = 10_000
    const access = controller(new MemoryDeviceStore(), () => current, { maxSessions: 2 })
    await access.initialize()
    const opened = await access.openPairing()
    const paired = await access.pair('a', opened.token)
    current += 1
    const second = await access.renew(paired.deviceToken)
    current += 1
    const third = await access.renew(paired.deviceToken)
    expect(() => access.authorizeSession(paired.sessionToken)).toThrowError(AccessError)
    expect(access.authorizeSession(second.sessionToken).deviceId).toBe(paired.deviceId)
    expect(access.authorizeSession(third.sessionToken).deviceId).toBe(paired.deviceId)
    expect(access.metrics().sessions).toBe(2)

    const limiter = new BoundedRateLimiter(1, 1_000, 2)
    expect(limiter.take('one', current)).toBe(true)
    expect(limiter.take('one', current)).toBe(false)
    expect(limiter.take('two', current)).toBe(true)
    expect(limiter.take('three', current)).toBe(false)
    expect(limiter.size).toBe(2)
  })

  it('rate-limits failed pairing without closing the valid window', async () => {
    const access = controller(new MemoryDeviceStore(), () => 20_000, { maxPairingAttempts: 2 })
    await access.initialize()
    const opened = await access.openPairing()
    await expect(access.pair('source', 'wrong')).rejects.toMatchObject({ status: 401 })
    await expect(access.pair('source', 'wrong-again')).rejects.toMatchObject({ status: 401 })
    await expect(access.pair('source', opened.token)).rejects.toMatchObject({ status: 429 })
    const paired = await access.pair('different-source', opened.token)
    expect(paired.deviceId).toMatch(/^[a-f\d]{32}$/)
  })

  it('waits for an accepted durable mutation before teardown completes', async () => {
    const backing = new MemoryDeviceStore()
    let releaseSave!: () => void
    const saveGate = new Promise<void>(resolve => { releaseSave = resolve })
    let announceSave!: () => void
    const saveStarted = new Promise<void>(resolve => { announceSave = resolve })
    const store: DeviceStore = {
      load: () => backing.load(),
      async save(snapshot: DeviceSnapshot) {
        announceSave()
        await saveGate
        await backing.save(snapshot)
      },
    }
    const access = controller(store, () => 30_000)
    await access.initialize()
    const opened = await access.openPairing()
    const pairing = access.pair('source', opened.token)
    await saveStarted

    let closed = false
    const closing = access.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    await expect(access.openPairing()).rejects.toThrow(/not available/)

    releaseSave()
    await Promise.all([pairing, closing])
    expect(closed).toBe(true)
    expect(access.metrics().sessions).toBe(0)
  })

  it('fails closed on malformed or duplicate durable identities', () => {
    expect(() => parseDeviceSnapshot({ version: 0, devices: [] })).toThrow(/unsupported/)
    const device = {
      id: 'a'.repeat(32),
      label: 'Phone',
      tokenDigest: 'b'.repeat(64),
      createdAt: 1,
      expiresAt: 2,
      lastSeenAt: 1,
    }
    expect(() => parseDeviceSnapshot({ version: 1, devices: [device, device] })).toThrow(/duplicate/)
    expect(() => parseDeviceSnapshot({ version: 1, devices: [{ ...device, tokenDigest: 'raw-token' }] })).toThrow(/digest/)
  })
})
