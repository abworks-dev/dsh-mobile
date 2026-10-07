import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CaddyController, type CaddyControllerOptions } from '../src/caddy.js'
import { CaddyConfigStore } from '../src/caddy-config.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { parseGatewayConfig } from '../src/config.js'
import { MemoryDeviceStore } from '../src/storage.js'
import { createVolatileRemoteControlStore } from '../src/managed-origin.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(callback => { resolve = callback })
  return { promise, resolve }
}
function childFixture(): ChildProcessWithoutNullStreams {
  const stdin = new PassThrough(); const stdout = new PassThrough(); const stderr = new PassThrough()
  const stdio: [PassThrough, PassThrough, PassThrough, undefined, undefined] = [stdin, stdout, stderr, undefined, undefined]
  return Object.assign(new ChildProcess(), { stdout, stderr, stdin, stdio, exitCode: null, signalCode: null, killed: false })
}
async function fixture(overrides: Partial<CaddyControllerOptions> = {}): Promise<{
  controller: CaddyController; gateway: MobileAccessGateway; child: ChildProcessWithoutNullStreams; closeGateway: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-caddy-controller-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const config = new CaddyConfigStore(root)
  await config.configure({ publicOrigin: 'https://phone.example.com', dnsProvider: 'tencentcloud', listenPort: 8443 }, { secretId: 'fixture-id', secretKey: 'fixture-secret' })
  const gateway = new MobileAccessGateway(parseGatewayConfig({ listenHost: '127.0.0.1', listenPort: 0,
    upstreamOrigin: 'http://127.0.0.1:3080', publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
    stateFile: join(root, 'devices.json'), tls: { mode: 'disabled' } }), new MemoryDeviceStore())
  vi.spyOn(gateway, 'address').mockReturnValue({ host: '127.0.0.1', port: 55123, origin: 'http://127.0.0.1:55123' })
  const closeGateway = vi.spyOn(gateway, 'close')
  const child = childFixture()
  const terminate = vi.fn(async () => { Object.defineProperty(child, 'exitCode', { value: 0 }); child.emit('close', 0) })
  const controller = new CaddyController({ config, instanceId: 'fixture-instance', store: createVolatileRemoteControlStore(),
    component: { executable: join(root, 'caddy.exe'), ensureExecutable: async () => undefined,
      status: () => ({ supported: true, installed: true, version: '2.11.6', downloadBytes: 1, installedBytes: 1,
        sourceUrl: 'https://example.com/caddy', downloadPage: '', storagePath: root }) },
    createGateway: async () => gateway, validateConfig: async () => undefined, spawnProcess: () => child,
    probeDiscovery: async () => true, terminateProcess: terminate, ...overrides,
  })
  cleanups.push(() => controller.close())
  await controller.initialize()
  return { controller, gateway, child, closeGateway, terminate }
}

describe('managed Caddy lifecycle', () => {
  it('publishes ready only after a verified public discovery result and uses the actual private Gateway port', async () => {
    const entered = deferred<void>(); const result = deferred<boolean>()
    const setup = await fixture({ probeDiscovery: async () => { entered.resolve(); return result.promise } })
    const starting = setup.controller.setEnabled(true); await entered.promise
    expect(setup.controller.status().state).toBe('starting'); expect(setup.controller.gateway()).toBeUndefined()
    result.resolve(true); await starting
    expect(setup.controller.status()).toMatchObject({ state: 'ready', backendOrigin: 'http://127.0.0.1:55123' })
    expect(setup.controller.gateway()).toBe(setup.gateway)
    await setup.controller.close(); expect(setup.closeGateway).toHaveBeenCalledTimes(1); expect(setup.terminate).toHaveBeenCalledTimes(1)
  })
  it('closes the acquired Gateway when configuration validation fails before spawning', async () => {
    const setup = await fixture({ validateConfig: async () => { throw new Error('caddy_config_validation_failed') } })
    await setup.controller.setEnabled(true)
    expect(setup.controller.status()).toMatchObject({ state: 'error', errorCode: 'caddy_config_validation_failed' })
    expect(setup.closeGateway).toHaveBeenCalledTimes(1); expect(setup.terminate).not.toHaveBeenCalled()
  })
  it('closes the acquired Gateway after a synchronous spawn failure', async () => {
    const setup = await fixture({ spawnProcess: () => { throw new Error('spawn failed') } })
    await setup.controller.setEnabled(true)
    expect(setup.closeGateway).toHaveBeenCalledTimes(1); expect(setup.controller.gateway()).toBeUndefined()
  })
  it('cleans both resources when the child exits while public readiness is pending', async () => {
    const entered = deferred<void>()
    const setup = await fixture({ probeDiscovery: async (_origin, _id, signal) => {
      entered.resolve(); return new Promise<boolean>(resolve => { signal.addEventListener('abort', () => resolve(false), { once: true }) })
    } })
    const starting = setup.controller.setEnabled(true); await entered.promise
    Object.defineProperty(setup.child, 'exitCode', { value: 1 }); setup.child.emit('close', 1); await starting
    expect(setup.controller.status()).toMatchObject({ state: 'error', errorCode: 'caddy_exited' })
    expect(setup.closeGateway).toHaveBeenCalledTimes(1); expect(setup.terminate).toHaveBeenCalledTimes(1)
  })
  it('disposes during a late Gateway acquisition without spawning or publishing ready', async () => {
    const entered = deferred<void>(); const result = deferred<MobileAccessGateway>(); const spawned = vi.fn(() => childFixture())
    const setup = await fixture({ createGateway: async () => { entered.resolve(); return result.promise }, spawnProcess: spawned })
    const starting = setup.controller.setEnabled(true); await entered.promise
    const closing = setup.controller.close(); result.resolve(setup.gateway)
    await Promise.all([starting, closing])
    expect(setup.closeGateway).toHaveBeenCalledTimes(1); expect(spawned).not.toHaveBeenCalled(); expect(setup.controller.status().state).toBe('off')
  })
  it('cancels a pending probe on disable and rejects a different public identity', async () => {
    const entered = deferred<void>()
    const setup = await fixture({ probeDiscovery: async (_origin, _id, signal) => {
      entered.resolve(); return new Promise<boolean>(resolve => { signal.addEventListener('abort', () => resolve(false), { once: true }) })
    } })
    const starting = setup.controller.setEnabled(true); await entered.promise
    const stopping = setup.controller.setEnabled(false); await Promise.all([starting, stopping])
    expect(setup.controller.status()).toMatchObject({ enabled: false, state: 'off' }); expect(setup.closeGateway).toHaveBeenCalledTimes(1)
    const mismatch = await fixture({ probeDiscovery: async () => { throw new Error('frp_discovery_mismatch') } })
    await mismatch.controller.setEnabled(true)
    expect(mismatch.controller.status()).toMatchObject({ state: 'error', errorCode: 'caddy_public_identity_invalid' })
    expect(mismatch.closeGateway).toHaveBeenCalledTimes(1)
  })
  it('retains resource ownership when cleanup fails and retries close without starting another process', async () => {
    const closeChild = vi.fn(async () => undefined).mockRejectedValueOnce(new Error('cleanup failed'))
    const setup = await fixture({ terminateProcess: closeChild })
    await setup.controller.setEnabled(true); await expect(setup.controller.close()).rejects.toThrow('cleanup failed')
    await setup.controller.close()
    expect(closeChild).toHaveBeenCalledTimes(2); expect(setup.closeGateway).toHaveBeenCalledTimes(1)
  })
})
