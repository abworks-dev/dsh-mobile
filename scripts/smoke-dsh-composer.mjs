import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { packBundle } from './packed-profile.mjs'
import {
  createMobileProfile, launchDsh, removeTemporaryRoot, openPairing,
  pairMobilePage, dismissOnboarding, CLIENT_TIMEOUT_MS, sanitized,
} from './mobile-boot-fixture.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined ? repository : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const dshBin = process.env.DSH_BOOT_SMOKE_BIN ?? fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/lib/bin.js', import.meta.url))
const prefix = 'dsh-mobile-composer-smoke-'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64')
const referenceName = 'composer-reference.txt'
const root = await mkdtemp(join(tmpdir(), prefix))
let dsh
let browser
let phone
let failure
let rpcSequence = 0

async function rpc(page, method, request) {
  const response = await page.evaluate(async ({ method, request, rpcId }) => {
    const result = await fetch(`/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: { request } } }),
      signal: AbortSignal.timeout(60000),
    })
    return { status: result.status, body: await result.json() }
  }, { method, request, rpcId: `composer-smoke-${++rpcSequence}` })
  assert.equal(response.status, 200, `${method} HTTP failure: ${sanitized(JSON.stringify(response))}`)
  assert.equal(response.body.result?.ok, true, `${method} RPC failure: ${sanitized(JSON.stringify(response))}`)
  return response.body.result.value
}

const frames = page => page.evaluate(() => new Promise(resolveFrame => { requestAnimationFrame(() => { requestAnimationFrame(resolveFrame) }) }))
const nativeBack = page => page.evaluate(() => {
  const event = new Event('dsh-mobile:native-back', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
})
async function retained(page, expected) {
  const current = await page.evaluate(() => {
    const editor = document.querySelector('[data-composer-card] [data-composer-input]')
    const rail = document.querySelector('[data-composer-card] [data-slot="conversation.input.attachments"]')
    return {
      text: editor.textContent,
      chips: Array.from(editor.querySelectorAll('[data-composer-chip]'), chip => ({ source: chip.getAttribute('data-composer-chip'), text: chip.textContent })),
      images: Array.from(rail?.querySelectorAll('img') ?? [], image => ({ alt: image.alt, src: image.getAttribute('src') })),
    }
  })
  if (expected !== undefined) assert.deepEqual(current, expected, 'DSH changed the held draft, reference, or attachment during focus changes')
  return current
}

try {
  const workspacePath = join(root, 'workspace')
  await mkdir(workspacePath)
  await writeFile(join(workspacePath, referenceName), 'Reference-only composer acceptance fixture.\n')
  const tarball = await packBundle(mobileRoot, root)
  const home = await createMobileProfile(root, {
    tarball, dshBin,
    extraPatches: [{ id: 'llm-deepseek', config: {
      // Static provider metadata exercises the real search UI without an API key or model request.
      models: Array.from({ length: 6 }, (_, index) => ({ id: `composer-model-${index}`, name: `Composer model ${index}`, contextWindow: 128000, inputModalities: ['text', 'image'] })),
    } }],
  })
  dsh = launchDsh(root, home, dshBin)
  browser = await chromium.launch({ headless: true })
  const desktop = await browser.newPage({ locale: 'en-US' })
  const pairUrl = await openPairing(desktop, await dsh.ready(), dsh.logs)
  const workspace = await rpc(desktop, 'workspace/create', { path: workspacePath })
  assert.equal(typeof workspace.workspace?.workspaceId, 'string')
  phone = await browser.newPage({ viewport: { width: 375, height: 812 }, locale: 'en-US', isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  const prompts = []
  await phone.route('**/api/session/prompt', async route => { prompts.push(route.request().url()); await route.abort('blockedbyclient') })
  await pairMobilePage(phone, pairUrl, dsh.logs)
  await dismissOnboarding(phone)
  const drawer = phone.locator('.dshm-drawer')
  await drawer.locator('button[data-dsh-mobile-toggle]').click()
  await phone.waitForFunction(() => document.querySelector('.dshm-scrim')?.getAttribute('data-open') === 'true')
  // Let the actual Workspace navigation create/open its own Session, including
  // any first-use blank-session reuse. Do not depend on cold summary titles.
  const workspaceRow = drawer.locator(`[role="treeitem"][data-row-key="workspace:${workspace.workspace.workspaceId}"]`)
  const created = phone.waitForResponse(response => {
    if (new URL(response.url()).pathname !== '/api/session/create') return false
    return response.request().postDataJSON()?.payload?.args?.request?.workspaceId === workspace.workspace.workspaceId
  }, { timeout: CLIENT_TIMEOUT_MS })
  try { await workspaceRow.getByRole('button').last().click() } catch (error) {
    void created.catch(() => {})
    const rows = await drawer.getByRole('treeitem').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, expanded: node.getAttribute('aria-expanded'), selected: node.getAttribute('aria-selected'), key: node.getAttribute('data-row-key') })))
    throw new Error(`Created Workspace was not selectable: ${sanitized(JSON.stringify(rows))}`, { cause: error })
  }
  const createdSession = await (await created).json()
  assert.equal(createdSession.result?.ok, true)
  const sessionId = createdSession.result.value.sessionId
  assert.equal(typeof sessionId, 'string')
  await phone.waitForFunction(id => document.querySelector('[data-conversation-session]')?.getAttribute('data-conversation-session') === id, sessionId)
  const card = phone.locator('[data-composer-card]').first()
  const editor = card.locator('[data-composer-input][contenteditable="true"]')
  await editor.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })

  // Use the real input trigger to insert a real Lexical reference chip.
  await editor.fill('@composer-reference')
  const reference = phone.getByRole('option').filter({ hasText: referenceName })
  await reference.first().waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  await reference.first().click()
  await editor.locator('[data-composer-chip]').waitFor({ state: 'attached', timeout: CLIENT_TIMEOUT_MS })
  const editorBounds = await editor.boundingBox()
  assert(editorBounds !== null)
  // Click trailing editable whitespace, not the non-editable reference capsule,
  // whose activation legitimately opens the referenced file instead of typing.
  await editor.click({ position: { x: editorBounds.width - 4, y: editorBounds.height / 2 } })
  assert(await editor.evaluate(node => document.activeElement === node), 'Trailing draft whitespace did not focus the real editor')
  await phone.keyboard.press('End')
  assert(await editor.evaluate(node => document.activeElement === node), 'End moved focus outside the real editor')
  for (let index = 0; index < 22; index++) {
    await phone.keyboard.press('Shift+Enter')
    await phone.keyboard.type(`Kept draft line ${index}`)
  }
  try {
    await phone.waitForFunction(() => document.querySelector('[data-composer-input]')?.textContent?.includes('Kept draft line 21'))
  } catch (error) {
    const state = await editor.evaluate(node => ({ text: node.textContent, phase: node.getAttribute('data-phase'), focused: document.activeElement === node, activeTag: document.activeElement?.tagName }))
    throw new Error(`Real draft did not retain typed lines: ${sanitized(JSON.stringify(state))}; attemptedSubmissions=${prompts.length}`, { cause: error })
  }
  await card.locator('input[type="file"]').setInputFiles({ name: 'composer-image.png', mimeType: 'image/png', buffer: png })
  await card.getByRole('img', { name: 'composer-image.png' }).waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
  const expected = await retained(phone)
  assert.equal(expected.chips.length, 1)
  assert.equal(expected.images.length, 1)
  assert(expected.text.includes('Kept draft line 21'))
  const scroll = card.locator('[data-input-scroll]')
  const expandedHeight = async () => scroll.evaluate(node => node.getBoundingClientRect().height)

  const geometry = []
  for (const viewport of [{ width: 375, height: 812 }, { width: 844, height: 393 }]) {
    for (const font of [16, 20]) {
      await phone.setViewportSize(viewport)
      await phone.evaluate(font => { document.body.style.setProperty('--dsh-content-font-size', `${font}px`) }, font)
      await editor.focus()
      await frames(phone)
      const expanded = await expandedHeight()
      assert(expanded > 72)
      const model = card.locator('[data-dsh-mobile-composer-model-trigger]')
      const selectedModel = await model.textContent()
      await model.click()
      const menuId = await model.getAttribute('aria-controls')
      assert(menuId !== null, 'DSH model trigger did not open its own menu')
      const menu = phone.locator(`[id="${menuId}"]`)
      await menu.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
      if (await menu.getByRole('menuitem').count() > 0) await menu.getByRole('menuitem').first().click()
      const search = menu.getByRole('searchbox')
      await search.waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
      await search.focus()
      await frames(phone)
      assert.equal(await search.evaluate(node => node.closest('[data-composer-card]')), null, 'Search is not the actual body portal')
      assert.equal(await search.evaluate(node => getComputedStyle(node).fontSize), `${font}px`, 'Actual model search did not preserve the mobile editable font floor')
      const folded = await expandedHeight()
      if (viewport.width <= 720) assert(folded <= 72.1, `Inactive real DSH composer remained ${folded}px`)
      else assert.equal(folded, expanded)
      await retained(phone, expected)
      await search.fill('Composer model 2')
      await menu.getByRole('menuitemradio').filter({ hasText: 'Composer model 2' }).waitFor({ state: 'visible', timeout: CLIENT_TIMEOUT_MS })
      await retained(phone, expected)
      const bounds = await menu.boundingBox()
      assert(bounds !== null && bounds.width > 0 && bounds.height > 0, 'Actual model portal has no usable bounds')
      geometry.push({ ...viewport, font, expanded, folded, menu: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } })
      assert.equal(await nativeBack(phone), true, 'Mobile Back did not consume the actual model search pane')
      await search.waitFor({ state: 'hidden', timeout: CLIENT_TIMEOUT_MS })
      assert.equal(await menu.isVisible(), true, 'Mobile Back closed the whole menu instead of returning to its root')
      assert(await menu.getByRole('menuitem').count() > 0, 'Mobile Back did not restore the stock root menu')
      await retained(phone, expected)
      assert.equal(await nativeBack(phone), true, 'Mobile Back did not consume the root model menu')
      await menu.waitFor({ state: 'detached', timeout: CLIENT_TIMEOUT_MS })
      assert.equal(await model.textContent(), selectedModel, 'Mobile Back changed the model selection')
      assert.equal(await nativeBack(phone), false, 'Mobile Back consumed the conversation without an open layer')
      await editor.focus()
      await frames(phone)
      assert.equal(await expandedHeight(), expanded)
      await retained(phone, expected)
      const action = card.locator('button[class*="_primary"]').last()
      if (viewport.width <= 720) {
        const bounds = await action.boundingBox()
        assert(bounds !== null && bounds.width >= 44 && bounds.height >= 44, 'Real primary action did not retain its 44px touch target')
      }
    }
  }
  assert.equal(prompts.length, 0, 'Composer acceptance attempted a model submission')
  console.log(`Packed DSH composer acceptance passed: real Lexical draft, reference chip, image intake, model body-portal/search/native Back, 375px/landscape and 16px/20px fonts (${geometry.length} layouts).`)
  console.log(JSON.stringify(geometry))
} catch (error) {
  failure = new Error(`${sanitized(error instanceof Error ? error.stack ?? error.message : String(error))}\n${dsh?.logs() ?? ''}`)
} finally {
  const failures = failure === undefined ? [] : [failure]
  if (browser !== undefined) await browser.close().catch(error => { failures.push(error) })
  if (dsh !== undefined) {
    try {
      const stopped = await dsh.close()
      if (stopped.forced || (stopped.code !== 0 && stopped.signal !== 'SIGTERM')) {
        throw new Error(`Composer DSH fixture did not stop quiescently: ${sanitized(JSON.stringify(stopped))}\n${dsh.logs()}`)
      }
    } catch (error) { failures.push(error) }
  }
  await removeTemporaryRoot(root, prefix).catch(error => { failures.push(error) })
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Composer acceptance and cleanup failed')
}
