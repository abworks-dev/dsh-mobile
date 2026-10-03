#!/usr/bin/env node
/**
 * Capture mobile-shell screenshots from a real DSH boot.
 *
 * Deliberately kept out of the smoke suite: this script writes image files, so
 * it has no place in CI. Use it to refresh documentation artwork, to review a
 * layout change by eye, or to attach before/after images to a pull request.
 *
 * It boots the same way `smoke-dsh-mobile-boot.mjs` does — pack the bundle,
 * install it into a throwaway DSH home, start `dsh web` on an ephemeral port,
 * pair a phone viewport through the real gateway — then walks the touch layers
 * and screenshots each one.
 *
 *   node scripts/capture-mobile-screenshots.mjs
 *   node scripts/capture-mobile-screenshots.mjs --out /tmp/shots
 *   node scripts/capture-mobile-screenshots.mjs --tarball ./dsh-mobile-0.5.4.tgz
 *
 * The DSH runtime resolves exactly as in the smoke test: set
 * `DSH_BOOT_SMOKE_BIN`, or install `@deepseek-ai/dsh` into this repository.
 */
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { assertBundledComponents, installPackedBundle, packBundle } from './packed-profile.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const dshBin = process.env.DSH_BOOT_SMOKE_BIN
  ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))

const START_TIMEOUT_MS = 90_000
const CLIENT_TIMEOUT_MS = 60_000
/** Matches the reference Android handset used by the mobile layout work. */
const PHONE_VIEWPORT = { width: 390, height: 844 }
const SETTLE_MS = 400

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

function sanitized(output) {
  return output
    .replace(/([?&]token=)[^\s&]+/gu, '$1<redacted>')
    .replace(/(#key=)[^\s]+/gu, '$1<redacted>')
    .slice(-12_000)
}

/** Remove the throwaway root without ever letting recursion meet a link. */
async function removeTemporaryRoot(root) {
  const absolute = resolve(root)
  if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('dsh-mobile-capture-')) {
    throw new Error('Refusing to remove a directory outside this script temporary root')
  }
  await rm(absolute, { recursive: true, force: true })
}

async function createProfile(root, tarball) {
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'web')
  const mobileState = join(home, 'mobile-access')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await mkdir(mobileState, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-mobile'] } },
  }, null, 2) + '\n')
  // `initiallyEnabled` lets the gateway come up without a UI round-trip, so the
  // capture works headlessly. Loopback only: this profile never faces a network.
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{
    id: 'mobile-access',
    config: {
      setupFile: join(mobileState, 'setup.json'),
      stateFile: join(mobileState, 'devices.json'),
      controlFile: join(mobileState, 'control.json'),
      customCssFile: join(mobileState, 'mobile.css'),
      customScriptFile: join(mobileState, 'mobile.js'),
      initiallyEnabled: true,
      listenHost: '127.0.0.1',
      listenPort: 0,
      allowedCidrs: ['127.0.0.0/8'],
      tls: { mode: 'disabled' },
    },
  }]) + '\n')
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  await installPackedBundle(tarball, profile)
  await assertBundledComponents(join(profile, 'node_modules', 'dsh-mobile'))
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
  const exit = new Promise(resolveExit => { exitResult = resolveExit })
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
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
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

async function pairingUrl(baseUrl, logs) {
  const browser = await chromium.launch({ headless: true })
  try {
    const desktop = await browser.newPage()
    await desktop.goto(baseUrl, { waitUntil: 'domcontentloaded' })
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
    return pairing.body.pairUrl
  } finally { await browser.close() }
}

/** Dismiss the first-run dialogs so the conversation surface is the real subject. */
async function skipOnboarding(phone) {
  const dialog = phone.locator('[role="dialog"][aria-modal="true"]').first()
  for (let step = 0; step < 3; step++) {
    await dialog.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {})
    if (await dialog.count() === 0) return
    const label = await dialog.getAttribute('aria-label')
    const choices = await dialog.locator('button').allTextContents()
    const skip = choices.findIndex(value => /稍后|later|skip|not now/iu.test(value))
    const choice = skip >= 0 ? skip : choices.length === 1 ? 0 : -1
    if (choice < 0) throw new Error('Unexpected initial DSH dialog choices')
    await dialog.locator('button').nth(choice).click()
    await phone.waitForFunction(previous => document.querySelector('[role="dialog"][aria-modal="true"]')?.getAttribute('aria-label') !== previous, label)
  }
}

async function capture(baseUrl, logs, outputDir) {
  const browser = await chromium.launch({ headless: true })
  const written = []
  try {
    const pairUrl = await pairingUrl(baseUrl, logs)
    const phone = await browser.newPage({
      viewport: PHONE_VIEWPORT, isMobile: true, hasTouch: true, reducedMotion: 'reduce',
      deviceScaleFactor: 2,
    })
    const shot = async name => {
      const path = join(outputDir, `${name}.png`)
      await phone.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))))
      await phone.waitForTimeout(SETTLE_MS)
      await phone.screenshot({ path })
      written.push(path)
      console.log(`  captured ${name}.png`)
    }

    await phone.goto(pairUrl, { waitUntil: 'domcontentloaded' })
    await phone.locator('#pair-form button').waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    await shot('mobile-shell-01-pairing')

    await phone.locator('#pair-form button').click()
    await phone.waitForURL(url => url.pathname === '/', { timeout: 15_000 })
    await phone.waitForFunction(() => {
      const root = document.querySelector('#root')
      const boot = document.querySelector('[data-dsh-boot]')
      if (boot?.textContent?.includes('Failed to load plugins')) return 'failed'
      if (root !== null && boot === null && root.querySelector('.dshm-shell') !== null) return 'mounted'
      return false
    }, undefined, { timeout: CLIENT_TIMEOUT_MS })
    await skipOnboarding(phone)
    await phone.locator('.dshm-main').waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    await shot('mobile-shell-02-conversation')

    const drawer = phone.locator('.dshm-drawer')
    const drawerToggle = drawer.locator('button[data-dsh-mobile-toggle]')
    await drawerToggle.click()
    await phone.waitForFunction(() => document.querySelector('.dshm-scrim')?.getAttribute('data-open') === 'true')
    await shot('mobile-shell-03-session-drawer')

    await drawer.locator('button[aria-haspopup="dialog"]').first().click()
    const settings = phone.locator('[role="dialog"][aria-modal="true"]').first()
    await settings.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
    await shot('mobile-shell-04-settings')

    return written
  } finally { await browser.close() }
}

async function main() {
  const outputDir = resolve(option('out', join(repository, 'assets', 'screenshots', 'captured')))
  const tarballOption = option('tarball', undefined)
  await readFile(dshBin).catch(() => {
    throw new Error(`DSH CLI not found at ${dshBin}. Install @deepseek-ai/dsh here, or set DSH_BOOT_SMOKE_BIN.`)
  })
  await mkdir(outputDir, { recursive: true })
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-capture-'))
  let dsh
  const failures = []
  try {
    const tarball = tarballOption === undefined ? await packBundle(repository, root) : resolve(tarballOption)
    const home = await createProfile(root, tarball)
    dsh = launchDsh(root, home)
    const written = await capture(await dsh.ready(), dsh.logs, outputDir)
    console.log(`\n${String(written.length)} screenshots written to ${outputDir}`)
  } catch (error) {
    failures.push(error instanceof Error ? error : new Error(String(error)))
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
  if (failures.length > 1) throw new AggregateError(failures, 'Mobile screenshot capture and cleanup failed')
}

await main()
