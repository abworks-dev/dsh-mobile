import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const repository = fileURLToPath(new URL('..', import.meta.url))
const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? repository
  : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const dshBin = process.env.DSH_BOOT_SMOKE_BIN
  ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const injectedFailure = process.argv.includes('--negative-control')
const blockedRemoteMux = process.argv.includes('--negative-control-mux')
const excludedClientModules = process.env.DSH_BOOT_SMOKE_EXCLUDED_MODULES?.split(',').map(id => id.trim()).filter(Boolean) ?? []
const startedAt = Date.now()
const START_TIMEOUT_MS = 90_000
const CLIENT_TIMEOUT_MS = 60_000

async function removeTemporaryRoot(root) {
  const absolute = resolve(root)
  if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('dsh-mobile-boot-smoke-')) {
    throw new Error('Refusing to remove a directory outside this smoke test temporary root')
  }
  const rootMetadata = await lstat(absolute)
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('Refusing to remove a replaced or linked smoke test root')
  }
  const unlinkNestedLinks = async directory => {
    for (const entry of await readdir(directory)) {
      const path = join(directory, entry)
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) await unlink(path)
      else if (metadata.isDirectory()) await unlinkNestedLinks(path)
    }
  }
  // DSH may project package links, and this test itself creates a junction to
  // the source checkout. Never let recursive removal encounter any link.
  await unlinkNestedLinks(absolute)
  await rm(absolute, { recursive: true, force: true })
}

function sanitized(output) {
  return output
    .replace(/([?&]token=)[^\s&]+/gu, '$1<redacted>')
    .replace(/(#key=)[^\s]+/gu, '$1<redacted>')
    .slice(-12_000)
}

function observeWorkspaceStream(page) {
  const state = { sockets: 0, closed: 0, sentOpens: [], receivedFrames: 0, socketErrors: [] }
  let resolveBaseline
  const baseline = new Promise(resolve => { resolveBaseline = resolve })
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/api/remote.mux') return
    state.sockets++
    const streams = new Map()
    socket.on('framesent', frame => {
      let message
      try { message = JSON.parse(String(frame.payload)) } catch { return }
      if (message?.type !== 'open' || typeof message.streamId !== 'string' || typeof message.endpoint !== 'string') return
      streams.set(message.streamId, message.endpoint)
      if (state.sentOpens.length < 12) state.sentOpens.push(message.endpoint)
    })
    socket.on('framereceived', frame => {
      state.receivedFrames++
      let message
      try { message = JSON.parse(String(frame.payload)) } catch { return }
      if (message?.type !== 'item' || streams.get(message.streamId) !== 'workspace/follow') return
      const value = message.value
      if (value?.type !== 'baseline' || !Array.isArray(value.value?.items)
        || !Array.isArray(value.value.archivedSessionIds) || !Array.isArray(value.value.pinnedSessionIds)) return
      resolveBaseline({ workspaces: value.value.items.length, socket })
    })
    socket.on('socketerror', error => { if (state.socketErrors.length < 8) state.socketErrors.push(String(error)) })
    socket.on('close', () => { state.closed++ })
  })
  return { baseline, state }
}

async function within(promise, timeoutMs, failure) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(failure())), timeoutMs) }),
    ])
  } finally { clearTimeout(timer) }
}

async function createProfile(root) {
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'web')
  const mobileState = join(home, 'mobile-access')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await mkdir(mobileState, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'dsh-mobile': `file:${mobileRoot}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-mobile'] } },
  }, null, 2) + '\n')
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{
    id: 'mobile-access',
    config: {
      setupFile: join(mobileState, 'setup.json'),
      stateFile: join(mobileState, 'devices.json'),
      controlFile: join(mobileState, 'control.json'),
      customCssFile: join(mobileState, 'mobile.css'),
      customScriptFile: join(mobileState, 'mobile.js'),
      initiallyEnabled: true,
      ...(excludedClientModules.length > 0 ? { excludedClientModules } : {}),
      listenHost: '127.0.0.1',
      listenPort: 0,
      allowedCidrs: ['127.0.0.0/8'],
      tls: { mode: 'disabled' },
    },
  }]) + '\n')
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  await symlink(mobileRoot, join(profile, 'node_modules', 'dsh-mobile'), process.platform === 'win32' ? 'junction' : 'dir')
  await writeFile(join(mobileState, 'setup.json'), JSON.stringify({
    version: 1,
    listenHost: '127.0.0.1',
    listenPort: 0,
    allowedCidrs: ['127.0.0.0/8'],
    tls: { mode: 'disabled' },
  }) + '\n')
  return home
}

function launchDsh(root, home) {
  const environment = {}
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME',
    'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  const child = spawn(process.execPath, [dshBin, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: root,
    env: {
      ...environment,
      DSH_HOME: home,
      DSH_AGENTS_HOME: join(root, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      DEEPSEEK_API_KEY: '',
      HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
      http_proxy: '', https_proxy: '', all_proxy: '',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
      NODE_OPTIONS: '', NODE_PATH: '', TSX_TSCONFIG_PATH: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  let exited = false
  let exitResult
  const exit = new Promise(resolve => { exitResult = resolve })
  child.once('error', error => { stderr += `\n${String(error)}` })
  child.once('close', (code, signal) => {
    exited = true
    exitResult({ code, signal })
  })
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-24_000) })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-24_000) })
  const ready = async () => {
    const deadline = Date.now() + START_TIMEOUT_MS
    while (Date.now() < deadline) {
      const url = /dsh web: (http:\/\/[^\s]+)/u.exec(stdout)?.[1]
      if (url !== undefined) return url
      if (exited) throw new Error(`DSH exited before readiness\n${sanitized(stdout)}\n${sanitized(stderr)}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error(`DSH did not start in ${START_TIMEOUT_MS} ms\n${sanitized(stdout)}\n${sanitized(stderr)}`)
  }
  const close = async () => {
    if (exited) return { ...(await exit), forced: false }
    child.kill('SIGTERM')
    let forced = false
    const watchdog = setTimeout(() => {
      if (exited) return
      forced = true
      child.kill('SIGKILL')
    }, 12_000)
    try { return { ...(await exit), forced } } finally { clearTimeout(watchdog) }
  }
  return { ready, close, logs: () => sanitized(`${stdout}\n${stderr}`) }
}

async function inspectBrowser(baseUrl, logs) {
  const browser = await chromium.launch({ headless: true })
  try {
    const desktop = await browser.newPage()
    await desktop.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    const stockBatches = await desktop.evaluate(() => window.__DSH_BOOT__?.batches ?? [])
    const control = await desktop.evaluate(async () => {
      const response = await fetch('/api/mobile-access/lan/control')
      const text = await response.text()
      let body
      try { body = JSON.parse(text) } catch { body = undefined }
      return { status: response.status, body }
    })
    if (control.status !== 200 || control.body?.running !== true || typeof control.body?.origin !== 'string') {
      throw new Error(`Mobile plugin did not start through DSH Loader: status=${control.status} json=${String(control.body !== undefined)}\n${logs()}`)
    }
    const pairing = await desktop.evaluate(async () => {
      const response = await fetch('/api/mobile-access/pairing/open', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      const text = await response.text()
      let body
      try { body = JSON.parse(text) } catch { body = undefined }
      return { status: response.status, body }
    })
    if (pairing.status !== 201 || typeof pairing.body?.pairUrl !== 'string') {
      throw new Error(`Pairing could not open: status=${pairing.status} json=${String(pairing.body !== undefined)}\n${logs()}`)
    }

    // Back-layer assertions depend on open state, not on drawer animation timing.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
    const workspaceStream = observeWorkspaceStream(phone)
    const errors = []
    const failedBundles = []
    const failedRequests = []
    const responses = []
    let injected = false
    phone.on('pageerror', error => { errors.push(error.message) })
    phone.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    phone.on('requestfailed', request => {
      failedRequests.push({ path: new URL(request.url()).pathname, type: request.resourceType(), failure: request.failure()?.errorText })
    })
    phone.on('response', response => {
      const url = new URL(response.url())
      responses.push({ path: `${url.pathname}${url.search}`, status: response.status(), type: response.request().resourceType(), contentType: response.headers()['content-type'] })
      if (response.status() >= 400 && /\/mobile-access\/mobile-boot\/|\/plugins\//u.test(response.url())) {
        failedBundles.push(`${response.status()} ${new URL(response.url()).pathname}`)
      }
    })
    if (injectedFailure) {
      await phone.route('**/*', async route => {
        if (new URL(route.request().url()).pathname === '/plugins/' && route.request().resourceType() === 'script') {
          injected = true
          await route.fulfill({ status: 200, contentType: 'text/javascript', body: 'import "node:net";\n' })
        } else await route.continue()
      })
    }
    if (blockedRemoteMux) {
      await phone.routeWebSocket('**/api/remote.mux', socket => { socket.close() })
    }
    await phone.goto(pairing.body.pairUrl, { waitUntil: 'domcontentloaded' })
    await phone.locator('#pair-form button').click()
    await phone.waitForURL(url => url.pathname === '/', { timeout: 15_000 })
    try {
      const result = await phone.waitForFunction(() => {
        const root = document.querySelector('#root')
        const boot = document.querySelector('[data-dsh-boot]')
        if (boot?.textContent?.includes('Failed to load plugins')) return 'failed'
        if (root !== null && boot === null && root.querySelector('.dshm-shell') !== null) return 'mounted'
        return false
      }, undefined, { timeout: CLIENT_TIMEOUT_MS })
      if (await result.jsonValue() !== 'mounted') throw new Error('DSH client reported failed plugin imports')
    } catch (error) {
      const boot = await phone.locator('[data-dsh-boot]').allTextContents()
      const root = await phone.locator('#root').evaluate(element => ({ text: element.textContent?.slice(0, 500), html: element.innerHTML.slice(0, 500) })).catch(() => undefined)
      throw new Error(`Mobile client did not mount after pairing: ${String(error)}\nurl=${new URL(phone.url()).pathname}\nboot=${sanitized(JSON.stringify(boot))}\nroot=${sanitized(JSON.stringify(root))}\nerrors=${sanitized(JSON.stringify(errors))}\nfailedBundles=${sanitized(JSON.stringify(failedBundles))}\nfailedRequests=${sanitized(JSON.stringify(failedRequests))}\nresponses=${sanitized(JSON.stringify(responses))}\n${logs()}`)
    }
    const workspace = await within(
      workspaceStream.baseline,
      blockedRemoteMux ? 10_000 : CLIENT_TIMEOUT_MS,
      () => `DSH Workspace stream did not receive an opening baseline over /api/remote.mux: ${sanitized(JSON.stringify(workspaceStream.state))}\nerrors=${sanitized(JSON.stringify(errors))}\n${logs()}`,
    )
    if (workspace.socket.isClosed()) {
      throw new Error(`DSH Workspace stream closed after its opening baseline: ${sanitized(JSON.stringify(workspaceStream.state))}\n${logs()}`)
    }
    const bootFailures = await phone.getByText('Failed to load plugins').count()
    if (bootFailures > 0 || failedBundles.length > 0 || errors.some(error => /Failed to load plugins|failed to import|node:net|ERR_UNSUPPORTED/u.test(error))) {
      throw new Error(`Mobile client import failed: errors=${sanitized(JSON.stringify(errors))} bundles=${sanitized(JSON.stringify(failedBundles))}\n${logs()}`)
    }
    const plan = await phone.evaluate(() => window.__DSH_BOOT__)
    if (injectedFailure && !injected) throw new Error('Negative control did not intercept any DSH client script')
    if (!Array.isArray(plan?.entries) || !plan.entries.some(row => row.id === 'dsh-mobile')) {
      throw new Error(`Real DSH boot manifest did not contain dsh-mobile: entries=${sanitized(JSON.stringify(plan?.entries?.map(row => row.id) ?? []))}`)
    }
    if (!excludedClientModules.includes('dsh-mobile-question-fixes')) {
      if (!plan.entries.some(row => row.id === 'dsh-mobile-question-fixes')
        || await phone.locator('style[data-plugin="dsh-mobile-question-fixes"]').count() !== 1) {
        throw new Error('Bundled question-card component did not activate exactly once')
      }
    }
    if (excludedClientModules.length > 0) {
      for (const id of excludedClientModules) {
        if (!stockBatches.some(batch => batch.entries.includes(id))) throw new Error(`Selected module ${id} is absent from the stock DSH graph`)
        if (plan.entries.some(row => row.id === id)) throw new Error(`Selected module ${id} remains in the mobile graph`)
      }
    }
    const oldAffected = stockBatches.filter(batch => batch.phase === 'application'
      && batch.entries.some(id => id === '@deepseek-ai/dsh-client-ui-layout' || excludedClientModules.includes(id)))
    const downloadedScripts = new Set(responses.filter(item => item.type === 'script').map(item => item.path))
    for (const batch of oldAffected) {
      const url = new URL(batch.url, baseUrl)
      if (downloadedScripts.has(`${url.pathname}${url.search}`)) {
        throw new Error(`Stock application batch was still downloaded: ${batch.url}`)
      }
    }
    if (excludedClientModules.length > 0) {
      console.log(`Optional exclusion smoke: ${excludedClientModules.join(', ')}; ${String(oldAffected.length)} old application batches not downloaded; ${String(responses.filter(item => item.type === 'script' && item.path.startsWith('/mobile-access/mobile-boot/')).length)} mobile boot scripts fetched`)
    }
    const mobileFrontend = await phone.evaluate(() => window.__DSH_MOBILE_FRONTEND__)
    if (mobileFrontend !== 'dedicated') throw new Error('Mobile gateway did not select the dedicated frontend')
    const back = () => phone.evaluate(() => {
      const event = new Event('dsh-mobile:native-back', { cancelable: true })
      window.dispatchEvent(event)
      return event.defaultPrevented
    })
    const onboarding = phone.locator('[role="dialog"][aria-modal="true"]').first()
    for (let step = 0; step < 3; step++) {
      await onboarding.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {})
      if (await onboarding.count() === 0) break
      const label = await onboarding.getAttribute('aria-label')
      const choices = await onboarding.locator('button').allTextContents()
      const skip = choices.findIndex(value => /稍后|later|skip|not now/iu.test(value))
      const choice = skip >= 0 ? skip : choices.length === 1 ? 0 : -1
      if (choice < 0) throw new Error('Unexpected initial DSH dialog choices')
      await onboarding.locator('button').nth(choice).click()
      await phone.waitForFunction(previous => document.querySelector('[role="dialog"][aria-modal="true"]')?.getAttribute('aria-label') !== previous, label)
    }
    if (await back()) throw new Error('Mobile Back consumed the root conversation without an open layer')
    const drawer = phone.locator('.dshm-drawer')
    await drawer.locator('button[aria-label]').first().click()
    await phone.waitForFunction(() => document.querySelector('.dshm-drawer')?.getAttribute('data-open') === 'true')
    if (!await back()) throw new Error('Mobile Back did not consume the open drawer')
    await phone.waitForFunction(() => document.querySelector('.dshm-drawer')?.getAttribute('data-open') === 'false')
    await drawer.locator('button[aria-label]').first().click()
    await phone.waitForFunction(() => document.querySelector('.dshm-drawer')?.getAttribute('data-open') === 'true')
    await drawer.locator('button[aria-haspopup="dialog"]').first().click()
    const settingsDialog = phone.locator('[role="dialog"][aria-modal="true"]').first()
    await settingsDialog.waitFor({ state: 'visible' })
    if (!await back()) throw new Error('Mobile Back did not consume the settings dialog')
    await settingsDialog.waitFor({ state: 'detached' })
    // Let dialog teardown and React's layout update finish before the next gesture.
    await phone.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    // Settings can leave a hidden sidebar subtree. Consume a drawer only while
    // it is visibly open; the drawer's independent Back behavior was checked above.
    if (!await phone.locator('.dshm-main').isVisible()) throw new Error('Conversation surface did not return after settings closed')
    if (await drawer.isVisible() && await drawer.getAttribute('data-open') === 'true') {
      if (!await back()) {
        const state = await phone.evaluate(() => ({
          width: window.innerWidth, clientWidth: document.documentElement.clientWidth,
          viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content'),
          drawerOpen: document.querySelector('.dshm-drawer')?.getAttribute('data-open'),
          drawerWidth: document.querySelector('.dshm-drawer')?.getBoundingClientRect().width,
        }))
        throw new Error(`Mobile Back did not consume the drawer below settings: ${JSON.stringify(state)}`)
      }
      await phone.waitForFunction(() => document.querySelector('.dshm-drawer')?.getAttribute('data-open') === 'false')
    }
    if (await back()) throw new Error('Mobile Back consumed the conversation after settings closed')
    const extensionBack = await phone.evaluate(() => {
      const layer = document.createElement('section')
      layer.dataset.dshMobileSurfacePlacement = 'overlay'
      layer.style.cssText = 'position:fixed;inset:0;z-index:1300'
      document.body.append(layer)
      const event = new Event('dsh-mobile:native-back', { cancelable: true })
      window.dispatchEvent(event)
      const result = event.defaultPrevented && layer.hidden
      layer.remove()
      return result
    })
    if (!extensionBack) throw new Error('Mobile Back did not close a visible extension overlay')
    console.log(`Mobile client mounted through DSH Loader and read ${String(workspace.workspaces)} Workspaces over /api/remote.mux (${String(plan.entries.length)} plugin entries, ${Date.now() - startedAt} ms)`)
  } finally {
    await browser.close()
  }
}

async function main() {
  await readFile(join(mobileRoot, 'lib', 'index.mjs'))
  await readFile(dshBin)
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-boot-smoke-'))
  let dsh
  const failures = []
  try {
    const home = await createProfile(root)
    dsh = launchDsh(root, home)
    await inspectBrowser(await dsh.ready(), dsh.logs)
  } catch (error) {
    failures.push(new Error(sanitized(error instanceof Error ? error.stack ?? error.message : String(error))))
  } finally {
    if (dsh !== undefined) {
      try {
        const result = await dsh.close()
        if (result.forced || (result.code !== 0 && result.signal !== 'SIGTERM')) {
          failures.push(new Error(`DSH did not stop quiescently: ${JSON.stringify(result)}\n${dsh.logs()}`))
        }
      } catch (error) { failures.push(error) }
    }
    try { await removeTemporaryRoot(root) } catch (error) { failures.push(error) }
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Mobile boot smoke and cleanup failed')
}

await main()
