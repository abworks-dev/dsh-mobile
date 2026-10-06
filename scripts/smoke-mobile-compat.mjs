import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const bundleUrl = new URL('../lib/mobile-compat.js', import.meta.url)
const bundle = await readFile(bundleUrl, 'utf8')
const source = await readFile(new URL('../apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/WebViewCompatibilityShim.kt', import.meta.url), 'utf8')
const shim = /internal const val BROWSER_COMPATIBILITY_SHIM = """([\s\S]*?)"""/u.exec(source)?.[1]
assert.notEqual(shim, undefined, 'Android document-start source was not found')

const browser = await chromium.launch({ headless: true })
try {
  for (const mode of ['bundle', 'Android document-start']) {
    const page = await browser.newPage()
    await page.addInitScript(() => {
      delete Promise.withResolvers
      delete AbortSignal.any
      delete globalThis.Iterator
      globalThis.compatMissingAtStart = [typeof Promise.withResolvers, typeof AbortSignal.any, typeof Iterator]
    })
    await page.route('https://compat.test/**', route => {
      const pathname = new URL(route.request().url()).pathname
      return pathname === '/compat.js'
        ? route.fulfill({ contentType: 'text/javascript', body: mode === 'bundle' ? bundle : shim })
        : route.fulfill({ contentType: 'text/html', body: '<!doctype html><script src="/compat.js"></script><script>globalThis.bootReady = Promise.withResolvers(); bootReady.resolve("ready");</script>' })
    })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto('https://compat.test/', { waitUntil: 'load' })
    assert.deepEqual(await page.evaluate(() => compatMissingAtStart), ['undefined', 'undefined', 'undefined'])
    assert.equal(await page.evaluate(() => bootReady.promise), 'ready')
    const promise = await page.evaluate(async () => {
      class P extends Promise {}
      const subclass = P.withResolvers().promise instanceof P
      const invalid = []
      for (const constructor of [{}, function () {}, function (executor) { executor(1, 2) }]) {
        try { Promise.withResolvers.call(constructor); invalid.push(false) } catch (error) { invalid.push(error instanceof TypeError) }
      }
      const result = Promise.withResolvers()
      result.resolve('settled')
      const rejected = Promise.withResolvers()
      const rejection = rejected.promise.catch(reason => reason)
      rejected.reject('rejected')
      return { subclass, invalid, value: await result.promise, rejected: await rejection, enumerable: Object.getOwnPropertyDescriptor(Promise, 'withResolvers').enumerable }
    })
    assert.deepEqual(promise, { subclass: true, invalid: [true, true, true], value: 'settled', rejected: 'rejected', enumerable: false })
    if (mode === 'bundle') {
      const signal = await page.evaluate(() => {
        const left = new AbortController(), right = new AbortController()
        let added = 0, removed = 0, events = 0
        for (const source of [left.signal, right.signal]) {
          const add = source.addEventListener, remove = source.removeEventListener
          source.addEventListener = function (...args) { added++; return add.apply(this, args) }
          source.removeEventListener = function (...args) { removed++; return remove.apply(this, args) }
        }
        const combined = AbortSignal.any(new Set([left.signal, right.signal]))
        combined.addEventListener('abort', () => events++)
        left.signal.dispatchEvent(new Event('abort'))
        const syntheticIgnored = !combined.aborted
        const reason = { message: 'cancelled' }
        right.abort(reason)
        left.abort('later')
        const invalid = []
        for (const input of [null, {}, [AbortSignal.abort('early'), {}], [{ aborted: false, addEventListener() {} }]]) {
          try { AbortSignal.any(input); invalid.push(false) } catch (error) { invalid.push(error instanceof TypeError) }
        }
        const first = AbortSignal.abort('first'), second = AbortSignal.abort('second')
        const generatorReason = AbortSignal.any((function* () { yield second; yield first })()).reason
        const iframe = document.createElement('iframe')
        document.body.append(iframe)
        const crossRealmSource = new iframe.contentWindow.AbortController()
        const crossRealmResult = AbortSignal.any([crossRealmSource.signal])
        crossRealmSource.abort('other frame')
        iframe.remove()
        return {
          syntheticIgnored, aborted: combined.aborted, sameReason: combined.reason === reason,
          added, removed, events, invalid, generatorReason, crossRealmReason: crossRealmResult.reason,
          emptyPending: !AbortSignal.any([]).aborted,
          enumerable: Object.getOwnPropertyDescriptor(AbortSignal, 'any').enumerable,
          iterator: Iterator.from([1, 2, 3]).map(value => value * 2).join(','),
        }
      })
      assert.deepEqual(signal, {
        syntheticIgnored: true, aborted: true, sameReason: true, added: 2, removed: 2, events: 1,
        invalid: [true, true, true, true], generatorReason: 'second', crossRealmReason: 'other frame',
        emptyPending: true, enumerable: false, iterator: '2,4,6',
      })
    }
    const installed = await page.evaluate(() => {
      globalThis.installedPromise = Promise.withResolvers
      globalThis.installedAny = AbortSignal.any
      return typeof installedPromise
    })
    assert.equal(installed, 'function')
    await page.addScriptTag({ content: mode === 'bundle' ? bundle : shim })
    assert.equal(await page.evaluate(() => installedPromise === Promise.withResolvers && installedAny === AbortSignal.any), true)
    assert.deepEqual(errors, [])
    await page.close()
    console.log(`${mode}: missing-API boot, Promise capabilities and idempotence passed${mode === 'bundle' ? '; real browser cancellation, iframe signals and listener cleanup passed' : ''}`)
  }
  const native = await browser.newPage()
  await native.goto('about:blank')
  await native.evaluate(() => { globalThis.originalPromise = Promise.withResolvers; globalThis.originalAny = AbortSignal.any })
  await native.addScriptTag({ content: bundle })
  await native.addScriptTag({ content: shim })
  assert.equal(await native.evaluate(() => originalPromise === Promise.withResolvers && originalAny === AbortSignal.any), true)
  await native.close()
  console.log('Native browser Promise and AbortSignal implementations remained unchanged')
} finally {
  await browser.close()
}

// Optional observation only: scheduling garbage collection is not a CI timing gate.
if (process.argv.includes('--gc')) {
  const result = spawnSync(process.execPath, ['--expose-gc', '--input-type=module', '-e', `
    import { readFileSync } from 'node:fs';
    import { createContext, runInContext } from 'node:vm';
    const signal = class PageAbortSignal extends AbortSignal {};
    Object.defineProperty(signal, 'any', { value: undefined, configurable: true });
    for (const name of ['aborted', 'reason']) Object.defineProperty(signal.prototype, name, Object.getOwnPropertyDescriptor(AbortSignal.prototype, name));
    const page = createContext({ AbortSignal: signal, AbortController, EventTarget });
    runInContext(readFileSync(${JSON.stringify(fileURLToPath(bundleUrl))}, 'utf8'), page);
    runInContext('var source = new AbortController(); var removed = 0; source.signal.removeEventListener = function (...args) { removed++; return EventTarget.prototype.removeEventListener.apply(this, args); }; var result = AbortSignal.any([source.signal]); var reference = new WeakRef(result); result = null;', page);
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      global.gc();
      if (runInContext('removed', page) === 1) { console.log('GC observation: unreachable combined signal released its source listener'); process.exit(0); }
    }
    console.log('GC observation inconclusive: finalizer scheduling did not complete within this run');
  `], { encoding: 'utf8', timeout: 15_000 })
  if (result.error !== undefined) throw result.error
  assert.equal(result.status, 0, result.stderr)
  process.stdout.write(result.stdout)
}
