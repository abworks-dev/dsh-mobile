import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { MobileAccessGateway } from './gateway.js'
import { settleRemoteResources, terminateRemoteProcess, type RemoteProviderController } from './remote.js'

/** Product-facing states for the managed-Caddy remote transport. */
export type CaddyState = 'off' | 'unavailable' | 'starting' | 'ready' | 'error'

/** Safe Caddy state returned only through the loopback DSH control route. */
export interface CaddyStatus {
  readonly enabled: boolean
  readonly state: CaddyState
  readonly origin?: string
  readonly errorCode?: string
}

/** Inputs for one managed Caddy process and its authenticated DSH gateway. */
export interface CaddyControllerOptions {
  readonly store: { load(): Promise<{ enabled: boolean }>; save(state: { version: 1; enabled: boolean }): Promise<void> }
  readonly executable: string
  readonly caddyfile: string
  /** Environment entries for the DNS provider credentials (from the private env file). */
  readonly credentialEnvironment: () => Record<string, string>
  readonly publicOrigin: () => string | undefined
  readonly createGateway: (origin: string, listenPort: number) => Promise<MobileAccessGateway>
  readonly onStatus?: (status: CaddyStatus) => void
  readonly spawnProcess?: (
    executable: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => ChildProcessWithoutNullStreams
}

function publicStatus(status: CaddyStatus): CaddyStatus {
  return Object.freeze({
    enabled: status.enabled,
    state: status.state,
    ...(status.origin === undefined ? {} : { origin: status.origin }),
    ...(status.errorCode === undefined ? {} : { errorCode: status.errorCode }),
  })
}

function spawnCaddyProcess(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): ChildProcessWithoutNullStreams {
  return spawn(executable, [...args], {
    env: environment,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

/**
 * Owns a managed Caddy process and the authenticated origin gateway it fronts.
 *
 * Start order matters: the gateway listens first, then Caddy spawns — a brief
 * window where the public address cannot serve is preferable to Caddy proxying
 * into a dead backend. The managed Caddyfile sets `admin off` so a second
 * caddy on the same machine (a hand install is the most common one) cannot
 * collide on the default admin port, and the process gets its DNS credentials
 * through the environment only.
 */
export class CaddyController implements RemoteProviderController {
  private enabled = false
  private initialized = false
  private disposed = false
  private child: ChildProcessWithoutNullStreams | undefined
  private gatewayValue: MobileAccessGateway | undefined
  private generation = 0
  private latest: CaddyStatus = publicStatus({ enabled: false, state: 'off' })
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly options: CaddyControllerOptions) {
    if (!isAbsolute(options.executable)) throw new Error('caddy executable path must be absolute')
    if (!isAbsolute(options.caddyfile)) throw new Error('caddy config path must be absolute')
  }

  /** Restore the remembered managed-Caddy switch independently from LAN and other providers. */
  async initialize(): Promise<void> {
    const state = await this.options.store.load()
    this.enabled = state.enabled
    this.initialized = true
    if (this.enabled) await this.start()
    else this.publish({ enabled: false, state: 'off' })
  }

  /** Return the active managed-Caddy-backed DSH gateway. */
  gateway(): MobileAccessGateway | undefined { return this.gatewayValue }

  /** Return state safe for the desktop control UI. */
  status(): CaddyStatus { return publicStatus(this.latest) }

  /** Enable or disable managed Caddy without changing LAN or other provider state. */
  async setEnabled(enabled: boolean): Promise<CaddyStatus> {
    if (!this.initialized || this.disposed) throw new Error('caddy controller is unavailable')
    await this.enqueue(async () => {
      if (this.enabled === enabled && (enabled === false || this.child !== undefined)) return
      if (!enabled) await this.stop()
      this.enabled = enabled
      await this.options.store.save({ version: 1, enabled })
      if (enabled) await this.start()
      else this.publish({ enabled: false, state: 'off' })
    })
    return this.status()
  }

  /** Restart the managed Caddy process and the origin gateway. */
  async reconnect(): Promise<CaddyStatus> {
    if (!this.initialized || this.disposed) throw new Error('caddy controller is unavailable')
    await this.enqueue(async () => {
      if (!this.enabled) {
        this.enabled = true
        await this.options.store.save({ version: 1, enabled: true })
      }
      await this.stop()
      await this.start()
    })
    return this.status()
  }

  /** Disable managed Caddy without deleting the installed component. */
  async reset(): Promise<CaddyStatus> {
    if (!this.initialized || this.disposed) throw new Error('caddy controller is unavailable')
    await this.enqueue(async () => {
      await this.stop()
      this.enabled = false
      await this.options.store.save({ version: 1, enabled: false })
      this.publish({ enabled: false, state: 'off' })
    })
    return this.status()
  }

  /** Stop owned resources without changing the remembered switch. */
  async close(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await this.enqueue(() => this.stop())
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private publish(status: CaddyStatus): void {
    this.latest = publicStatus(status)
    try { this.options.onStatus?.(this.status()) } catch { /* UI observation cannot own runtime state. */ }
  }

  private async start(): Promise<void> {
    const generation = ++this.generation
    let executableEntry
    try { executableEntry = await lstat(this.options.executable) } catch {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'caddy_component_missing' })
      return
    }
    if (!executableEntry.isFile() || executableEntry.isSymbolicLink()) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'caddy_component_invalid' })
      return
    }

    const publicOrigin = this.options.publicOrigin()
    if (publicOrigin === undefined) {
      this.publish({ enabled: true, state: 'unavailable', errorCode: 'caddy_config_missing' })
      return
    }
    this.publish({ enabled: true, state: 'starting', origin: publicOrigin })
    // The gateway binds before caddy spawns: a short window where the public
    // address cannot serve beats caddy proxying into a dead backend.
    let gateway: MobileAccessGateway
    try { gateway = await this.options.createGateway(publicOrigin, 3444) } catch (error) {
      const conflict = (error as NodeJS.ErrnoException | undefined)?.code === 'EADDRINUSE'
      this.publish({
        enabled: true, state: 'error', origin: publicOrigin,
        errorCode: conflict ? 'caddy_backend_port_in_use' : 'gateway_start_failed',
      })
      return
    }
    if (generation !== this.generation || !this.enabled || this.disposed) {
      await gateway.close()
      return
    }
    const child = (this.options.spawnProcess ?? spawnCaddyProcess)(
      this.options.executable,
      ['run', `--config=${this.options.caddyfile}`, '--adapter', 'caddyfile'],
      { ...process.env, ...this.options.credentialEnvironment() },
    )
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.once('error', () => { void this.enqueue(() => this.failGeneration(generation, 'caddy_launch_failed')) })
    child.once('close', code => {
      if (generation !== this.generation || this.child !== child) return
      this.child = undefined
      if (this.enabled) {
        void this.enqueue(() => this.failGeneration(generation, code === 0 ? 'caddy_stopped' : 'caddy_exited'))
      }
    })
    // Give the process a beat to die on a bad config; then attach the gateway.
    await new Promise<void>(resolveTimer => { setTimeout(resolveTimer, 300).unref() })
    if (generation !== this.generation || !this.enabled || this.disposed || this.child === undefined) return
    this.gatewayValue = gateway
    this.publish({ enabled: true, state: 'ready', origin: publicOrigin })
  }

  /** Attach the origin gateway once the caddy process is known alive. */
  attachGateway(gateway: MobileAccessGateway, origin: string): void {
    if (this.disposed || !this.enabled) {
      void gateway.close()
      return
    }
    this.gatewayValue = gateway
    this.publish({ enabled: true, state: 'ready', origin })
  }

  private async failGeneration(generation: number, code: string): Promise<void> {
    if (generation !== this.generation) return
    await this.stopProcessAndGateway()
    if (this.enabled) this.publish({ enabled: true, state: 'error', errorCode: code })
  }

  private async stop(): Promise<void> {
    ++this.generation
    await this.stopProcessAndGateway()
  }

  private async stopProcessAndGateway(): Promise<void> {
    const child = this.child
    this.child = undefined
    const gateway = this.gatewayValue
    this.gatewayValue = undefined
    await settleRemoteResources([
      () => child !== undefined && child.exitCode === null ? terminateRemoteProcess(child) : undefined,
      () => gateway?.close(),
    ], 'caddy resource cleanup failed')
  }
}