import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url)) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const client = await readFile(resolve(mobileRoot, 'lib/client.js'), 'utf8')
const prefix = '/api/mobile-access'
const remotePath = `${prefix}/remote/control`
const trustedPath = `${prefix}/lan/trusted-networks`
const modePath = `${prefix}/remote/origin/mode`
const caddyPath = `${prefix}/remote/caddy/settings`
const fixtureHtml = '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><section id="fixture-settings"></section><footer id="fixture-sidebar"></footer></body></html>'

function remoteState() {
  return {
    provider: 'origin', running: false, state: 'off', originMode: 'managed',
    providers: {
      origin: {
        component: { installed: true, supported: true },
        configuration: {
          configured: true, publicOrigin: 'https://saved-proxy.example.com:8815',
          listenHost: '127.0.0.1', listenPort: 3444, allowedCidrs: ['127.0.0.0/8'],
        },
      },
    },
    caddyConfiguration: { configured: true, publicOrigin: 'https://saved-caddy.example.com:8443', listenPort: 8443 },
    caddyState: { enabled: false, state: 'off' },
  }
}

async function waitUntil(read, accepts, description) {
  const deadline = performance.now() + 10_000
  let value
  do {
    value = await read()
    if (accepts(value)) return value
    await delay(10)
  } while (performance.now() < deadline)
  throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(value)}`)
}

// Each case owns its listener and pending HTTP responses. Only the controller
// responses are simulated; the built client creates and updates the real DOM.
async function withControl(browser, name, options, run) {
  const requests = []
  const errors = []
  const pending = new Set()
  const handlers = new Set()
  const state = {
    remote: remoteState(),
    trusted: { supported: options.supported !== false, extraAllowedCidrs: ['10.80.0.0/16'], windowsFirewall: false },
    holdTrusted: options.holdTrusted === true,
    holdMode: options.holdMode === true,
    holdNextRemote: false,
  }
  let closing = false
  let context
  const json = (response, status, body) => {
    if (response.destroyed || response.writableEnded) return
    response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(body))
  }
  const hold = (entry, response) => {
    pending.add(response)
    response.once('close', () => { pending.delete(response) })
    entry.release = (status = 200, body = state.remote) => {
      assert.equal(pending.has(response), true, `${name}: held response was already closed`)
      pending.delete(response)
      json(response, status, body)
    }
  }
  const handle = async (request, response) => {
    const pathname = new URL(request.url, 'http://fixture.invalid').pathname
    if (pathname === '/') {
      response.writeHead(200, { 'content-type': 'text/html' }); response.end(fixtureHtml)
      return
    }
    if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString())
    const entry = { method: request.method, pathname, body }
    requests.push(entry)
    if (pathname === `${prefix}/release`) { json(response, 200, {}); return }
    if (pathname === `${prefix}/lan/control`) {
      json(response, 200, { configured: true, running: true, origin: 'https://192.168.50.20:3443' })
      return
    }
    if (pathname === trustedPath) {
      if (request.method === 'GET' && state.holdTrusted) { hold(entry, response); return }
      if (request.method === 'POST') state.trusted.extraAllowedCidrs = body.extraAllowedCidrs
      json(response, 200, state.trusted)
      return
    }
    if (pathname === remotePath && request.method === 'GET') {
      if (state.holdNextRemote) { state.holdNextRemote = false; hold(entry, response); return }
      json(response, 200, state.remote)
      return
    }
    if (pathname === modePath && request.method === 'POST') {
      if (state.holdMode) { hold(entry, response); return }
      state.remote.originMode = body.mode
      json(response, 200, state.remote)
      return
    }
    if (pathname === caddyPath && request.method === 'POST') {
      state.remote.caddyConfiguration = { configured: true, ...body.settings }
      if (body.connect === true) {
        state.remote.originMode = 'managed'
        state.remote.running = true
        state.remote.state = 'ready'
        state.remote.origin = body.settings.publicOrigin
        state.remote.caddyState = { enabled: true, state: 'ready' }
      }
      json(response, 200, state.remote)
      return
    }
    if (pathname === `${prefix}/remote/provider` && request.method === 'POST') state.remote.provider = body.provider
    if (pathname.startsWith(`${prefix}/remote/`)) { json(response, 200, state.remote); return }
    errors.push(`Unexpected fixture request: ${request.method} ${pathname}`)
    json(response, 404, { error: 'fixture_route_missing' })
  }
  const server = createServer((request, response) => {
    const task = handle(request, response).catch(error => {
      if (!closing) { errors.push(String(error)); json(response, 500, { error: 'fixture_failed' }) }
    })
    handlers.add(task)
    void task.finally(() => { handlers.delete(task) })
  })
  try {
    await new Promise((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    assert(address !== null && typeof address !== 'string', `${name}: fixture has no TCP address`)
    const origin = `http://127.0.0.1:${address.port}`
    context = await browser.newContext({ viewport: { width: 1100, height: 900 }, locale: 'en-US', reducedMotion: 'reduce' })
    const page = await context.newPage()
    page.setDefaultTimeout(10_000)
    page.on('pageerror', error => { errors.push(error.message) })
    page.on('dialog', dialog => { void dialog.accept() })
    await page.route('**/*', route => {
      if (new URL(route.request().url()).origin === origin) return route.continue()
      errors.push(`Unexpected external request: ${route.request().url()}`)
      return route.abort()
    })
    await page.goto(origin)
    await page.clock.install({ time: new Date('2026-01-01T12:00:00Z') })
    await page.clock.pauseAt(new Date('2026-01-01T12:00:01Z'))
    await page.evaluate(() => {
      const createElement = (type, props, ...children) => {
        if (typeof type === 'function') return type({ ...props, children })
        if (typeof type !== 'string') throw new Error('Unexpected React element in control fixture')
        const svg = ['svg', 'rect', 'path'].includes(type)
        const node = svg ? document.createElementNS('http://www.w3.org/2000/svg', type) : document.createElement(type)
        for (const [key, value] of Object.entries(props ?? {})) {
          if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value)
          else if (value !== undefined && value !== null) node.setAttribute(key === 'className' ? 'class' : key, String(value))
        }
        for (const child of children.flat(Infinity)) if (child !== undefined && child !== null) node.append(child)
        return node
      }
      const react = { createElement, useEffect: () => { throw new Error('Unexpected React hook in sidebar fixture') }, useState: () => { throw new Error('Unexpected React hook in sidebar fixture') } }
      const cleanup = []
      window.fixtureConsumed = []
      const originalFetch = window.fetch.bind(window)
      window.fetch = async (...args) => {
        const response = await originalFetch(...args)
        const originalJson = response.json.bind(response)
        response.json = async () => {
          const value = await originalJson()
          window.fixtureConsumed.push(new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href).pathname)
          return value
        }
        return response
      }
      window.__ModuleLoader__ = { load: ({ factory }) => { window.mobileClient = factory(name => {
        if (name === 'react') return react
        throw new Error(`Unexpected client dependency: ${name}`)
      }) } }
      window.mountClient = () => { window.mobileClient.apply({
        effect: effect => { const dispose = effect(); if (typeof dispose === 'function') cleanup.push(dispose) },
        get: () => undefined,
        slots: {
          inject: (_name, install) => install(),
          register: (metadata, render) => {
            let node
            if (metadata.name === 'settings.general.item' && metadata.id === 'dsh-mobile-client-modules') {
              node = render({}); document.querySelector('#fixture-settings').append(node)
            } else if (metadata.name === 'sidebar.footer.action' && metadata.id === 'dsh-mobile') {
              node = render({ wide: true }); document.querySelector('#fixture-sidebar').append(node)
            } else throw new Error(`Unexpected control fixture slot: ${metadata.name} ${metadata.id}`)
            return () => { node.remove() }
          },
        },
      }) }
      window.disposeClient = () => { while (cleanup.length > 0) cleanup.pop()(); window.fetch = originalFetch }
    })
    await page.addScriptTag({ content: client })
    await page.evaluate(() => { window.mountClient() })
    const consumed = pathname => page.evaluate(path => window.fixtureConsumed.filter(value => value === path).length, pathname)
    const settle = async (pathname, previous) => {
      await waitUntil(() => consumed(pathname), count => count > previous, `${name}: consumed ${pathname}`)
      await page.evaluate(() => new Promise(resolveTurn => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolveTurn() }
        channel.port2.postMessage(null)
      }))
    }
    const count = (method, pathname) => requests.filter(entry => entry.method === method && entry.pathname === pathname).length
    const waitRequest = (method, pathname, previous = 0) => waitUntil(
      () => requests.filter(entry => entry.method === method && entry.pathname === pathname),
      entries => entries.length > previous, `${name}: ${method} ${pathname}`,
    ).then(entries => entries[previous])
    await waitUntil(() => page.locator('.dsh-mobile-control__provider.is-origin').getAttribute('aria-pressed'), value => value === 'true', `${name}: initial remote render`)
    assert.equal(await page.locator('#fixture-settings .dsh-module-title').textContent(), 'Mobile page modules', `${name}: missing General settings registration`)
    assert.equal(await page.locator('#fixture-settings .dsh-module-description').textContent(), 'Choose default modules for mobile access without uninstalling computer plugins.', `${name}: General settings did not use computer scope`)
    await page.locator('.dsh-mobile-control__trigger').click()
    const ui = {
      trustedSummary: page.locator('summary').filter({ hasText: /^Additional trusted networks/ }),
      trustedInput: page.getByLabel('Additional source networks', { exact: true }),
      trustedSave: page.getByRole('button', { name: 'Save networks', exact: true, includeHidden: true }),
      managed: page.locator('input[name="caddy-mode"][value="managed"]'),
      external: page.locator('input[name="caddy-mode"][value="external"]'),
      caddySave: page.getByRole('button', { name: 'Save and start Caddy', exact: true, includeHidden: true }),
      caddyDomain: page.getByLabel('Public domain', { exact: true }),
      caddyPort: page.getByLabel('Public HTTPS port', { exact: true }),
      caddySecretId: page.getByLabel('Tencent Cloud SecretId', { exact: true }),
      caddySecretKey: page.getByLabel('Tencent Cloud SecretKey', { exact: true }),
      originPublic: page.getByLabel('Public HTTPS address', { exact: true }),
      originHost: page.getByLabel('Private listen IPv4', { exact: true }),
      originPort: page.getByLabel('HTTP backend port', { exact: true }),
      originCidrs: page.getByLabel('Allowed proxy source CIDRs', { exact: true }),
    }
    const openRemote = async () => {
      const previous = await consumed(remotePath)
      await page.locator('.dsh-mobile-control__tab').nth(1).click()
      await settle(remotePath, previous)
    }
    const pollRemote = async () => {
      const previous = await consumed(remotePath)
      await page.clock.runFor(1_500)
      await settle(remotePath, previous)
    }
    await run({ page, state, ui, count, waitRequest, consumed, settle, openRemote, pollRemote })
    assert.deepEqual(errors, [], `${name}: browser or fixture errors`)
    console.log(`Control-state browser smoke passed: ${name}`)
  } finally {
    closing = true
    try {
      if (context !== undefined) {
        for (const page of context.pages()) {
          if (!page.isClosed()) await page.evaluate(() => { window.disposeClient?.() })
        }
      }
    } finally {
      try { if (context !== undefined) await context.close() } finally {
        for (const response of pending) response.destroy()
        server.closeAllConnections()
        if (server.listening) await new Promise(resolveClose => { server.close(resolveClose) })
        await Promise.allSettled(handlers)
      }
    }
  }
}

const browser = await chromium.launch({ headless: true })
let cases = 0
try {
  await withControl(browser, 'trusted networks stay disabled while pending and after failure', { holdTrusted: true }, async ({ page, state, ui, count, waitRequest, consumed, settle }) => {
    assert.equal(await ui.trustedSave.isDisabled(), true, 'Unread trusted networks allowed a save')
    assert.equal(await ui.trustedInput.isDisabled(), true, 'Unread trusted networks allowed editing')
    const before = await consumed(trustedPath)
    await ui.trustedSummary.click()
    const read = await waitRequest('GET', trustedPath)
    assert.equal(await ui.trustedSave.isDisabled(), true, 'Pending trusted GET allowed a save')
    await ui.trustedSave.evaluate(node => { node.click() })
    assert.equal(count('POST', trustedPath), 0, 'Pending trusted GET sent a write')
    read.release(503, { error: 'fixture_read_failed' })
    await settle(trustedPath, before)
    assert.equal(await ui.trustedSave.isDisabled(), true, 'Failed trusted GET allowed a save')
    assert.equal(await ui.trustedInput.isDisabled(), true, 'Failed trusted GET allowed editing')
    assert.equal(await page.getByText('Could not read this setting. Retry after reopening this section.', { exact: true }).isVisible(), true)
    await ui.trustedSave.evaluate(node => { node.click() })
    assert.equal(count('POST', trustedPath), 0, 'Failed trusted GET sent a write')
    state.holdTrusted = false
    await ui.trustedSummary.click()
    const retryBefore = await consumed(trustedPath)
    await ui.trustedSummary.click()
    await settle(trustedPath, retryBefore)
    assert.equal(await ui.trustedSave.isDisabled(), false, 'Successful supported retry did not enable saving')
    assert.equal(await ui.trustedInput.inputValue(), '10.80.0.0/16')
  })
  cases++

  await withControl(browser, 'unsupported trusted networks never allow writes', { supported: false }, async ({ page, ui, count, consumed, settle }) => {
    const before = await consumed(trustedPath)
    await ui.trustedSummary.click()
    await settle(trustedPath, before)
    assert.equal(await ui.trustedSave.isDisabled(), true)
    assert.equal(await ui.trustedInput.isDisabled(), true)
    assert.equal(await page.getByText('Available only with managed LAN setup.', { exact: true }).isVisible(), true)
    await ui.trustedSave.evaluate(node => { node.click() })
    assert.equal(count('POST', trustedPath), 0, 'Unsupported trusted networks sent a write')
  })
  cases++

  await withControl(browser, 'Caddy busy survives late snapshots and polling; failed mode change restores managed', { holdMode: true }, async ({ page, state, ui, count, waitRequest, consumed, settle, openRemote, pollRemote }) => {
    await openRemote()
    assert.equal(await ui.managed.isChecked(), true)
    assert.equal(await ui.caddySave.isDisabled(), false)
    state.holdNextRemote = true
    const priorReads = count('GET', remotePath)
    const priorConsumed = await consumed(remotePath)
    await page.clock.runFor(1_500)
    const staleRead = await waitRequest('GET', remotePath, priorReads)
    await ui.external.check()
    const mode = await waitRequest('POST', modePath)
    assert.deepEqual(mode.body, { mode: 'external' })
    const assertBusy = async () => {
      for (const [label, control] of [['managed radio', ui.managed], ['external radio', ui.external], ['Caddy save', ui.caddySave], ['Caddy domain', ui.caddyDomain]]) {
        assert.equal(await control.isDisabled(), true, `${label} unlocked during a pending Caddy action`)
      }
      assert.equal(await page.locator('.dsh-mobile-control__provider').evaluateAll(nodes => nodes.every(node => node.disabled)), true, 'Provider cards unlocked during a pending Caddy action')
    }
    await assertBusy()
    staleRead.release(200, { ...remoteState(), provider: 'tailscale' })
    await settle(remotePath, priorConsumed)
    assert.equal(await page.locator('.dsh-mobile-control__provider.is-origin').getAttribute('aria-pressed'), 'true', 'Late pre-action snapshot changed the provider')
    await assertBusy()
    const readsDuringBusy = count('GET', remotePath)
    await page.clock.runFor(1_500)
    await assertBusy()
    assert.equal(count('GET', remotePath), readsDuringBusy, 'Caddy action did not suppress periodic controller reads')
    const modeBefore = await consumed(modePath)
    const recoveryBefore = await consumed(remotePath)
    mode.release(409, { error: 'origin_mode_switch_failed' })
    await settle(modePath, modeBefore)
    await settle(remotePath, recoveryBefore)
    assert.equal(await ui.managed.isChecked(), true, 'Failed mode change retained the external preview')
    assert.equal(await ui.external.isChecked(), false)
    assert.equal(await ui.caddySave.isDisabled(), false, 'Failed action left Caddy controls locked')
    const feedback = page.locator('#dsh-mobile-origin-feedback')
    assert.equal(await feedback.isVisible(), true, 'Failed mode change hid its feedback inside the managed form')
    assert.equal(await feedback.evaluate(node => node.classList.contains('is-error')), true)
    assert.match(await feedback.textContent(), /Managed HTTPS connection was not established/u)
    await pollRemote()
    assert.equal(await ui.managed.isChecked(), true, 'Next poll restored a failed external preview')
    assert.equal(await feedback.isVisible(), true, 'Next poll erased the failed mode change message')
  })
  cases++

  await withControl(browser, 'periodic snapshots preserve dirty trusted, origin and Caddy fields', {}, async ({ page, state, ui, count, consumed, settle, openRemote, pollRemote }) => {
    const trustedBefore = await consumed(trustedPath)
    await ui.trustedSummary.click()
    await settle(trustedPath, trustedBefore)
    const trustedDraft = '11.24.0.0/24\n2001:db8:1::/64'
    await ui.trustedInput.fill(trustedDraft)
    await openRemote()
    const modeBefore = await consumed(modePath)
    const recoveryBefore = await consumed(remotePath)
    await ui.external.check()
    await settle(modePath, modeBefore)
    await settle(remotePath, recoveryBefore)
    await waitUntil(() => ui.external.isDisabled(), value => value === false, 'completed external mode change')
    const originDraft = ['https://draft-proxy.example.com:8816', '192.168.50.20', '3445', '192.168.50.10/32, 127.0.0.0/8']
    for (const [index, control] of [ui.originPublic, ui.originHost, ui.originPort, ui.originCidrs].entries()) await control.fill(originDraft[index])
    await ui.managed.check()
    const caddyDraft = ['https://draft-caddy.example.com:9443', '9443', 'fixture-secret-id', 'fixture-secret-key']
    for (const [index, control] of [ui.caddyDomain, ui.caddyPort, ui.caddySecretId, ui.caddySecretKey].entries()) await control.fill(caddyDraft[index])
    state.trusted.extraAllowedCidrs = ['10.90.0.0/16']
    Object.assign(state.remote.providers.origin.configuration, { publicOrigin: 'https://new-saved-proxy.example.com', listenHost: '10.0.0.2', listenPort: 3555, allowedCidrs: ['10.0.0.1/32'] })
    Object.assign(state.remote.caddyConfiguration, { publicOrigin: 'https://new-saved-caddy.example.com', listenPort: 8555 })
    for (let index = 0; index < 2; index++) {
      await pollRemote()
      assert.equal(await ui.trustedInput.inputValue(), trustedDraft, 'Poll overwrote dirty trusted networks')
      assert.deepEqual(await Promise.all([ui.originPublic, ui.originHost, ui.originPort, ui.originCidrs].map(control => control.inputValue())), originDraft, 'Poll overwrote dirty origin fields')
      assert.deepEqual(await Promise.all([ui.caddyDomain, ui.caddyPort, ui.caddySecretId, ui.caddySecretKey].map(control => control.inputValue())), caddyDraft, 'Poll overwrote dirty Caddy fields')
      assert.equal(await ui.managed.isChecked(), true, 'Poll overwrote the unsaved managed preview')
    }
    assert.equal(count('POST', trustedPath), 0, 'Editing trusted networks saved without an explicit action')
    assert.equal(count('POST', `${prefix}/remote/origin/configure`), 0, 'Editing origin fields saved without an explicit action')
    assert.equal(count('POST', caddyPath), 0, 'Editing Caddy fields saved without an explicit action')
  })
  cases++

  await withControl(browser, 'Caddy save and connect uses one atomic controller request', {}, async ({ ui, count, waitRequest, consumed, settle, openRemote }) => {
    await openRemote()
    await ui.caddyDomain.fill('https://atomic-caddy.example.com:9443')
    await ui.caddyPort.fill('9443')
    await ui.caddySecretId.fill('fixture-atomic-id')
    await ui.caddySecretKey.fill('fixture-atomic-key')
    const before = await consumed(caddyPath)
    await ui.caddySave.click()
    const saved = await waitRequest('POST', caddyPath)
    await settle(caddyPath, before)
    await waitUntil(() => ui.caddySave.isDisabled(), value => value === false, 'completed atomic Caddy connection')
    assert.deepEqual(saved.body, {
      settings: { version: 1, publicOrigin: 'https://atomic-caddy.example.com:9443', dnsProvider: 'tencentcloud', listenPort: 9443 },
      secretId: 'fixture-atomic-id', secretKey: 'fixture-atomic-key', connect: true,
    })
    assert.equal(count('POST', caddyPath), 1, 'Caddy connection did not use exactly one settings write')
    assert.equal(count('POST', modePath), 0, 'Caddy connection separately changed origin mode')
    assert.equal(count('POST', remotePath), 0, 'Caddy connection separately started the remote controller')
    assert.equal(await ui.managed.isChecked(), true)
    assert.equal(await ui.caddySecretId.inputValue(), '', 'Successful Caddy connection retained the submitted SecretId')
    assert.equal(await ui.caddySecretKey.inputValue(), '', 'Successful Caddy connection retained the submitted SecretKey')
  })
  cases++
  console.log(`Control-state browser smoke passed (${cases} cases; owned HTTP controller fixtures).`)
} finally { await browser.close() }
