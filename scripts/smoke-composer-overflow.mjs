import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'

const client = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
const browser = await chromium.launch({ headless: true })
let cases = 0
try {
  for (const width of [320, 375, 393, 720, 844, 900]) {
    for (const font of [16, 20, 32]) {
      for (const theme of ['light', 'dark']) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: 'reduce' })
        try {
          const page = await context.newPage()
          await page.route('https://overflow.test/**', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html class="dsh-native-mobile-active"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
            *{box-sizing:border-box}body{margin:0;font:16px/1.5 Arial;background:${theme === 'light' ? '#fff' : '#171a21'};color:${theme === 'light' ? '#171a21' : '#fff'}}main{padding:8px;width:100%;max-width:700px;margin:auto}
            button{font:inherit;min-height:44px;border:1px solid;padding:4px 8px;background:transparent;color:inherit}.InputBar_fixture_row,.InputBar_fixture_tools,.InputBar_fixture_trailing,.InputBar_fixture_standardControls{display:flex;gap:6px}.InputBar_fixture_row{flex-wrap:wrap}.InputBar_fixture_trailing{width:100%;min-width:0}.InputBar_fixture_standardControls{flex:1;min-width:0;flex-wrap:wrap}.InputBar_fixture_primary{width:44px;height:44px;padding:4px;flex:none}[data-slot]{display:contents}.Model_fixture_root{flex:1;min-width:0}.Model_fixture_root button{display:flex;width:100%;min-width:0}.Model_fixture_label{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
          </style></head><body><main data-dsh-mobile-center><div data-conversation-session="overflow"><div class="InputBar_fixture_root"><div data-composer-card><div data-input-scroll><div data-composer-input contenteditable="true">Held draft</div></div><div class="InputBar_fixture_row" data-dsh-mobile-composer-row><div class="InputBar_fixture_tools" data-dsh-mobile-composer-tools><button id="add">+</button><div data-slot="conversation.input.left"><button id="skill">技能</button><button id="memory">记忆·智能</button><button id="expert">专家提示词</button></div></div><div class="InputBar_fixture_trailing" data-dsh-mobile-composer-trailing><div class="InputBar_fixture_standardControls" data-dsh-mobile-composer-controls><div data-slot="conversation.input.right"><button id="right-extra">Extra control</button></div><div class="Model_fixture_root" data-dsh-mobile-composer-model><button id="model" data-dsh-mobile-composer-model-trigger><span class="Model_fixture_label" data-dsh-mobile-composer-model-label>deepseek/example-long-model-name</span></button></div></div><button id="stop" class="InputBar_fixture_primary" aria-label="Stop">■</button><button id="send" class="InputBar_fixture_primary" aria-label="Send">↑</button></div></div></div></div>
          <div data-slot="settings.general.item"><div class="gUzyzq_row" id="host-font"><div class="gUzyzq_control"><div class="gUzyzq_stepper"><div class="gUzyzq_arrows"><button>Host font</button></div></div></div></div><div data-mobile-font-setting>Local font</div></div></main></body></html>` }))
          await page.goto('https://overflow.test/')
          await page.evaluate(() => {
            window.__ModuleLoader__ = { load: ({ factory }) => { window.mobileClient = factory(name => {
              if (name === 'react') return {}
              throw new Error(`Unexpected dependency ${name}`)
            }) } }
          })
          await page.addScriptTag({ content: client })
          await page.evaluate(font => {
            const disposers = []
            window.mobileClient.apply({ effect: effect => { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose) }, get: () => undefined, slots: { inject: () => () => {}, register: () => () => {} } })
            window.disposeMobile = () => disposers.reverse().forEach(dispose => dispose())
            // Text enlargement exercises the toolbar, not a Host typography setting.
            document.querySelector('[data-dsh-mobile-composer-row]').style.fontSize = `${font}px`
            window.sends = 0
            document.querySelector('#send').addEventListener('click', () => window.sends++)
          }, font)
          const geometry = await page.locator('[data-dsh-mobile-composer-row] button').evaluateAll(buttons => buttons.map(button => {
            const { x, y, right, bottom, width, height } = button.getBoundingClientRect()
            return { id: button.id, x, y, right, bottom, width, height }
          }))
          for (const rect of geometry) {
            assert(rect.x >= 0 && rect.right <= width + 0.5, `${width}/${font}/${theme}: ${rect.id} leaves viewport ${JSON.stringify(rect)}`)
            assert(rect.height >= 44, `${rect.id} lost its touch target`)
          }
          for (let i = 0; i < geometry.length; i++) for (const right of geometry.slice(i + 1)) {
            const left = geometry[i]
            const overlapX = Math.min(left.right, right.right) - Math.max(left.x, right.x)
            const overlapY = Math.min(left.bottom, right.bottom) - Math.max(left.y, right.y)
            assert(overlapX <= 0.5 || overlapY <= 0.5, `${width}/${font}/${theme}: controls overlap: ${JSON.stringify({ left, right, geometry })}`)
          }
          await page.locator('#send').click()
          assert.equal(await page.evaluate(() => window.sends), 1)
          assert.equal(await page.locator('[data-composer-input]').textContent(), 'Held draft')
          assert.equal(await page.locator('#host-font').isVisible(), false, 'Hashed Host font row was not replaced')
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
          await page.evaluate(async () => {
            document.body.style.setProperty('--dsh-content-font-size', '17px')
            await new Promise(resolve => requestAnimationFrame(resolve))
            if (document.body.style.getPropertyValue('--dsh-content-font-size') !== '16px') throw new Error('Host changed mobile typography')
            window.disposeMobile()
            if (document.body.style.getPropertyValue('--dsh-content-font-size') !== '17px') throw new Error('Disposal did not restore latest Host typography')
          })
          cases++
        } finally { await context.close() }
      }
    }
  }
  console.log(`Composer extension controls, primary actions, local typography and disposal passed in ${cases} layouts`)
} finally { await browser.close() }
