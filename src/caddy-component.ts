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
 * Pinned managed-Caddy components fetched only after an explicit user action.
 *
 * Caddy's standard distribution has no DNS-provider plugins, and DNS-01 is what
 * lets a home connection renew certificates without ports 80/443, so the pinned
 * artifacts come from Caddy's official custom-build CDN with exactly one extra
 * module: the DNS provider. Each entry carries the wire digest
 * (`downloadBytes`/`downloadSha256`) and the installed-executable digest
 * (`executableBytes`/`executableSha256`); bare artifacts make the pairs equal.
 */
interface CaddyArtifact {
  readonly version: string
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly downloadUrl: string
  readonly downloadBytes: number
  readonly downloadSha256: string
  readonly executableName: string
  readonly executableBytes: number
  readonly executableSha256: string
}

const DOWNLOAD_TIMEOUT_MS = 600_000

const CADDY_VERSION = '2.11.6'
const TENCENTCLOUD_PLUGIN_VERSION = 'v0.4.3'

const customBuildUrl = (platform: string, arch: string): string =>
  `https://caddyserver.com/api/download?os=${platform}&arch=${arch}&p=github.com%2Fcaddy-dns%2Ftencentcloud%40${TENCENTCLOUD_PLUGIN_VERSION}`

const releases = [
  {
    version: CADDY_VERSION,
    platform: 'win32',
    arch: 'x64',
    downloadUrl: customBuildUrl('windows', 'amd64'),
    downloadBytes: 51_867_136,
    downloadSha256: '7110a0a0b4a7b87771c301542002c43303768e9f3c6215b04050e665fd3a1937',
    executableName: 'caddy.exe',
    executableBytes: 51_867_136,
    executableSha256: '7110a0a0b4a7b87771c301542002c43303768e9f3c6215b04050e665fd3a1937',
  },
  {
    version: CADDY_VERSION,
    platform: 'linux',
    arch: 'x64',
    downloadUrl: customBuildUrl('linux', 'amd64'),
    downloadBytes: 0,
    downloadSha256: '',
    executableName: 'caddy',
    executableBytes: 0,
    executableSha256: '',
  },
  {
    version: CADDY_VERSION,
    platform: 'linux',
    arch: 'arm64',
    downloadUrl: customBuildUrl('linux', 'arm64'),
    downloadBytes: 0,
    downloadSha256: '',
    executableName: 'caddy',
    executableBytes: 0,
    executableSha256: '',
  },
] as const satisfies readonly CaddyArtifact[]

/**
 * Pinned managed-Caddy release metadata. Entries with empty digests are
 * placeholders that `supported` reports as false until real hashes are pinned
 * from a verified build of that target.
 */
export const CADDY_COMPONENT_RELEASES: Readonly<Record<string, CaddyArtifact>> = Object.freeze(
  Object.fromEntries(releases.map(release => [`${release.platform}-${release.arch}`, Object.freeze(release)])),
)

export const CADDY_COMPONENT_RELEASE = CADDY_COMPONENT_RELEASES['win32-x64'] as CaddyArtifact

/** Caddy download page shown next to the pinned artifact. */
export const CADDY_DOWNLOAD_PAGE = 'https://caddyserver.com/download'

const DNS_PROVIDERS = ['tencentcloud'] as const
export type CaddyDnsProvider = (typeof DNS_PROVIDERS)[number]

/** First-release allowlist; more providers ride new pinned builds. */
export function isCaddyDnsProvider(value: unknown): value is CaddyDnsProvider {
  return typeof value === 'string' && (DNS_PROVIDERS as readonly string[]).includes(value)
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

async function defaultFetchArtifact(
  url: string,
  signal: AbortSignal,
  expectedBytes: number,
): Promise<Uint8Array> {
  return downloadPinnedArtifact({ url, expectedBytes, errorPrefix: 'caddy', signal })
}

function lookupRelease(platform: NodeJS.Platform, arch: string): CaddyArtifact | undefined {
  return CADDY_COMPONENT_RELEASES[`${platform}-${arch}`]
}

/** Public, credential-free description of the managed Caddy component. */
export interface CaddyComponentStatus {
  readonly supported: boolean
  readonly installed: boolean
  readonly version: string
  readonly downloadBytes: number
  readonly installedBytes: number
  readonly sourceUrl: string
  readonly downloadPage: string
  readonly storagePath: string
  readonly errorCode?: string
}

interface CaddyComponentManagerOptions {
  readonly stateDirectory: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly fetchArtifact?: (url: string, signal: AbortSignal) => Promise<Uint8Array>
}

/**
 * Owns the optional managed-Caddy binary inside DSH Mobile state. The download
 * is gated on an explicit user action and verified twice: the wire bytes are
 * checked against the pinned digest, and the staged executable is rehashed
 * before it is promoted over the previous version.
 */
export class CaddyComponentManager {
  readonly executable: string
  readonly componentRoot: string
  readonly componentStorage: string
  readonly logRoot: string
  private readonly stateRoot: string
  private readonly stagingRoot: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly release: CaddyArtifact | undefined
  private readonly fetchArtifact: (url: string, signal: AbortSignal) => Promise<Uint8Array>
  private installed = false
  private errorCode: string | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(options: CaddyComponentManagerOptions) {
    const stateDirectory = resolve(options.stateDirectory)
    if (!isAbsolute(stateDirectory)) throw new Error('caddy state directory must be absolute')
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.release = lookupRelease(this.platform, this.arch)
    this.componentRoot = join(stateDirectory, 'components', 'caddy')
    this.componentStorage = join(this.componentRoot, this.release?.version ?? CADDY_VERSION)
    this.executable = join(this.componentStorage, this.release?.executableName ?? 'caddy')
    this.stateRoot = join(stateDirectory, 'state', 'caddy')
    this.logRoot = join(stateDirectory, 'logs', 'caddy')
    this.stagingRoot = join(stateDirectory, 'staging', 'caddy')
    for (const child of [this.componentRoot, this.componentStorage, this.stateRoot, this.logRoot, this.stagingRoot]) {
      if (!inside(stateDirectory, child)) throw new Error('caddy component path escaped its state directory')
    }
    const release = this.release
    this.fetchArtifact = options.fetchArtifact
      ?? ((url, signal) => defaultFetchArtifact(url, signal, release?.downloadBytes ?? 0))
  }

  /** Inspect the managed binary without touching any caddy process. */
  async initialize(): Promise<void> {
    const release = this.release
    this.errorCode = undefined
    this.installed = release !== undefined && release.executableSha256 !== ''
      && await regularFile(this.executable, release.executableBytes)
    if (this.installed && release !== undefined && await sha256(this.executable) !== release.executableSha256) {
      this.installed = false
      this.errorCode = 'caddy_component_invalid'
    }
  }

  /** Return a safe status that never includes DNS credentials. */
  status(): CaddyComponentStatus {
    const release = this.release ?? CADDY_COMPONENT_RELEASE
    return Object.freeze({
      supported: this.release !== undefined && release.executableSha256 !== '',
      installed: this.installed,
      version: release.version,
      downloadBytes: release.downloadBytes,
      installedBytes: release.executableBytes,
      sourceUrl: release.downloadUrl,
      downloadPage: CADDY_DOWNLOAD_PAGE,
      storagePath: this.componentRoot,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
    })
  }

  /** Download, verify, and install the pinned Caddy executable after explicit confirmation. */
  install(): Promise<CaddyComponentStatus> {
    return this.enqueue(async () => {
      const release = this.release
      if (release === undefined || release.executableSha256 === '') {
        throw new Error('caddy_component_unsupported')
      }
      await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 })
      const staging = await mkdtemp(join(this.stagingRoot, 'install-'))
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => { controller.abort() }, DOWNLOAD_TIMEOUT_MS)
        timeout.unref()
        let bytes: Uint8Array
        try { bytes = await this.fetchArtifact(release.downloadUrl, controller.signal) } finally { clearTimeout(timeout) }
        if (bytes.byteLength !== release.downloadBytes) throw new Error('caddy_download_size_mismatch')
        const digest = createHash('sha256').update(bytes).digest('hex')
        if (digest !== release.downloadSha256) throw new Error('caddy_download_hash_mismatch')
        // Caddy custom builds ship a bare executable, so the downloaded bytes are
        // already the install pair.
        const staged = join(staging, release.executableName)
        await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 })
        await chmod(staged, 0o700)
        if (!await regularFile(staged, release.executableBytes)
          || await sha256(staged) !== release.executableSha256) {
          throw new Error('caddy_executable_hash_mismatch')
        }
        const candidate = join(this.componentRoot, `.install-${randomBytes(12).toString('hex')}`)
        await mkdir(candidate, { recursive: true, mode: 0o700 })
        await copyFile(staged, join(candidate, release.executableName))
        await chmod(join(candidate, release.executableName), 0o700)
        await rm(this.componentStorage, { recursive: true, force: true })
        await rename(candidate, this.componentStorage)
        this.installed = true
        this.errorCode = undefined
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    })
  }

  /** Remove every managed-Caddy file owned by DSH Mobile. */
  purge(): Promise<CaddyComponentStatus> {
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

  private enqueue(operation: () => Promise<void>): Promise<CaddyComponentStatus> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task.then(() => this.status())
  }
}