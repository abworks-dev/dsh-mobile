import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { downloadPinnedArtifact } from './component-download.js'
import { restrictPrivateFile } from './private-file.js'

/** Pinned cpolar Windows component fetched only after an explicit user action. */
export const CPOLAR_COMPONENT_RELEASE = Object.freeze({
  version: '3.3.18',
  platform: 'win32',
  arch: 'x64',
  downloadUrl: 'https://www.cpolar.com/static/downloads/releases/3.3.18/cpolar-stable-windows-amd64-setup.zip',
  downloadBytes: 7_603_505,
  downloadSha256: 'fb8cf60289058ee26079f995d2eeea0b21768a742d90c93015afe96e83428830',
  executableBytes: 19_637_680,
  executableSha256: 'b2d865ee505e842d22ceca5493a872efa893a79b079a7a8ee2bd3aa5343a5c41',
  downloadPage: 'https://www.cpolar.com/download',
  signupUrl: 'https://dashboard.cpolar.com/signup',
  dashboardUrl: 'https://dashboard.cpolar.com/auth',
  termsUrl: 'https://www.cpolar.com/tos',
})

/** Public, credential-free description of the managed cpolar component. */
export interface CpolarComponentStatus {
  readonly supported: boolean
  readonly installed: boolean
  readonly configured: boolean
  readonly version: string
  readonly downloadBytes: number
  readonly installedBytes: number
  readonly sourceUrl: string
  readonly downloadPage: string
  readonly signupUrl: string
  readonly dashboardUrl: string
  readonly termsUrl: string
  readonly storagePath: string
  readonly errorCode?: string
}

interface CpolarComponentManagerOptions {
  readonly stateDirectory: string
  readonly platform?: NodeJS.Platform
  readonly arch?: string
  readonly fetchArtifact?: (url: string, signal: AbortSignal) => Promise<Uint8Array>
  readonly extractArtifact?: (archive: string, destination: string) => Promise<void>
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

async function run(file: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolveRun, reject) => {
    execFile(file, [...args], { windowsHide: true, timeout: 120_000 }, (error) => {
      if (error === null) resolveRun()
      else reject(error)
    })
  })
}

async function defaultFetchArtifact(url: string, signal: AbortSignal): Promise<Uint8Array> {
  return downloadPinnedArtifact({
    url,
    expectedBytes: CPOLAR_COMPONENT_RELEASE.downloadBytes,
    errorPrefix: 'cpolar',
    signal,
  })
}

async function defaultExtractArtifact(archive: string, destination: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('cpolar_component_unsupported')
  const unpacked = join(destination, 'archive')
  const administrative = join(destination, 'administrative')
  await mkdir(unpacked, { recursive: true, mode: 0o700 })
  await mkdir(administrative, { recursive: true, mode: 0o700 })
  await run('tar.exe', ['-xf', archive, '-C', unpacked])
  const archiveEntries = await readdir(unpacked, { recursive: true })
  const msiRelative = archiveEntries.find(entry => entry.toLowerCase().endsWith('.msi'))
  if (msiRelative === undefined) throw new Error('cpolar_installer_missing')
  await run('msiexec.exe', ['/a', join(unpacked, msiRelative), '/qn', `TARGETDIR=${administrative}`])
  const installedEntries = await readdir(administrative, { recursive: true })
  const executableRelative = installedEntries.find(entry => basename(entry).toLowerCase() === 'cpolar.exe')
  if (executableRelative === undefined) throw new Error('cpolar_executable_missing')
  await copyFile(join(administrative, executableRelative), join(destination, 'cpolar.exe'))
}

/** Validate a cpolar Authtoken before it crosses the durable-file boundary. */
export function validateCpolarAuthtoken(value: unknown): string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 512
    || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('cpolar_authtoken_invalid')
  }
  return value
}

/** Owns the optional cpolar binary and account configuration inside DSH Mobile state. */
export class CpolarComponentManager {
  readonly executable: string
  readonly configFile: string
  readonly componentRoot: string
  readonly componentStorage: string
  readonly stateRoot: string
  readonly logRoot: string
  private readonly stagingRoot: string
  private readonly platform: NodeJS.Platform
  private readonly arch: string
  private readonly fetchArtifact: (url: string, signal: AbortSignal) => Promise<Uint8Array>
  private readonly extractArtifact: (archive: string, destination: string) => Promise<void>
  private installed = false
  private configured = false
  private errorCode: string | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(options: CpolarComponentManagerOptions) {
    const stateDirectory = resolve(options.stateDirectory)
    if (!isAbsolute(stateDirectory)) throw new Error('cpolar state directory must be absolute')
    this.platform = options.platform ?? process.platform
    this.arch = options.arch ?? process.arch
    this.componentRoot = join(stateDirectory, 'components', 'cpolar')
    this.componentStorage = join(this.componentRoot, CPOLAR_COMPONENT_RELEASE.version)
    this.executable = join(this.componentStorage, 'cpolar.exe')
    this.stateRoot = join(stateDirectory, 'state', 'cpolar')
    this.configFile = join(this.stateRoot, 'cpolar.yml')
    this.logRoot = join(stateDirectory, 'logs', 'cpolar')
    this.stagingRoot = join(stateDirectory, 'staging', 'cpolar')
    for (const child of [this.componentRoot, this.componentStorage, this.stateRoot, this.logRoot, this.stagingRoot]) {
      if (!inside(stateDirectory, child)) throw new Error('cpolar component path escaped its state directory')
    }
    this.fetchArtifact = options.fetchArtifact ?? defaultFetchArtifact
    this.extractArtifact = options.extractArtifact ?? defaultExtractArtifact
  }

  /** Inspect the managed binary and configuration without using global cpolar state. */
  async initialize(): Promise<void> {
    this.installed = await regularFile(this.executable, CPOLAR_COMPONENT_RELEASE.executableBytes)
    if (this.installed && await sha256(this.executable) !== CPOLAR_COMPONENT_RELEASE.executableSha256) {
      this.installed = false
      this.errorCode = 'cpolar_component_invalid'
    }
    this.configured = await regularFile(this.configFile)
    if (this.configured) await restrictPrivateFile(this.configFile)
  }

  /** Return a safe status that never includes the account token. */
  status(): CpolarComponentStatus {
    return Object.freeze({
      supported: this.platform === CPOLAR_COMPONENT_RELEASE.platform && this.arch === CPOLAR_COMPONENT_RELEASE.arch,
      installed: this.installed,
      configured: this.configured,
      version: CPOLAR_COMPONENT_RELEASE.version,
      downloadBytes: CPOLAR_COMPONENT_RELEASE.downloadBytes,
      installedBytes: CPOLAR_COMPONENT_RELEASE.executableBytes,
      sourceUrl: CPOLAR_COMPONENT_RELEASE.downloadUrl,
      downloadPage: CPOLAR_COMPONENT_RELEASE.downloadPage,
      signupUrl: CPOLAR_COMPONENT_RELEASE.signupUrl,
      dashboardUrl: CPOLAR_COMPONENT_RELEASE.dashboardUrl,
      termsUrl: CPOLAR_COMPONENT_RELEASE.termsUrl,
      storagePath: this.componentRoot,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
    })
  }

  /** Download, verify, and administratively extract cpolar after explicit confirmation. */
  install(): Promise<CpolarComponentStatus> {
    return this.enqueue(async () => {
      if (this.platform !== CPOLAR_COMPONENT_RELEASE.platform || this.arch !== CPOLAR_COMPONENT_RELEASE.arch) {
        throw new Error('cpolar_component_unsupported')
      }
      await mkdir(this.stagingRoot, { recursive: true, mode: 0o700 })
      const staging = await mkdtemp(join(this.stagingRoot, 'install-'))
      try {
        const controller = new AbortController()
        const timeout = setTimeout(() => { controller.abort() }, 120_000)
        timeout.unref()
        let bytes: Uint8Array
        try { bytes = await this.fetchArtifact(CPOLAR_COMPONENT_RELEASE.downloadUrl, controller.signal) } finally { clearTimeout(timeout) }
        const digest = createHash('sha256').update(bytes).digest('hex')
        if (digest !== CPOLAR_COMPONENT_RELEASE.downloadSha256) throw new Error('cpolar_download_hash_mismatch')
        const archive = join(staging, 'cpolar.zip')
        await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 })
        await this.extractArtifact(archive, staging)
        const extracted = join(staging, 'cpolar.exe')
        if (!await regularFile(extracted, CPOLAR_COMPONENT_RELEASE.executableBytes)
          || await sha256(extracted) !== CPOLAR_COMPONENT_RELEASE.executableSha256) {
          throw new Error('cpolar_executable_hash_mismatch')
        }
        const candidate = join(this.componentRoot, `.install-${randomBytes(12).toString('hex')}`)
        await mkdir(candidate, { recursive: true, mode: 0o700 })
        await copyFile(extracted, join(candidate, 'cpolar.exe'))
        await chmod(join(candidate, 'cpolar.exe'), 0o700)
        await rm(this.componentStorage, { recursive: true, force: true })
        await rename(candidate, this.componentStorage)
        this.installed = true
        this.errorCode = undefined
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    })
  }

  /** Store only the cpolar token in a private, self-update-disabled configuration. */
  configure(authtoken: unknown): Promise<CpolarComponentStatus> {
    return this.enqueue(async () => {
      const token = validateCpolarAuthtoken(authtoken)
      await mkdir(this.stateRoot, { recursive: true, mode: 0o700 })
      const temporary = join(this.stateRoot, `.cpolar.${randomBytes(12).toString('hex')}.tmp`)
      const body = `authtoken: ${JSON.stringify(token)}\nconsole_ui: false\nupdate: false\ninspect_db_size: -1\n`
      try {
        await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        await rename(temporary, this.configFile)
        await restrictPrivateFile(this.configFile)
      } catch (error) {
        await rm(temporary, { force: true })
        throw error
      }
      this.configured = true
      this.errorCode = undefined
    })
  }

  /** Remove every cpolar file owned by DSH Mobile without touching global state. */
  purge(): Promise<CpolarComponentStatus> {
    return this.enqueue(async () => {
      await Promise.all([
        rm(this.componentRoot, { recursive: true, force: true }),
        rm(this.stateRoot, { recursive: true, force: true }),
        rm(this.logRoot, { recursive: true, force: true }),
        rm(this.stagingRoot, { recursive: true, force: true }),
      ])
      this.installed = false
      this.configured = false
      this.errorCode = undefined
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<CpolarComponentStatus> {
    const task = this.queue.then(operation, operation)
    this.queue = task.then(() => undefined, () => undefined)
    return task.then(() => this.status())
  }
}
