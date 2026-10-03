import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const mobileRoot = process.env.DSH_BOOT_SMOKE_MOBILE_ROOT === undefined
  ? fileURLToPath(new URL('..', import.meta.url)) : resolve(process.env.DSH_BOOT_SMOKE_MOBILE_ROOT)
const layout = await readFile(resolve(mobileRoot, 'lib/mobile-layout.js'), 'utf8')
const client = await readFile(resolve(mobileRoot, 'lib/client.js'), 'utf8')
const fixture = `<!doctype html><html class="dsh-native-mobile-active"><head><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>body{margin:8px;font:14px/1.5 Arial}main{max-width:800px}section{padding:8px}button{min-height:48px;min-width:48px}input,textarea,[contenteditable]{font:inherit}svg{width:20px;height:20px}</style></head><body>
  <main class="dshm-shell" data-dsh-mobile-center><div id="session-owner" data-conversation-session="first-session"><section id="first" data-composer-card>
    <div data-slot="conversation.input.attachments"></div><div id="editor" contenteditable="true" data-phase="plain">Draft</div>
    <button id="add" aria-haspopup="listbox">Add</button><button id="stop" class="InputBar_fixture_primary"><svg><rect width="10" height="10"/></svg></button>
    <button id="plugin">Plugin</button><button id="send" class="InputBar_fixture_primary"><svg><path d="M0 10L10 0L20 10"/></svg></button></section></div>
    <section id="second" data-composer-card><div id="other-editor" contenteditable="plaintext-only">Other draft</div>
      <button id="other-send" class="InputBar_fixture_primary"><svg><path d="M0 10L10 0"/></svg></button></section>
    <input id="field"><textarea id="area"></textarea><div id="empty-attribute" contenteditable="">Editable</div>
    <div style="font-size:20px"><div id="inherited" contenteditable="true">Large inherited text</div></div>
    <div contenteditable="true"><span id="inherited-child">Inherited editable child</span></div>
  </main></body></html>`

// Real trusted browser pointer/keyboard events exercise the built policy against
// stock composer markers. The fixture controls submission settlement only; IME
// visibility and Safari auto-zoom still require a physical device.
const browser = await chromium.launch({ headless: true })
let cases = 0
try {
  async function withPage(options, run) {
    const context = await browser.newContext({ viewport: { width: options.width ?? 393, height: 844 }, hasTouch: options.touch !== false, isMobile: options.touch !== false, reducedMotion: 'reduce' })
    try {
      const page = await context.newPage()
      await page.route('https://composer-keyboard.test/**', route => route.fulfill({ contentType: 'text/html', body: fixture }))
      await page.goto('https://composer-keyboard.test/')
      await page.evaluate(() => {
        window.__ModuleLoader__ = { load: ({ id, factory }) => {
          const exports = factory(name => { if (name === 'react') return {}; throw new Error(`Unexpected dependency ${name}`) })
          if (id === 'dsh-mobile') window.mobileClient = exports
          else window.mobileLayout = exports
        } }
      })
      await page.addScriptTag({ content: layout })
      await page.addScriptTag({ content: client })
      if (options.enter) await page.evaluate(() => {
        const main = document.querySelector('main')
        main.classList.add('dshm-main')
        const editor = document.querySelector('#editor')
        editor.setAttribute('data-composer-input', '')
        const scroll = document.createElement('div')
        scroll.setAttribute('data-input-scroll', '')
        editor.before(scroll)
        scroll.append(editor)
        const row = document.createElement('div')
        row.append(document.createElement('div'))
        scroll.after(row)
        const area = document.createElement('textarea')
        area.id = 'composer-area'
        document.querySelector('#first').append(area)
      })
      await page.evaluate(keepNative => {
        const cleanup = []
        try {
          window.mobileClient.apply({
            effect: effect => { const dispose = effect(); if (typeof dispose === 'function') cleanup.push(dispose) },
            get: () => undefined,
            slots: { inject: () => () => {}, register: () => () => {} },
          })
          window.nativeStyles = document.querySelector('style[data-plugin="dsh-mobile"]')?.textContent
          if (window.nativeStyles === undefined) throw new Error('Built client did not install native styles')
        } finally { if (!keepNative) cleanup.reverse().forEach(dispose => dispose()) }
        window.collapses = 0
        window.disposePolicy = window.mobileLayout.installComposerSendKeyboardPolicy(() => { window.collapses++ })
        window.mode = 'immediate'
        const commit = () => {
          const editor = document.querySelector('#editor')
          editor.replaceChildren(document.createElement('p'))
          editor.dataset.phase = 'plain'
          document.querySelector('[data-slot="conversation.input.attachments"]').replaceChildren()
        }
        for (const button of document.querySelectorAll('button')) {
          button.addEventListener('mousedown', event => { event.preventDefault() })
        }
        document.querySelector('#send').addEventListener('click', () => {
          if (window.mode === 'no-consumption') return
          if (window.mode === 'async') {
            document.querySelector('#editor').dataset.phase = 'submitting'
            window.finishSend = commit
            return
          }
          commit()
          if (window.mode === 'immediate-failure') queueMicrotask(() => { document.querySelector('#editor').textContent = 'Restored draft' })
        })
      }, options.enter === true)
      await run(page)
      cases++
    } finally { await context.close() }
  }
  for (const width of [320, 393, 720, 980]) {
    await withPage({ width }, async page => {
      await page.addStyleTag({ content: await page.evaluate(() => window.nativeStyles) })
      await page.evaluate(() => {
        const editor = document.querySelector('#editor')
        editor.textContent = Array.from({ length: 20 }, (_, i) => `Draft line ${i}`).join('\n')
        editor.style.whiteSpace = 'pre-wrap'
        const scroll = document.createElement('div')
        scroll.setAttribute('data-input-scroll', '')
        editor.before(scroll)
        scroll.append(editor)
        const row = document.createElement('div')
        row.setAttribute('data-dsh-mobile-composer-row', '')
        scroll.after(row)
        row.append(document.querySelector('#stop'), document.querySelector('#send'))
        for (const button of row.querySelectorAll('button')) button.style.cssText = 'min-width:20px;min-height:20px;width:20px;height:20px;padding:0'
        document.querySelector('#send').disabled = true
        window.initialDraft = editor.innerHTML
        window.stops = 0
        document.querySelector('#stop').addEventListener('click', () => { window.stops++ })
      })
      const height = () => page.locator('[data-input-scroll]').evaluate(node => node.getBoundingClientRect().height)
      const collapsed = await height()
      if (width <= 720) assert(collapsed <= 72)
      else assert(collapsed > 72)
      await page.locator('#editor').focus()
      assert(await height() > 72)
      await page.locator('#stop').focus()
      assert(await height() > 72)
      await page.locator('#field').focus()
      assert.equal(await height(), collapsed)
      assert(await page.evaluate(() => document.querySelector('#editor').innerHTML === window.initialDraft))
      if (width <= 720) {
        for (const selector of ['#stop', '#send']) { const box = await page.locator(selector).boundingBox(); assert(box.width >= 44 && box.height >= 44) }
        await page.locator('#stop').tap()
        assert.equal(await page.evaluate(() => window.stops), 1)
        assert.equal(await page.locator('#send').isDisabled(), true)
        await page.evaluate(() => {
          const queue = document.querySelector('#send')
          queue.disabled = false
          queue.setAttribute('aria-label', 'Queue message')
          window.mode = 'no-consumption'
          window.queues = 0
          queue.addEventListener('click', () => { window.queues++ })
        })
        await page.locator('#send').tap()
        assert.equal(await page.evaluate(() => window.queues), 1)
        assert(await page.evaluate(() => document.querySelector('#editor').innerHTML === window.initialDraft))
      }
    })
  }
  const frames = page => page.evaluate(() => new Promise(resolveFrames => { requestAnimationFrame(() => { requestAnimationFrame(() => { requestAnimationFrame(resolveFrames) }) }) }))
  const focused = page => page.evaluate(() => document.activeElement.id)
  const prepare = async (page, mode = 'immediate') => {
    await page.evaluate(mode => { window.mode = mode }, mode)
    await page.locator('#editor').focus()
  }
  const tap = async (page, selector) => {
    const box = await page.locator(selector).boundingBox()
    assert(box !== null)
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
  }
  const expectCollapsed = async page => {
    await page.waitForFunction(() => window.collapses === 1)
    assert.notEqual(await focused(page), 'editor')
  }
  const expectPreserved = async page => {
    await frames(page)
    assert.equal(await focused(page), 'editor')
    assert.equal(await page.evaluate(() => window.collapses), 0)
  }

  for (const width of [393, 980]) {
    for (const surface of ['native', 'shell']) {
      await withPage({ width }, async page => {
        await page.evaluate(surface => {
          if (surface === 'native') document.querySelector('main').classList.remove('dshm-shell')
          else document.querySelector('main').removeAttribute('data-dsh-mobile-center')
        }, surface)
        const css = await page.evaluate(surface => surface === 'native' ? window.nativeStyles : window.mobileLayout.MOBILE_LAYOUT_STYLES, surface)
        await page.addStyleTag({ content: css })
        for (const size of [14, 18, 20]) {
          await page.evaluate(size => { document.documentElement.style.setProperty('--dsh-content-font-size', `${size}px`) }, size)
          const sizes = await page.locator('#editor,#other-editor,#field,#area,#empty-attribute,#inherited-child').evaluateAll(nodes => nodes.map(node => parseFloat(getComputedStyle(node).fontSize)))
          assert(sizes.every(value => value === Math.max(16, size)), `${surface} ${width}px: editable font did not preserve ${size}px preference: ${sizes}`)
          assert.equal(await page.locator('#inherited').evaluate(node => getComputedStyle(node).fontSize), '20px')
        }
        await page.evaluate(() => { document.documentElement.style.removeProperty('--dsh-content-font-size') })
        assert.equal(await page.locator('#inherited').evaluate(node => getComputedStyle(node).fontSize), '20px')
      })
    }
  }
  await withPage({}, async page => { await prepare(page); await tap(page, '#send'); await expectCollapsed(page) })
  await withPage({ width: 980 }, async page => { await prepare(page); await tap(page, '#send'); await expectCollapsed(page) })
  await withPage({}, async page => {
    await page.locator('#editor').fill('')
    await prepare(page); await tap(page, '#send'); await expectPreserved(page)
  })
  await withPage({}, async page => {
    await page.locator('#send').evaluate(node => { node.disabled = true })
    await prepare(page); await tap(page, '#send'); await frames(page)
    assert.equal(await page.evaluate(() => window.collapses), 0)
    assert.equal(await page.locator('#editor').textContent(), 'Draft')
  })
  await withPage({}, async page => {
    await prepare(page, 'async'); await tap(page, '#send'); await expectPreserved(page)
    await page.evaluate(() => { window.finishSend() }); await expectCollapsed(page)
  })
  await withPage({}, async page => {
    await page.locator('#editor').fill('')
    await page.evaluate(() => { document.querySelector('[data-slot="conversation.input.attachments"]').innerHTML = '<div role="group"><div><img alt="photo" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"></div></div>' })
    await prepare(page); await tap(page, '#send'); await expectCollapsed(page)
  })
  await withPage({}, async page => {
    await page.locator('#editor').evaluate(node => { node.innerHTML = '<span contenteditable="false" data-lexical-decorator="true"><img alt="reference"></span>' })
    await prepare(page); await tap(page, '#send'); await expectCollapsed(page)
  })
  for (const selector of ['#add', '#stop', '#plugin', '#other-send']) {
    await withPage({}, async page => { await prepare(page); await tap(page, selector); await expectPreserved(page) })
  }
  for (const mode of ['no-consumption', 'immediate-failure']) {
    await withPage({}, async page => { await prepare(page, mode); await tap(page, '#send'); await expectPreserved(page); assert.notEqual(await page.locator('#editor').textContent(), '') })
  }
  await withPage({}, async page => { await prepare(page); await page.locator('#send').evaluate(node => { node.click() }); await expectPreserved(page) })
  await withPage({}, async page => {
    await prepare(page)
    await page.locator('#editor').evaluate(node => { node.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); document.querySelector('#send').click() } }) })
    await page.keyboard.press('Enter'); await expectPreserved(page)
  })
  await withPage({ touch: false, width: 980 }, async page => { await prepare(page); await page.locator('#send').click(); await expectPreserved(page) })
  await withPage({}, async page => {
    await page.evaluate(() => { window.__DSH_MOBILE_NATIVE__ = {}; window.__DSH_MOBILE_KEYBOARD_STATE__ = { imeVisible: true, noHardwareKeyboard: false } })
    await prepare(page); await tap(page, '#send'); await expectPreserved(page)
  })
  await withPage({}, async page => {
    await page.evaluate(() => { window.__DSH_MOBILE_NATIVE__ = {}; window.__DSH_MOBILE_KEYBOARD_STATE__ = { imeVisible: true, noHardwareKeyboard: true } })
    await prepare(page); await tap(page, '#send'); await expectCollapsed(page)
  })
  for (const nativeState of [undefined, { imeVisible: false, noHardwareKeyboard: true }]) {
    await withPage({}, async page => {
      await page.evaluate(nativeState => { window.__DSH_MOBILE_NATIVE__ = {}; window.__DSH_MOBILE_KEYBOARD_STATE__ = nativeState }, nativeState)
      await prepare(page); await tap(page, '#send'); await expectPreserved(page)
    })
  }
  await withPage({}, async page => {
    await prepare(page); await page.locator('#editor').evaluate(node => { node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })) })
    await tap(page, '#send'); await expectPreserved(page)
  })
  for (const cancellation of ['type', 'focus', 'unmount', 'dispose', 'new-composer', 'session-change']) {
    await withPage({}, async page => {
      await prepare(page, 'async'); await tap(page, '#send')
      if (cancellation === 'type') await page.keyboard.type('suffix')
      if (cancellation === 'focus') await page.locator('#field').focus()
      if (cancellation === 'unmount') await page.locator('#first').evaluate(node => { node.remove() })
      if (cancellation === 'dispose') await page.evaluate(() => { window.disposePolicy() })
      if (cancellation === 'new-composer') await page.locator('#editor').evaluate(node => { document.querySelector('#second').append(node) })
      if (cancellation === 'session-change') await page.locator('#session-owner').evaluate(node => { node.dataset.conversationSession = 'new-session' })
      if (cancellation !== 'unmount') await page.evaluate(() => { window.finishSend() })
      await frames(page)
      assert.equal(await page.evaluate(() => window.collapses), 0, `Observation survived ${cancellation}`)
    })
  }
  await withPage({}, async page => {
    await prepare(page); await tap(page, '#send'); await expectCollapsed(page)
    await page.locator('#editor').evaluate(node => { node.textContent = 'Late API failure restored the draft' })
    assert.equal(await page.locator('#editor').textContent(), 'Late API failure restored the draft')
  })
  // Keep the built native surface alive alongside the send-collapse policy.
  // The fixture models the stock editor's Shift+Enter command with a real DOM
  // line break; plain Enter submits, and composition/menu Enter is consumed.
  const softState = { imeVisible: true, noHardwareKeyboard: true }
  const expectEnter = async (page, key, expected, safeguard) => {
    await page.evaluate(() => {
      window.enterCounts = { sends: 0, newlines: 0, menus: 0, compositions: 0 }
      window.mode = 'no-consumption'
      document.querySelector('#send').addEventListener('click', () => { window.enterCounts.sends++ })
      const editor = document.querySelector('#editor')
      window.fixtureComposing = false
      window.fixtureConfirming = false
      editor.addEventListener('compositionstart', () => { window.fixtureComposing = true })
      editor.addEventListener('compositionend', () => { window.fixtureComposing = false })
      editor.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return
        if (window.fixtureComposing || window.fixtureConfirming || editor.hasAttribute('data-composer-composing') || event.isComposing || event.keyCode === 229) {
          event.preventDefault(); window.enterCounts.compositions++; return
        }
        if (document.querySelector('#add').getAttribute('aria-expanded') === 'true' || document.querySelector('[data-trigger-menu]')) {
          event.preventDefault(); window.enterCounts.menus++; return
        }
        if (event.shiftKey) {
          event.preventDefault()
          document.execCommand('insertLineBreak')
          window.enterCounts.newlines++
        } else {
          event.preventDefault(); document.querySelector('#send').click()
        }
      })
    })
    await page.locator('#editor').focus()
    await page.keyboard.press('End')
    await page.evaluate(safeguard => {
      const editor = document.querySelector('#editor')
      if (safeguard === 'composition') editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      if (safeguard === 'composition-marker') editor.setAttribute('data-composer-composing', '')
      if (safeguard === 'recent-composition') {
        // Freeze only the policy clock to test the 10ms confirmation window
        // deterministically while the subsequent keyboard event stays trusted.
        performance.now = () => 100
        window.fixtureConfirming = true
        editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
      }
      if (safeguard === 'menu') document.querySelector('#add').setAttribute('aria-expanded', 'true')
      if (safeguard === 'menu-marker') {
        const menu = document.createElement('div')
        menu.setAttribute('data-trigger-menu', '')
        document.querySelector('#first').append(menu)
      }
    }, safeguard)
    await page.keyboard.press(key)
    assert.deepEqual(await page.evaluate(() => window.enterCounts), { sends: 0, newlines: 0, menus: 0, compositions: 0, ...expected })
    const text = await page.locator('#editor').innerText()
    if (expected.newlines) assert(text.includes('\n'), `No DOM newline for ${key}: ${JSON.stringify(text)}`)
    else assert.equal(text, 'Draft')
  }
  for (const nativeState of [undefined, null, { imeVisible: true, noHardwareKeyboard: false }, { imeVisible: false, noHardwareKeyboard: true }, softState]) {
    await withPage({ enter: true }, async page => {
      await page.evaluate(nativeState => { window.__DSH_MOBILE_NATIVE__ = {}; window.__DSH_MOBILE_KEYBOARD_STATE__ = nativeState }, nativeState)
      await expectEnter(page, 'Enter', nativeState === softState ? { newlines: 1 } : { sends: 1 })
    })
  }
  await withPage({ enter: true }, async page => { await expectEnter(page, 'Enter', { sends: 1 }) })
  await withPage({ enter: true, touch: false, width: 980 }, async page => { await expectEnter(page, 'Enter', { sends: 1 }) })
  for (const key of ['Shift+Enter', 'Control+Enter', 'Alt+Enter', 'Meta+Enter']) {
    await withPage({ enter: true }, async page => {
      await page.evaluate(state => { window.__DSH_MOBILE_NATIVE__ = {}; window.__DSH_MOBILE_KEYBOARD_STATE__ = state }, softState)
      await expectEnter(page, key, key === 'Shift+Enter' ? { newlines: 1 } : { sends: 1 })
    })
  }
  for (const safeguard of ['composition', 'composition-marker', 'recent-composition', 'menu', 'menu-marker']) {
    await withPage({ enter: true }, async page => {
      await page.evaluate(state => { window.__DSH_MOBILE_NATIVE__ = {}; window.__DSH_MOBILE_KEYBOARD_STATE__ = state }, softState)
      // Install the fixture handler first, then arm the safeguard before Enter.
      await expectEnter(page, 'Enter', safeguard.startsWith('menu') ? { menus: 1 } : { compositions: 1 }, safeguard)
    })
  }
  await withPage({ enter: true }, async page => {
    await page.evaluate(state => {
      window.__DSH_MOBILE_NATIVE__ = {}; window.__DSH_MOBILE_KEYBOARD_STATE__ = state
      window.textareaSends = 0
      window.mode = 'no-consumption'
      document.querySelector('#send').addEventListener('click', () => { window.textareaSends++ })
      document.querySelector('#composer-area').addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); document.querySelector('#send').click() }
      })
    }, softState)
    await page.locator('#composer-area').fill('Area draft')
    await page.keyboard.press('Enter')
    assert.equal(await page.evaluate(() => window.textareaSends), 1)
    assert.equal(await page.locator('#composer-area').inputValue(), 'Area draft')
    await page.keyboard.press('Shift+Enter')
    assert.equal(await page.locator('#composer-area').inputValue(), 'Area draft\n')
    assert.equal(await page.evaluate(() => window.textareaSends), 1)
    await page.evaluate(() => {
      window.mode = 'immediate'
      const attachment = document.createElement('div')
      attachment.setAttribute('role', 'group')
      attachment.append(document.createElement('img'))
      document.querySelector('[data-slot="conversation.input.attachments"]').append(attachment)
    })
    await tap(page, '#send'); await frames(page)
    assert.equal(await page.locator('#composer-area').inputValue(), 'Area draft\n')
    assert.equal(await page.evaluate(() => window.collapses), 0)
    assert.equal(await focused(page), 'composer-area')
  })
  console.log(`Composer keyboard and editable-font smoke passed (${cases} browser cases).`)
} finally { await browser.close() }
