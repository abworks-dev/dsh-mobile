import { chromium } from 'playwright'
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'

// Render the official DeepSeek whale SVG in N color variants at all launcher densities.
// Output: res/mipmap-<density>/ic_launcher_whale_<variant>.png + toolbar vector-friendly PNGs are NOT needed (toolbar uses a tintable vector).

const svgPath = 'E:/Workspace/deepseek-harness/dsh-mobile-fork/whale-official.svg'
const outRoot = 'E:/Workspace/deepseek-harness/dsh-mobile-fork/apps/mobile/android/app/src/main/res'
const svg = readFileSync(svgPath, 'utf8')

const variants = [
  { key: 'whale', fill: '#4D6BFE' },      // official brand blue
  { key: 'whale_dark', fill: '#1B2A4A' }, // deep navy for light home screens
  { key: 'whale_teal', fill: '#0F766E' }, // teal
  { key: 'whale_mono', fill: '#3C4043' }, // neutral grey
  { key: 'whale_black', fill: '#111111' }, // pure black
  { key: 'whale_white', fill: '#F2F2F2', bg: '#171A1F' }, // near-white on dark badge
]
const densities = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 }

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
})
const page = await browser.newPage()
for (const v of variants) {
  const colored = svg.replace('fill="#4D6BFE"', `fill="${v.fill}"`)
  const data = Buffer.from(colored).toString('base64')
  const badgeStyle = v.bg ? `background:${v.bg};border-radius:${Math.round(192 * 0.22)}px;` : ''
  for (const [density, px] of Object.entries(densities)) {
    // Render at 2x for crispness then we still save at target px (Chrome screenshot scale 1 is fine at these sizes)
    await page.setViewportSize({ width: px, height: px })
    await page.setContent(`<body style="margin:0;background:transparent;display:grid;place-items:center;width:${px}px;height:${px}px">
      <div style="width:${px}px;height:${px}px;${badgeStyle}display:grid;place-items:center">
        <div style="width:${Math.round(px * 0.74)}px;height:${Math.round(px * 0.74 * 17.04 / 23.16)}px">
          <img src="data:image/svg+xml;base64,${data}" style="display:block;width:100%;height:100%">
        </div>
      </div></body>`)
    // screenshot with omitBackground for transparency
    const buf = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } })
    writeFileSync(`${outRoot}/mipmap-${density}/ic_launcher_${v.key}.png`, buf)
  }
  console.log(`rendered variant ${v.key} (${v.fill})`)
}
await browser.close()
console.log('done')
