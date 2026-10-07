import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { restrictPrivateFile } from './private-file.js'
import { isCaddyDnsProvider, type CaddyDnsProvider } from './caddy-component.js'

/** Default public HTTPS port for the managed Caddy upstream. */
export const DEFAULT_CADDY_LISTEN_PORT = 8443
const MAX_CADDY_SETTINGS_BYTES = 8 * 1024
const MAX_CADDY_ENV_BYTES = 4 * 1024

/**
 * Settings for the managed Caddy upstream behind the origin provider.
 *
 * `publicOrigin` reuses the origin provider's own validation; the managed
 * upstream never accepts a plaintext public origin because its only job is to
 * terminate TLS in front of the private HTTP backend.
 */
export interface CaddySettings {
  readonly version: 1
  readonly publicOrigin: string
  readonly dnsProvider: CaddyDnsProvider
  readonly listenPort: number
}

/**
 * DNS API credentials. Stored in their own private file, injected into the
 * caddy process environment at spawn, and never written into the Caddyfile.
 */
export interface CaddyCredentials {
  readonly secretId: string
  readonly secretKey: string
}

/**
 * Environment variable names each supported DNS provider reads, mapped to the
 * stored credential fields.
 */
const DNS_PROVIDER_ENV: Readonly<Record<CaddyDnsProvider, readonly [string, string]>> = Object.freeze({
  tencentcloud: ['TENCENTCLOUD_SECRET_ID', 'TENCENTCLOUD_SECRET_KEY'],
})

/** Environment variables for one provider, ready to merge into a spawn env. */
export function caddyCredentialEnvironment(
  provider: CaddyDnsProvider,
  credentials: CaddyCredentials,
): Record<string, string> {
  const [idName, keyName] = DNS_PROVIDER_ENV[provider]
  return { [idName]: credentials.secretId, [keyName]: credentials.secretKey }
}

/**
 * Render the managed Caddyfile. The template bakes in the three behaviors the
 * origin backend requires or that field experience showed break the link when
 * missing: the host header must keep the public port (the backend validates
 * the exact host:port), upstream keep-alive must be off (the Node backend
 * closes idle connections well before Caddy's pool would reuse them, which
 * surfaces as intermittent 502s), and automatic redirects must be disabled
 * because home networks commonly cannot serve port 80. DNS credentials ride in
 * through the environment only.
 */
export function renderCaddyfile(settings: CaddySettings, stateDirectory: string): string {
  const dataDir = join(resolve(stateDirectory), 'caddy', 'data').replaceAll('\\', '/')
  const origin = new URL(settings.publicOrigin)
  const port = origin.port === '' ? '' : `:${origin.port}`
  return [
    '{',
    '\tauto_https disable_redirects',
    `\tstorage file_system "${dataDir}"`,
    '',
    '\tlog {',
    `\t\toutput file "${dataDir}/caddy.log"`,
    '\t\tlevel INFO',
    '\t}',
    '}',
    '',
    `https://${origin.hostname}${port} {`,
    '\ttls {',
    `\t\tdns ${settings.dnsProvider} {`,
    `\t\t\t${DNS_PROVIDER_ENV[settings.dnsProvider][0].toLowerCase()} {env.${DNS_PROVIDER_ENV[settings.dnsProvider][0]}}`,
    `\t\t\t${DNS_PROVIDER_ENV[settings.dnsProvider][1].toLowerCase()} {env.${DNS_PROVIDER_ENV[settings.dnsProvider][1]}}`,
    '\t\t}',
    '\t}',
    '',
    '\treverse_proxy 127.0.0.1:3444 {',
    '\t\theader_up Host {http.request.hostport}',
    '\t\theader_up X-Real-IP {remote_host}',
    '\t\ttransport http {',
    '\t\t\tkeepalive off',
    '\t\t\tdial_timeout 5s',
    '\t\t\tresponse_header_timeout 300s',
    '\t\t}',
    '\t}',
    '}',
    '',
  ].join('\n')
}

async function atomicPrivateWrite(file: string, body: string): Promise<void> {
  const directory = dirname(file)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  try {
    const current = await lstat(file)
    if (!current.isFile() || current.isSymbolicLink()) throw new Error('caddy_config_target_invalid')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = join(directory, '.' + basename(file) + '.' + randomBytes(12).toString('hex') + '.tmp')
  try {
    await writeFile(temporary, body, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    await rename(temporary, file)
    await restrictPrivateFile(file)
  } catch (error) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** Validate a public origin for the managed upstream by reusing the origin rules. */
function validateCaddyPublicOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 512 || /[\s\u0000-\u001f\u007f\\@?#]/u.test(value)) {
    throw new Error('caddy_public_origin_invalid')
  }
  let url: URL
  try { url = new URL(value) } catch { throw new Error('caddy_public_origin_invalid') }
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '') throw new Error('caddy_public_origin_invalid')
  return url.origin
}

function validateCaddyListenPort(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1024 || Number(value) > 65_535) {
    throw new Error('caddy_listen_port_invalid')
  }
  // 3444 belongs to the origin backend itself and 3443/3080 to the LAN gateway
  // and DSH WebServer; the managed upstream must not take any of them.
  if (value === 3444 || value === 3443 || value === 3080) throw new Error('caddy_listen_port_reserved')
  return Number(value)
}

/** Validate both saved settings and local administrative requests. */
export function parseCaddySettings(value: unknown): CaddySettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('caddy_settings_invalid')
  const record = value as Record<string, unknown>
  if (Reflect.ownKeys(record).some(key => !['version', 'publicOrigin', 'dnsProvider', 'listenPort'].includes(String(key)))
    || (record.version !== undefined && record.version !== 1)) throw new Error('caddy_settings_invalid')
  if (!isCaddyDnsProvider(record.dnsProvider)) throw new Error('caddy_dns_provider_invalid')
  return Object.freeze({
    version: 1,
    publicOrigin: validateCaddyPublicOrigin(record.publicOrigin),
    dnsProvider: record.dnsProvider,
    listenPort: validateCaddyListenPort(record.listenPort === undefined ? DEFAULT_CADDY_LISTEN_PORT : record.listenPort),
  })
}

function parseCredentials(value: unknown): CaddyCredentials {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('caddy_credentials_invalid')
  const record = value as Record<string, unknown>
  for (const key of ['secretId', 'secretKey']) {
    const entry = record[key]
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 512 || /\s/u.test(entry)) {
      throw new Error('caddy_credentials_invalid')
    }
  }
  return Object.freeze({ secretId: record.secretId as string, secretKey: record.secretKey as string })
}

/** Owns the generated Caddyfile and the DNS credential file. */
export class CaddyConfigStore {
  readonly settingsFile: string
  readonly envFile: string
  readonly caddyfile: string
  private settingsValue: CaddySettings | undefined
  private credentialsValue: CaddyCredentials | undefined
  private errorCodeValue: string | undefined

  constructor(stateDirectory: string) {
    if (!isAbsolute(stateDirectory)) throw new Error('caddy config state directory must be absolute')
    const root = resolve(stateDirectory, 'caddy')
    this.settingsFile = join(root, 'settings.json')
    this.envFile = join(root, 'env.json')
    this.caddyfile = join(root, 'Caddyfile')
  }

  settings(): CaddySettings | undefined { return this.settingsValue }
  credentials(): CaddyCredentials | undefined { return this.credentialsValue }
  errorCode(): string | undefined { return this.errorCodeValue }

  async initialize(): Promise<void> {
    this.settingsValue = undefined
    this.credentialsValue = undefined
    this.errorCodeValue = undefined
    await this.loadOne(this.settingsFile, raw => {
      this.settingsValue = parseCaddySettings(JSON.parse(raw) as unknown)
    })
    await this.loadOne(this.envFile, raw => {
      this.credentialsValue = parseCredentials(JSON.parse(raw) as unknown)
    })
  }

  private async loadOne(file: string, assign: (raw: string) => void): Promise<void> {
    let entry
    try { entry = await lstat(file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (!entry.isFile() || entry.isSymbolicLink() || entry.size > MAX_CADDY_SETTINGS_BYTES) {
      this.errorCodeValue = 'caddy_config_invalid'
      return
    }
    await restrictPrivateFile(file)
    try { assign(await readFile(file, 'utf8')) } catch { this.errorCodeValue = 'caddy_config_invalid' }
  }

  /** Persist settings and rewrite the Caddyfile from the template. */
  async configure(value: unknown, stateDirectory: string): Promise<void> {
    const settings = parseCaddySettings(value)
    await atomicPrivateWrite(this.settingsFile, JSON.stringify(settings) + '\n')
    this.settingsValue = settings
    this.errorCodeValue = undefined
    await atomicPrivateWrite(this.caddyfile, renderCaddyfile(settings, stateDirectory))
  }

  /** Persist or replace the DNS credentials. */
  async configureCredentials(value: unknown): Promise<void> {
    const credentials = parseCredentials(value)
    await atomicPrivateWrite(this.envFile, JSON.stringify(credentials) + '\n')
    this.credentialsValue = credentials
  }

  async purge(): Promise<void> {
    await Promise.all([
      rm(this.settingsFile, { force: true }),
      rm(this.envFile, { force: true }),
      rm(this.caddyfile, { force: true }),
    ])
    this.settingsValue = undefined
    this.credentialsValue = undefined
    this.errorCodeValue = undefined
  }
}