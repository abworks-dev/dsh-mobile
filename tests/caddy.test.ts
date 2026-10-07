import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CADDY_COMPONENT_RELEASE, CaddyComponentManager, isCaddyDnsProvider } from '../src/caddy-component.js'
import { CaddyConfigStore, caddyCredentialEnvironment, parseCaddySettings, renderCaddyfile } from '../src/caddy-config.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempState(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-mobile-caddy-')).then(directory => {
    cleanups.push(() => rm(directory, { recursive: true, force: true }))
    return directory
  })
}

describe('managed Caddy settings', () => {
  it('accepts a valid managed-caddy settings row and rejects reserved ports', () => {
    const settings = parseCaddySettings({
      version: 1,
      publicOrigin: 'https://phone.example.com:8443',
      dnsProvider: 'tencentcloud',
      listenPort: 8443,
    })
    expect(settings.publicOrigin).toBe('https://phone.example.com:8443')
    expect(() => parseCaddySettings({
      version: 1, publicOrigin: 'https://phone.example.com:8443',
      dnsProvider: 'tencentcloud', listenPort: 3444,
    })).toThrow('caddy_listen_port_reserved')
    expect(() => parseCaddySettings({
      version: 1, publicOrigin: 'http://phone.example.com:8443',
      dnsProvider: 'tencentcloud', listenPort: 8443,
    })).toThrow('caddy_public_origin_invalid')
    expect(isCaddyDnsProvider('tencentcloud')).toBe(true)
    expect(isCaddyDnsProvider('cloudflare')).toBe(false)
  })

  it('renders the template with hostport header, keepalive off, and env placeholders — never credentials', () => {
    const settings = parseCaddySettings({
      version: 1,
      publicOrigin: 'https://phone.example.com:8443',
      dnsProvider: 'tencentcloud',
      listenPort: 8443,
    })
    const caddyfile = renderCaddyfile(settings, '/state')
    expect(caddyfile).toContain('header_up Host {http.request.hostport}')
    expect(caddyfile).toContain('keepalive off')
    expect(caddyfile).toContain('auto_https disable_redirects')
    expect(caddyfile).toContain('https://phone.example.com:8443 {')
    expect(caddyfile).toContain('{env.TENCENTCLOUD_SECRET_ID}')
    expect(caddyfile).not.toContain('secretValue')
    expect(caddyfile).toContain('/state/caddy/data')
  })

  it('maps provider credentials to environment variable names', () => {
    const env = caddyCredentialEnvironment('tencentcloud', { secretId: 'id', secretKey: 'key' })
    expect(env).toEqual({ TENCENTCLOUD_SECRET_ID: 'id', TENCENTCLOUD_SECRET_KEY: 'key' })
  })

  it('persists settings, rewrites the Caddyfile, and keeps credentials out of it', async () => {
    const state = await tempState()
    const store = new CaddyConfigStore(state)
    await store.initialize()
    await store.configure({
      version: 1,
      publicOrigin: 'https://phone.example.com:8443',
      dnsProvider: 'tencentcloud',
      listenPort: 8443,
    }, state)
    await store.configureCredentials({ secretId: 'id-value', secretKey: 'key-value' })
    expect(store.settings()?.publicOrigin).toBe('https://phone.example.com:8443')
    const caddyfile = await readFile(store.caddyfile, 'utf8')
    expect(caddyfile).toContain('{env.TENCENTCLOUD_SECRET_ID}')
    expect(caddyfile).not.toContain('id-value')
    const env = JSON.parse(await readFile(store.envFile, 'utf8')) as { secretId: string }
    expect(env.secretId).toBe('id-value')
    await store.purge()
    expect(store.settings()).toBeUndefined()
    await expect(stat(store.caddyfile)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('managed Caddy component manager', () => {
  it('reports the pinned windows release and refuses installation on targets without pinned hashes', async () => {
    const state = await tempState()
    const manager = new CaddyComponentManager({ stateDirectory: state })
    expect(CADDY_COMPONENT_RELEASE.version).toBe('2.11.6')
    await manager.initialize()
    expect(manager.status().supported).toBe(true)
    expect(manager.status().installed).toBe(false)
    const otherState = await tempState()
    const other = new CaddyComponentManager({ stateDirectory: otherState, platform: 'darwin', arch: 'x64' })
    await other.initialize()
    expect(other.status().supported).toBe(false)
  })

  it('rejects a download whose digest does not match the pinned artifact', async () => {
    const state = await tempState()
    const manager = new CaddyComponentManager({
      stateDirectory: state,
      fetchArtifact: async () => new TextEncoder().encode('not caddy'),
    })
    await manager.initialize()
    await expect(manager.install()).rejects.toThrow('caddy_download_size_mismatch')
    expect(manager.status().installed).toBe(false)
  })
})