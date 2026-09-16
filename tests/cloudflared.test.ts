import { EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MobileAccessControlState, MobileAccessControlStore } from '../src/control.js'
import {
  CloudflaredController,
  type CloudflaredStatus,
  parseCloudflaredOrigin,
} from '../src/cloudflared.js'
import type { MobileAccessGateway } from '../src/gateway.js'

const temporaryDirectories: string[] = []
const controllers: CloudflaredController[] = []
const releaseBarriers: Array<() => void> = []

afterEach(async () => {
  for (const release of releaseBarriers.splice(0)) release()
  const results = await Promise.allSettled(controllers.splice(0).map(controller => controller.close()))
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
  const failure = results.find(result => result.status === 'rejected')
  if (failure?.status === 'rejected') throw failure.reason
})

class MemoryControlStore implements MobileAccessControlStore {
  state: MobileAccessControlState = { version: 1, enabled: true }

  async load(): Promise<MobileAccessControlState> { return this.state }
  async save(state: MobileAccessControlState): Promise<void> { this.state = state }
}

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  /** cloudflared prints the quick-tunnel banner on stderr, decorated with box rules. */
  writeBanner(origin: string): void {
    this.stderr.write(`${'-'.repeat(92)}\n`)
    this.stderr.write('|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\n')
    this.stderr.write(`|  ${origin}  |\n`)
    this.stderr.write(`${'-'.repeat(92)}\n`)
  }

  kill(): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false
    this.exitCode = 0
    this.stdin.destroy()
    this.stdout.destroy()
    this.stderr.destroy()
    setImmediate(() => { this.emit('close', 0) })
    return true
  }
}

class StatusJournal {
  readonly values: CloudflaredStatus[] = []
  private readonly listeners = new Set<(status: CloudflaredStatus) => void>()

  readonly publish = (status: CloudflaredStatus): void => {
    this.values.push(status)
    for (const listener of [...this.listeners]) listener(status)
  }

  waitFor(predicate: (status: CloudflaredStatus) => boolean): Promise<CloudflaredStatus> {
    const current = this.values.findLast(predicate)
    if (current !== undefined) return Promise.resolve(current)
    return new Promise(resolve => {
      const listener = (status: CloudflaredStatus): void => {
        if (!predicate(status)) return
        this.listeners.delete(listener)
        resolve(status)
      }
      this.listeners.add(listener)
    })
  }
}

interface FakeGateway extends MobileAccessGateway {
  close: ReturnType<typeof vi.fn<() => Promise<void>>>
}

function gateway(origin: string, port: number, close: () => Promise<void> = async () => undefined): FakeGateway {
  return {
    address: () => ({ host: '127.0.0.1', port, origin }),
    close: vi.fn(close),
  } as unknown as FakeGateway
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>(resolve => { resolvePromise = resolve })
  const resolve = (): void => { resolvePromise?.() }
  releaseBarriers.push(resolve)
  return { promise, resolve }
}

async function fixture(
  createGateway: (origin: string, port: number) => Promise<MobileAccessGateway>,
): Promise<{
  readonly child: FakeChild
  readonly controller: CloudflaredController
  readonly journal: StatusJournal
  readonly args: () => readonly string[]
}> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cloudflared-'))
  temporaryDirectories.push(directory)
  const executable = join(directory, 'component', 'cloudflared.exe')
  await mkdir(dirname(executable), { recursive: true })
  await writeFile(executable, 'fake-cloudflared')
  const child = new FakeChild()
  let startedArgs: readonly string[] = []
  const journal = new StatusJournal()
  const controller = new CloudflaredController({
    store: new MemoryControlStore(),
    executable,
    createGateway,
    onStatus: journal.publish,
    spawnProcess: (_executable, args) => {
      startedArgs = [...args]
      return child as unknown as ChildProcessWithoutNullStreams
    },
  })
  controllers.push(controller)
  await controller.initialize()
  return { child, controller, journal, args: () => startedArgs }
}

describe('cloudflared log protocol', () => {
  it('accepts a quick-tunnel hostname out of the decorated banner', () => {
    expect(parseCloudflaredOrigin('|  https://random-words-here.trycloudflare.com  |'))
      .toBe('https://random-words-here.trycloudflare.com')
    expect(parseCloudflaredOrigin('2026-09-15T00:00:00Z INF Your quick Tunnel has been created! Visit it at https://calm-river-blue.trycloudflare.com'))
      .toBe('https://calm-river-blue.trycloudflare.com')
    expect(parseCloudflaredOrigin('https://a-b.trycloudflare.com.')).toBe('https://a-b.trycloudflare.com')
  })

  it('ignores lines that never mention the provider suffix', () => {
    expect(parseCloudflaredOrigin('2026-09-15T00:00:00Z INF Registered tunnel connection connIndex=0')).toBeUndefined()
    expect(parseCloudflaredOrigin('+-----------------------------------------------------------+')).toBeUndefined()
  })

  it('ignores a suffix mention that carries no URL instead of failing the tunnel', () => {
    expect(parseCloudflaredOrigin('ERR failed to reach trycloudflare.com over the configured proxy')).toBeUndefined()
  })

  it('rejects lookalike, insecure, credentialed, and non-root origins', () => {
    expect(() => parseCloudflaredOrigin('https://x.trycloudflare.com.evil.test')).toThrow('invalid_cloudflared_origin')
    expect(() => parseCloudflaredOrigin('http://x.trycloudflare.com')).toThrow('invalid_cloudflared_origin')
    expect(() => parseCloudflaredOrigin('https://trycloudflare.com')).toThrow('invalid_cloudflared_origin')
    expect(() => parseCloudflaredOrigin('https://user@x.trycloudflare.com')).toThrow('invalid_cloudflared_origin')
    expect(() => parseCloudflaredOrigin('https://x.trycloudflare.com/path')).toThrow('invalid_cloudflared_origin')
    expect(() => parseCloudflaredOrigin('https://x.trycloudflare.com:8443')).toThrow('invalid_cloudflared_origin')
  })
})

describe('cloudflared provider lifecycle', () => {
  it('launches a quick tunnel for the reserved loopback port with autoupdate disabled', async () => {
    const { args } = await fixture(async () => gateway('https://quiet-forest.trycloudflare.com', 1))
    expect(args()[0]).toBe('tunnel')
    expect(args()[1]).toBe('--url')
    expect(args()[2]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u)
    expect(args()).toContain('--no-autoupdate')
    // No account, token, or origin TLS override belongs in a quick-tunnel launch.
    expect(args().join(' ')).not.toContain('--token')
    expect(args().join(' ')).not.toContain('no-tls-verify')
  })

  it('rotates different origins in order on the same loopback port', async () => {
    const firstClose = deferred()
    const gateways: FakeGateway[] = []
    const createGateway = vi.fn(async (origin: string, port: number): Promise<MobileAccessGateway> => {
      const created = gateway(origin, port, gateways.length === 0 ? () => firstClose.promise : undefined)
      gateways.push(created)
      return created
    })
    const { child, controller, journal } = await fixture(createGateway)
    const firstOrigin = 'https://first-tunnel.trycloudflare.com'
    const secondOrigin = 'https://second-tunnel.trycloudflare.com'
    const thirdOrigin = 'https://third-tunnel.trycloudflare.com'

    const firstReady = journal.waitFor(status => status.state === 'ready' && status.origin === firstOrigin)
    child.writeBanner(firstOrigin)
    await firstReady
    expect(controller.gateway()).toBe(gateways[0])
    const listenerPort = createGateway.mock.calls[0]![1]
    expect(listenerPort).toBeGreaterThan(0)

    // A repeated banner is informational, not a rotation.
    child.writeBanner(firstOrigin)
    await controller.setEnabled(true)
    expect(createGateway).toHaveBeenCalledTimes(1)

    const secondConnecting = journal.waitFor(status => status.state === 'connecting' && status.origin === secondOrigin)
    child.writeBanner(secondOrigin)
    await secondConnecting
    expect(controller.gateway()).toBeUndefined()
    expect(gateways[0]!.close).toHaveBeenCalledOnce()
    expect(createGateway).toHaveBeenCalledTimes(1)

    // A later rotation queues behind the in-progress close instead of racing a
    // second listener onto the same loopback port.
    const secondReady = journal.waitFor(status => status.state === 'ready' && status.origin === secondOrigin)
    const thirdReady = journal.waitFor(status => status.state === 'ready' && status.origin === thirdOrigin)
    child.writeBanner(thirdOrigin)
    firstClose.resolve()
    await secondReady
    await thirdReady

    expect(createGateway.mock.calls).toEqual([
      [firstOrigin, listenerPort],
      [secondOrigin, listenerPort],
      [thirdOrigin, listenerPort],
    ])
    expect(gateways[1]!.close).toHaveBeenCalledOnce()
    expect(controller.gateway()).toBe(gateways[2])
    expect(controller.status()).toEqual({ enabled: true, state: 'ready', origin: thirdOrigin })
    expect(journal.values.filter(status => status.state === 'connecting').map(status => status.origin)).toEqual([
      firstOrigin,
      secondOrigin,
      thirdOrigin,
    ])
  })

  it('stops the owned process when a rotated gateway cannot start', async () => {
    let created: FakeGateway | undefined
    const createGateway = vi.fn(async (origin: string, port: number): Promise<MobileAccessGateway> => {
      if (created !== undefined) throw new Error('replacement failed')
      created = gateway(origin, port)
      return created
    })
    const { child, controller, journal } = await fixture(createGateway)
    const ready = journal.waitFor(status => status.state === 'ready')
    child.writeBanner('https://first-tunnel.trycloudflare.com')
    await ready

    const failed = journal.waitFor(status => status.state === 'error')
    child.writeBanner('https://second-tunnel.trycloudflare.com')
    await failed

    expect(created?.close).toHaveBeenCalledOnce()
    expect(child.exitCode).toBe(0)
    expect(controller.gateway()).toBeUndefined()
    expect(controller.status()).toEqual({ enabled: true, state: 'error', errorCode: 'gateway_start_failed' })
  })

  it('does not start a replacement after close begins during rotation', async () => {
    const firstClose = deferred()
    const gateways: FakeGateway[] = []
    const createGateway = vi.fn(async (origin: string, port: number): Promise<MobileAccessGateway> => {
      const created = gateway(origin, port, () => firstClose.promise)
      gateways.push(created)
      return created
    })
    const { child, controller, journal } = await fixture(createGateway)
    const ready = journal.waitFor(status => status.state === 'ready')
    child.writeBanner('https://first-tunnel.trycloudflare.com')
    await ready

    const connecting = journal.waitFor(status => status.state === 'connecting' && status.origin === 'https://second-tunnel.trycloudflare.com')
    child.writeBanner('https://second-tunnel.trycloudflare.com')
    await connecting
    const closing = controller.close()
    firstClose.resolve()
    await closing

    expect(createGateway).toHaveBeenCalledOnce()
    expect(gateways[0]!.close).toHaveBeenCalledOnce()
    expect(child.exitCode).toBe(0)
    expect(controller.gateway()).toBeUndefined()
  })

  it('reports an uninstalled component instead of launching anything', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cloudflared-missing-'))
    temporaryDirectories.push(directory)
    const spawnProcess = vi.fn() as unknown as (
      executable: string,
      args: readonly string[],
      environment: NodeJS.ProcessEnv,
    ) => ChildProcessWithoutNullStreams
    const controller = new CloudflaredController({
      store: new MemoryControlStore(),
      executable: join(directory, 'component', 'cloudflared.exe'),
      createGateway: async () => gateway('https://never.trycloudflare.com', 1),
      spawnProcess,
    })
    controllers.push(controller)
    await controller.initialize()

    expect(spawnProcess).not.toHaveBeenCalled()
    expect(controller.status()).toEqual({
      enabled: true,
      state: 'unavailable',
      errorCode: 'cloudflared_component_missing',
    })
  })

  it('fails a generation that never reports a public hostname', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cloudflared-timeout-'))
    temporaryDirectories.push(directory)
    const executable = join(directory, 'component', 'cloudflared.exe')
    await mkdir(dirname(executable), { recursive: true })
    await writeFile(executable, 'fake-cloudflared')
    const child = new FakeChild()
    const journal = new StatusJournal()
    const controller = new CloudflaredController({
      store: new MemoryControlStore(),
      executable,
      createGateway: async () => gateway('https://never.trycloudflare.com', 1),
      onStatus: journal.publish,
      // The product bound is a minute; the liveness branch is what is under test.
      startupTimeoutMs: 20,
      spawnProcess: () => child as unknown as ChildProcessWithoutNullStreams,
    })
    controllers.push(controller)
    await controller.initialize()

    const failed = await journal.waitFor(status => status.state === 'error')
    expect(failed).toEqual({ enabled: true, state: 'error', errorCode: 'cloudflared_start_timeout' })
    expect(child.exitCode).toBe(0)
    expect(controller.gateway()).toBeUndefined()
  })
})
