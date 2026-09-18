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
 * Pinned cloudflared components fetched only after an explicit user action.
 *
 * Unlike the cpolar archive each artifact IS the executable: there is nothing
 * to unpack, so the download digest and the installed digest are the same pair.
 * `--no-autoupdate` is passed at runtime as well, so the pinned bytes stay the
 * bytes that were verified.
 */
interface CloudflaredArtifact {
  readonly version: string
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly downloadUrl: string
  readonly downloadBytes: number
  readonly downloadSha256: string
  readonly executableName: string
}

const CLOUDFLARED_VERSION = '2026.9.1'

const releases = [
  {
    version: CLOUDFLARED_VERSION,
    platform: 'win32',
    arch: 'x64',
    downloadUrl: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-windows-amd64.exe`,
    downloadBytes: 54_976_432,
    downloadSha256: '2837888cc0f5d58f15b6dc478376de90b4d3ba5241c7947455d1e0a0df429712',
    executableName: 'cloudflared.exe',
  },
  {
    version: CLOUDFLARED_VERSION,
    platform: 'linux',
    arch: 'x64',
    downloadUrl: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`,
    downloadBytes: 39_838_488,
    downloadSha256: '03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc',
    executableName: 'cloudflared',
  },
  {
    version: CLOUDFLARED_VERSION,
    platform: 'linux',
    arch: 'arm64',
    downloadUrl: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-arm64`,
    downloadBytes: 37_466_252,
    downloadSha256: '3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3',
    executableName: 'cloudflared',
  },
] as const satisfies readonly CloudflaredArtifact[]

/** Pinned official cloudflared release metadata for supported desktop targets. */
export const CLOUDFLARED_COMPONENT_RELEASES: Readonly<Record<string, CloudflaredArtifact>> = Object.freeze(Object.fromEntries(
  releases.map(release => [`${release.platform}-${release.arch}`, Object.freeze(release)]),
))

/**
 * Canonical release metadata. New code should select from
 * {@link CLOUDFLARED_COMPONENT_RELEASES} by platform and architecture; this
 * alias preserves the original Windows x64 entry for existing callers.
 */
export const CLOUDFLARED_COMPONENT_RELEASE = CLOUDFLARED_COMPONENT_RELEASES['win32-x64'] as CloudflaredArtifact

const DOWNLOAD_PAGE = 'https://github.com/cloudflare/cloudflared/releases'
const TERMS_URL = 'https://www.cloudflare.com/website-terms/'

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

async function defaultFetchArtifact(
  url: string,
  signal: AbortSignal,
  expectedBytes: number,
): Promise<Uint8Array> {
  return downloadPinnedArtifact({
    url,
    expectedBytes,
    errorPrefix: 'cloudflared',
    signal,
  })
}

/** Select the pinned artifact for one host, or undefined where unsupported. */
function lookupRelease(platform: NodeJS.Platform, arch: string): CloudflaredArtifact | undefined {
  return CLOUDFLARED_COMPONENT_RELEASES[`${platform}-${arch}`]
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
  private readonly release: CloudflaredArtifact | undefined
  private readonly fetchArtifact: (url: string, signal: AbortSignal) => Promise<Uint8Array>
  private installed = false
  private errorCode: string | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(options: CloudflaredComponentManagerOptions) {
    const stateDirectory = resolve(options.stateDirectory)
    if (!isAbsolute(stateDirectory)) throw new Error('cloudflared state directory must be absolute')
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.release = lookupRelease(this.platform, this.arch)
    this.componentRoot = join(stateDirectory, 'components', 'cloudflared')
    this.componentStorage = join(this.componentRoot, this.release?.version ?? CLOUDFLARED_VERSION)
    this.executable = join(this.componentStorage, this.release?.executableName ?? 'cloudflared')
    this.stateRoot = join(stateDirectory, 'state', 'cloudflared')
    this.logRoot = join(stateDirectory, 'logs', 'cloudflared')
    this.stagingRoot = join(stateDirectory, 'staging', 'cloudflared')
    for (const child of [this.componentRoot, this.componentStorage, this.stateRoot, this.logRoot, this.stagingRoot]) {
      if (!inside(stateDirectory, child)) throw new Error('cloudflared component path escaped its state directory')
    }
    const release = this.release
    this.fetchArtifact = options.fetchArtifact
      ?? ((url, signal) => defaultFetchArtifact(url, signal, release?.downloadBytes ?? 0))
  }

  /** Inspect the managed binary without using any global cloudflared state. */
  async initialize(): Promise<void> {
    const release = this.release
    this.installed = release !== undefined && await regularFile(this.executable, release.downloadBytes)
    if (this.installed && release !== undefined && await sha256(this.executable) !== release.downloadSha256) {
      this.installed = false
      this.errorCode = 'cloudflared_component_invalid'
    }
  }

  /** Return a safe status that never includes machine-specific account data. */
  status(): CloudflaredComponentStatus {
    // Unsupported hosts still report the canonical entry so the panel can show
    // what would be installed elsewhere; `supported` carries the actual gate.
    const release = this.release ?? CLOUDFLARED_COMPONENT_RELEASE
    return Object.freeze({
      supported: this.release !== undefined,
      installed: this.installed,
      version: release.version,
      downloadBytes: release.downloadBytes,
      installedBytes: release.downloadBytes,
      sourceUrl: release.downloadUrl,
      downloadPage: DOWNLOAD_PAGE,
      termsUrl: TERMS_URL,
      storagePath: this.componentRoot,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
    })
  }

  /** Download, verify, and install the pinned cloudflared executable after explicit confirmation. */
  install(): Promise<CloudflaredComponentStatus> {
    return this.enqueue(async () => {
      const release = this.release
      if (release === undefined) throw new Error('cloudflared_component_unsupported')
      await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 })
      const staging = await mkdtemp(join(this.stagingRoot, 'install-'))
      try {
        const controller = new AbortController()
        // The pinned artifact is tens of megabytes, so the transfer budget is
        // larger than a control handshake: a slow but working link must not
        // fail the install.
        const timeout = setTimeout(() => { controller.abort() }, 300_000)
        timeout.unref()
        let bytes: Uint8Array
        try { bytes = await this.fetchArtifact(release.downloadUrl, controller.signal) } finally { clearTimeout(timeout) }
        if (bytes.byteLength !== release.downloadBytes) {
          throw new Error('cloudflared_download_size_mismatch')
        }
        const digest = createHash('sha256').update(bytes).digest('hex')
        if (digest !== release.downloadSha256) throw new Error('cloudflared_download_hash_mismatch')
        const staged = join(staging, release.executableName)
        await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 })
        await chmod(staged, 0o700)
        if (!await regularFile(staged, release.downloadBytes)
          || await sha256(staged) !== release.downloadSha256) {
          throw new Error('cloudflared_executable_hash_mismatch')
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
