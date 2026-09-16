import { createHash, randomBytes } from 'node:crypto'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { downloadPinnedArtifact } from './component-download.js'

/**
 * Pinned cloudflared Windows component fetched only after an explicit user action.
 *
 * Unlike the cpolar archive this artifact IS the executable: there is nothing to
 * unpack, so the download digest and the installed digest are the same pair.
 * `--no-autoupdate` is passed at runtime as well, so the pinned bytes stay the
 * bytes that were verified.
 */
export const CLOUDFLARED_COMPONENT_RELEASE = Object.freeze({
  version: '2026.9.1',
  platform: 'win32',
  arch: 'x64',
  downloadUrl: 'https://github.com/cloudflare/cloudflared/releases/download/2026.9.1/cloudflared-windows-amd64.exe',
  downloadBytes: 54_976_432,
  downloadSha256: '2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712',
  downloadPage: 'https://github.com/cloudflare/cloudflared/releases',
  termsUrl: 'https://www.cloudflare.com/website-terms/',
})

/**
 * Public, credential-free description of the managed cloudflared component.
 *
 * There is deliberately no `configured` flag: a quick tunnel needs no account,
 * token, or DNS record, so installation is the only precondition.
 */
export interface CloudflaredComponentStatus {
  readonly supported: boolean
  readonly installed: boolean
  readonly version: string
  readonly downloadBytes: number
  readonly installedBytes: number
  readonly sourceUrl: string
  readonly downloadPage: string
  readonly termsUrl: string
  readonly storagePath: string
  readonly errorCode?: string
}

interface CloudflaredComponentManagerOptions {
  readonly stateDirectory: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly fetchArtifact?: (url: string, signal: AbortSignal) => Promise<Uint8Array>
}

function inside(parent: string, child: string): boolean {
  const candidate = relative(parent, child)
  return candidate !== '' && !candidate.startsWith('..') && !isAbsolute(candidate)
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex')
}

async function regularFile(file: string, expectedBytes?: number): Promise<boolean> {
  try {
    const stat = await lstat(file)
    return stat.isFile() && !stat.isSymbolicLink() && (expectedBytes === undefined || stat.size === expectedBytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function defaultFetchArtifact(url: string, signal: AbortSignal): Promise<Uint8Array> {
  return downloadPinnedArtifact({
    url,
    expectedBytes: CLOUDFLARED_COMPONENT_RELEASE.downloadBytes,
    errorPrefix: 'cloudflared',
    signal,
  })
}

/** Owns the optional cloudflared binary inside DSH Mobile state. */
export class CloudflaredComponentManager {
  readonly executable: string
  readonly componentRoot: string
  readonly componentStorage: string
  readonly stateRoot: string
  readonly logRoot: string
  private readonly stagingRoot: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly fetchArtifact: (url: string, signal: AbortSignal) => Promise<Uint8Array>
  private installed = false
  private errorCode: string | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(options: CloudflaredComponentManagerOptions) {
    const stateDirectory = resolve(options.stateDirectory)
    if (!isAbsolute(stateDirectory)) throw new Error('cloudflared state directory must be absolute')
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.componentRoot = join(stateDirectory, 'components', 'cloudflared')
    this.componentStorage = join(this.componentRoot, CLOUDFLARED_COMPONENT_RELEASE.version)
    this.executable = join(this.componentStorage, 'cloudflared.exe')
    this.stateRoot = join(stateDirectory, 'state', 'cloudflared')
    this.logRoot = join(stateDirectory, 'logs', 'cloudflared')
    this.stagingRoot = join(stateDirectory, 'staging', 'cloudflared')
    for (const child of [this.componentRoot, this.componentStorage, this.stateRoot, this.logRoot, this.stagingRoot]) {
      if (!inside(stateDirectory, child)) throw new Error('cloudflared component path escaped its state directory')
    }
    this.fetchArtifact = options.fetchArtifact ?? defaultFetchArtifact
  }

  /** Inspect the managed binary without using any global cloudflared state. */
  async initialize(): Promise<void> {
    this.installed = await regularFile(this.executable, CLOUDFLARED_COMPONENT_RELEASE.downloadBytes)
    if (this.installed && await sha256(this.executable) !== CLOUDFLARED_COMPONENT_RELEASE.downloadSha256) {
      this.installed = false
      this.errorCode = 'cloudflared_component_invalid'
    }
  }

  /** Return a safe status that never includes machine-specific account data. */
  status(): CloudflaredComponentStatus {
    return Object.freeze({
      supported: this.platform === CLOUDFLARED_COMPONENT_RELEASE.platform && this.arch === CLOUDFLARED_COMPONENT_RELEASE.arch,
      installed: this.installed,
      version: CLOUDFLARED_COMPONENT_RELEASE.version,
      downloadBytes: CLOUDFLARED_COMPONENT_RELEASE.downloadBytes,
      installedBytes: CLOUDFLARED_COMPONENT_RELEASE.downloadBytes,
      sourceUrl: CLOUDFLARED_COMPONENT_RELEASE.downloadUrl,
      downloadPage: CLOUDFLARED_COMPONENT_RELEASE.downloadPage,
      termsUrl: CLOUDFLARED_COMPONENT_RELEASE.termsUrl,
      storagePath: this.componentRoot,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
    })
  }

  /** Download, verify, and install the pinned cloudflared executable after explicit confirmation. */
  install(): Promise<CloudflaredComponentStatus> {
    return this.enqueue(async () => {
      if (this.platform !== CLOUDFLARED_COMPONENT_RELEASE.platform || this.arch !== CLOUDFLARED_COMPONENT_RELEASE.arch) {
        throw new Error('cloudflared_component_unsupported')
      }
      await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 })
      const staging = await mkdtemp(join(this.stagingRoot, 'install-'))
      try {
        const controller = new AbortController()
        // The pinned artifact is ~55 MB, so the transfer budget is larger than
        // the cpolar archive's: a slow but working link must not fail the install.
        const timeout = setTimeout(() => { controller.abort() }, 300_000)
        timeout.unref()
        let bytes: Uint8Array
        try { bytes = await this.fetchArtifact(CLOUDFLARED_COMPONENT_RELEASE.downloadUrl, controller.signal) } finally { clearTimeout(timeout) }
        if (bytes.byteLength !== CLOUDFLARED_COMPONENT_RELEASE.downloadBytes) {
          throw new Error('cloudflared_download_size_mismatch')
        }
        const digest = createHash('sha256').update(bytes).digest('hex')
        if (digest !== CLOUDFLARED_COMPONENT_RELEASE.downloadSha256) throw new Error('cloudflared_download_hash_mismatch')
        const staged = join(staging, 'cloudflared.exe')
        await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 })
        await chmod(staged, 0o700)
        if (!await regularFile(staged, CLOUDFLARED_COMPONENT_RELEASE.downloadBytes)
          || await sha256(staged) !== CLOUDFLARED_COMPONENT_RELEASE.downloadSha256) {
          throw new Error('cloudflared_executable_hash_mismatch')
        }
        const candidate = join(this.componentRoot, `.install-${randomBytes(12).toString('hex')}`)
        await mkdir(candidate, { recursive: true, mode: 0o700 })
        await copyFile(staged, join(candidate, 'cloudflared.exe'))
        await chmod(join(candidate, 'cloudflared.exe'), 0o700)
        await rm(this.componentStorage, { recursive: true, force: true })
        await rename(candidate, this.componentStorage)
        this.installed = true
        this.errorCode = undefined
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    })
  }

  /** Remove every cloudflared file owned by DSH Mobile without touching global state. */
  purge(): Promise<CloudflaredComponentStatus> {
    return this.enqueue(async () => {
      await Promise.all([
        rm(this.componentRoot, { recursive: true, force: true }),
        rm(this.stateRoot, { recursive: true, force: true }),
        rm(this.logRoot, { recursive: true, force: true }),
        rm(this.stagingRoot, { recursive: true, force: true }),
      ])
      this.installed = false
      this.errorCode = undefined
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<CloudflaredComponentStatus> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task.then(() => this.status())
  }
}
