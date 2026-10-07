import { spawn } from 'node:child_process'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import { request } from 'node:https'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import WebSocket, { WebSocketServer } from 'ws'
import { afterEach, expect, it, vi } from 'vitest'
import { execFileText } from '../src/exec-file.js'
import { CaddyConfigStore, parseCaddySettings, renderCaddyfile } from '../src/caddy-config.js'
import { caddyProcessEnvironment } from '../src/caddy.js'
import { parseGatewayConfig } from '../src/config.js'
import { MobileAccessGateway } from '../src/gateway.js'
import { MemoryDeviceStore } from '../src/storage.js'
import { remoteGatewayConfig } from '../src/plugin.js'
import { terminateRemoteProcess } from '../src/remote.js'
import { SESSION_COOKIE } from '../src/http-security.js'

const executable = process.env.DSH_CADDY_TEST_EXECUTABLE
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

/** Observe only the spawned Caddy process's atomically allocated TCP listener. */
async function ownedPort(pid: number): Promise<number> {
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot
    if (systemRoot === undefined) throw new Error('Windows system root missing')
    const output = await execFileText(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-NetTCPConnection -State Listen -OwningProcess ${String(pid)} -ErrorAction SilentlyContinue | Where-Object LocalAddress -eq '127.0.0.1' | Select-Object -ExpandProperty LocalPort) -join ','`], { timeout: 10_000 })
    const ports = output.stdout.trim().split(',').filter(Boolean).map(Number)
    if (ports.length !== 1 || !Number.isInteger(ports[0])) throw new Error('Owned Caddy listener is not ready')
    return ports[0]!
  }
  const output = await execFileText('ss', ['-ltnp'], { timeout: 10_000 })
  const line = output.stdout.split(/\r?\n/u).find(value => value.includes('pid=' + String(pid) + ',') && value.includes('127.0.0.1:'))
  const port = Number(line?.match(/127\.0\.0\.1:(\d+)/u)?.[1])
  if (!Number.isInteger(port) || port < 1) throw new Error('Owned Caddy listener is not ready')
  return port
}

function exchange(port: number, ca: string, path: string, method = 'GET', headers: Record<string, string> = {}, body = ''): Promise<{ status: number; headers: IncomingHttpHeaders; body: string; rawBody: Buffer }> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ host: '127.0.0.1', port, servername: 'phone.example.com', ca, agent: false, method, path,
      headers: { host: 'phone.example.com', origin: 'https://phone.example.com', 'sec-fetch-site': 'same-origin', ...headers },
    }, incoming => {
      const chunks: Buffer[] = []
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
      incoming.once('end', () => { const rawBody = Buffer.concat(chunks); resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: rawBody.toString(), rawBody }) })
      incoming.once('error', reject)
    })
    outgoing.setTimeout(10_000, () => outgoing.destroy(new Error('TLS request timeout')))
    outgoing.once('error', reject); outgoing.end(body)
  })
}

it.runIf(executable !== undefined)('runs the built Caddy template through trusted TLS, authenticated pairing, API bytes and WSS with ephemeral owned listeners', async () => {
  if (executable === undefined) throw new Error('Explicit test executable required')
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-caddy-live-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const upstream = createServer((incoming, outgoing) => {
    if (incoming.url === '/api/caddy-test-resource') { outgoing.writeHead(200, { 'content-type': 'application/octet-stream' }); outgoing.end(Buffer.from([0, 1, 2, 250])); return }
    outgoing.writeHead(404); outgoing.end()
  })
  const webSockets = new WebSocketServer({ noServer: true })
  const peers = new Set<WebSocket>()
  webSockets.on('connection', peer => { peers.add(peer); peer.on('message', data => peer.send(data)); peer.on('close', () => peers.delete(peer)) })
  upstream.on('upgrade', (incoming, socket, head) => { webSockets.handleUpgrade(incoming, socket, head, peer => webSockets.emit('connection', peer, incoming)) })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { for (const peer of peers) peer.terminate(); await new Promise<void>(resolve => webSockets.close(() => resolve())); await new Promise<void>(resolve => upstream.close(() => resolve())) })
  const upstreamAddress = upstream.address(); if (upstreamAddress === null || typeof upstreamAddress === 'string') throw new Error('missing port')
  const template = parseGatewayConfig({ listenHost: '127.0.0.1', listenPort: 0, tls: { mode: 'disabled' },
    stateFile: join(root, 'devices.json'), upstreamOrigin: 'http://127.0.0.1:' + String(upstreamAddress.port),
    publicAuthorities: ['127.0.0.1'], allowedCidrs: ['127.0.0.0/8'],
  })
  const gateway = new MobileAccessGateway(remoteGatewayConfig(template, 'https://phone.example.com', template.stateFile, 'a'.repeat(64)), new MemoryDeviceStore())
  await gateway.start(); cleanups.push(() => gateway.close())
  const settings = parseCaddySettings({ publicOrigin: 'https://phone.example.com', dnsProvider: 'tencentcloud', listenPort: 8443 })
  const config = new CaddyConfigStore(root); await config.configure(settings, { secretId: 'fake-id', secretKey: 'fake-key' }); await config.prepareCaddyfile(gateway.address().port)
  const environment = caddyProcessEnvironment(config, settings)
  // Validate the actual DNS-01 template without contacting DNS or acquiring a production certificate.
  await execFileText(executable, ['adapt', '--config', config.caddyfile, '--adapter', 'caddyfile'], { env: environment, timeout: 15_000 })
  const internal = renderCaddyfile(settings, root, gateway.address().port)
    .replace('{\n', '{\n\tskip_install_trust\n\tservers {\n\t\tprotocols h1\n\t}\n')
    .replace('https://phone.example.com:8443 {', 'https://phone.example.com:0 {\n\tbind 127.0.0.1')
    .replace(/\ttls \{\n\t\tdns tencentcloud \{[\s\S]*?\n\t\t\}\n\t\}/u, '\ttls internal')
  const testConfig = join(config.rootDirectory, 'Caddyfile.internal-test')
  await writeFile(testConfig, internal, { mode: 0o600 })
  const child = spawn(executable, ['run', '--config', testConfig, '--adapter', 'caddyfile'], { env: environment, shell: false, windowsHide: true, stdio: 'pipe' })
  child.stdout.resume(); child.stderr.resume(); child.stdin.end()
  cleanups.push(() => terminateRemoteProcess(child))
  await once(child, 'spawn')
  if (child.pid === undefined) throw new Error('Missing child PID')
  let port = 0
  await vi.waitFor(async () => { port = await ownedPort(child.pid!) }, { timeout: 20_000, interval: 100 })
  let ca = ''
  await vi.waitFor(async () => { ca = await readFile(join(config.dataDirectory, 'pki', 'authorities', 'local', 'root.crt'), 'utf8') }, { timeout: 10_000 })
  const discovery = await exchange(port, ca, '/mobile-access/discovery')
  expect(discovery.status).toBe(200); expect(JSON.parse(discovery.body).instanceId).toBe(gateway.config.instanceId)
  expect((await exchange(port, ca, '/api/caddy-test-resource')).status).toBe(401)
  const pairing = await gateway.access.openPairing()
  const paired = await exchange(port, ca, '/mobile-access/auth/pair', 'POST', { 'content-type': 'application/json' }, JSON.stringify({ token: pairing.token, label: 'Isolated Caddy test' }))
  expect(paired.status).toBe(201)
  const cookie = paired.headers['set-cookie']?.find(value => value.startsWith(SESSION_COOKIE + '='))?.split(';')[0]
  expect(cookie).toBeDefined()
  const resource = await exchange(port, ca, '/api/caddy-test-resource', 'GET', { cookie: cookie! })
  expect(resource.status).toBe(200); expect(resource.rawBody).toEqual(Buffer.from([0, 1, 2, 250]))
  const socketOptions: WebSocket.ClientOptions & { servername: string } = { ca, servername: 'phone.example.com',
    headers: { host: 'phone.example.com', origin: 'https://phone.example.com', cookie: cookie! },
  }
  const socket = new WebSocket('wss://127.0.0.1:' + String(port) + '/api/events.mux', socketOptions)
  cleanups.push(async () => { if (socket.readyState !== WebSocket.CLOSED) { const closed = once(socket, 'close'); socket.terminate(); await closed } })
  await once(socket, 'open')
  const received = once(socket, 'message'); socket.send('CADDY_WSS_ROUNDTRIP')
  const [echo] = await received; expect(String(echo)).toBe('CADDY_WSS_ROUNDTRIP')
}, 45_000)
