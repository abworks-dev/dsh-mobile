import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { createContext, runInContext, type Context } from 'node:vm'
import { build } from 'tsdown'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mobileCompatibilityBuild } from '../tsdown.config.js'
import { ensureMobileCompatibility, MOBILE_COMPAT_PATH } from '../src/mobile-compat-bootstrap.js'

let directory: string
let bundle: string
let nativeShim: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-compat-'))
  await build({ ...mobileCompatibilityBuild, config: false, outDir: directory, sourcemap: false })
  bundle = await readFile(join(directory, 'mobile-compat.js'), 'utf8')
  const source = await readFile(join(import.meta.dirname, '../apps/mobile/android/app/src/main/java/io/github/sayach/dshmobile/WebViewCompatibilityShim.kt'), 'utf8')
  const match = /internal const val BROWSER_COMPATIBILITY_SHIM = """([\s\S]*?)"""/u.exec(source)
  if (match?.[1] === undefined) throw new Error('Android document-start source was not found')
  nativeShim = match[1]
})

afterAll(async () => {
  if (directory === undefined) return
  const withinTemp = relative(tmpdir(), directory)
  if (!withinTemp || withinTemp.startsWith('..') || isAbsolute(withinTemp)) throw new Error('unsafe test cleanup path')
  await rm(directory, { recursive: true, force: true })
})

function legacyPage(): Context {
  const signal = class PageAbortSignal extends AbortSignal {}
  Object.defineProperty(signal, 'any', { value: undefined, writable: true, configurable: true })
  for (const name of ['aborted', 'reason']) {
    const descriptor = Object.getOwnPropertyDescriptor(AbortSignal.prototype, name)
    if (descriptor === undefined) throw new Error(`Native AbortSignal.${name} getter was not found`)
    Object.defineProperty(signal.prototype, name, descriptor)
  }
  const page = createContext({ AbortSignal: signal, AbortController, Event, EventTarget })
  runInContext('var intrinsicIterator = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())); ' +
    'for (var key of Reflect.ownKeys(intrinsicIterator)) { if (key !== Symbol.iterator) delete intrinsicIterator[key]; } ' +
    'delete globalThis.Iterator; delete Promise.withResolvers;', page)
  return page
}

function load(page: Context): void {
  runInContext(bundle, page, { timeout: 5_000 })
}

describe('early WebView Iterator compatibility', () => {
  it('reproduces the missing global and fixes the actual standalone browser bundle without a DSH module loader', () => {
    const page = legacyPage()
    expect(() => runInContext('Iterator.from([1, 2, 3])', page)).toThrow('Iterator is not defined')
    load(page)
    expect(runInContext('typeof Iterator', page)).toBe('function')
    expect(runInContext('typeof __ModuleLoader__', page)).toBe('undefined')
    expect(runInContext('Iterator.from([1, 2, 3, 4]).filter(x => x % 2 === 0).map(x => x * 2).take(2).toArray()', page)).toEqual([4, 8])
    expect(runInContext('Iterator.from([1, 2, 3]).reduce((sum, x) => sum + x, 0)', page)).toBe(6)
    expect(Buffer.byteLength(bundle)).toBeLessThan(256 * 1024)
  })

  it('installs real prototype helpers on built-in iterators and Iterator subclasses', () => {
    const page = legacyPage()
    load(page)
    expect(runInContext('[1, 2, 3].values().map(x => x + 1).toArray()', page)).toEqual([2, 3, 4])
    expect(runInContext('new Map([[1, "a"], [2, "b"]]).values().join("-")', page)).toBe('a-b')
    expect(runInContext('(class extends Iterator { value = 0; next() { return { value: ++this.value, done: false }; } })', page)).toBeTypeOf('function')
    expect(runInContext('new (class extends Iterator { value = 0; next() { return { value: ++this.value, done: false }; } })().take(3).toArray()', page)).toEqual([1, 2, 3])
    expect(runInContext('Object.getOwnPropertyDescriptor(Iterator.prototype, "map").enumerable', page)).toBe(false)
  })

  it('retains lazy evaluation, iterator closing, and callback errors instead of using an Array.from shim', () => {
    const page = legacyPage()
    load(page)
    expect(runInContext('var calls = 0; var lazy = Iterator.from([1, 2, 3]).map(x => { calls++; return x; }); calls', page)).toBe(0)
    expect(runInContext('lazy.next().value', page)).toBe(1)
    expect(runInContext('calls', page)).toBe(1)
    expect(runInContext('var closed = false; function* source() { try { yield 1; yield 2; } finally { closed = true; } } source().take(1).toArray(); closed', page)).toBe(true)
    expect(() => runInContext('Iterator.from([1]).map(() => { throw new Error("callback failed"); }).toArray()', page)).toThrow('callback failed')
    expect(() => runInContext('Iterator.from([]).reduce((a, b) => a + b)', page)).toThrow()
  })

  it('keeps the native constructor while feature-detecting helpers and is safe to load twice', () => {
    const page = createContext({})
    const nativeIterator = runInContext('Iterator', page)
    load(page)
    expect(runInContext('Iterator', page)).toBe(nativeIterator)
    // Older native helpers fail to close on an invalid callback (ECMA-262 #3467).
    // core-js deliberately repairs those helpers; function identity is not the contract.
    expect(runInContext('var closedOnError = false; try { Iterator.prototype.map.call({ next() { return { done: true }; }, return() { closedOnError = true; return { done: true }; } }, -1); } catch (error) { if (!(error instanceof TypeError)) throw error; } closedOnError', page)).toBe(true)
    const installedMap = runInContext('Iterator.prototype.map', page)
    load(page)
    expect(runInContext('Iterator', page)).toBe(nativeIterator)
    expect(runInContext('Iterator.prototype.map', page)).toBe(installedMap)
    expect(runInContext('[1, 2].values().map(x => x * 2).join(",")', page)).toBe('2,4')
  })

  it('runs before even the first DSH boot script and preserves preceding CSP metadata and its nonce', () => {
    const input = '<html><head><meta http-equiv="Content-Security-Policy" content="script-src \'nonce-test\'">' +
      '<script nonce="test">globalThis.bootResult = Iterator.from([1, 2]).join(",");</script>' +
      '<script src="/bootstrap.js"></script></head></html>'
    const output = ensureMobileCompatibility(input)
    expect(output).toContain('<script src="' + MOBILE_COMPAT_PATH + '" nonce="test"></script><script nonce="test">')
    expect(output.indexOf('Content-Security-Policy')).toBeLessThan(output.indexOf(MOBILE_COMPAT_PATH))
    expect(output).not.toMatch(/<script[^>]+(?:async|defer)/u)
    expect(ensureMobileCompatibility(output)).toBe(output)
    const page = legacyPage()
    for (const script of output.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gu)) {
      if (script[1]?.includes(MOBILE_COMPAT_PATH)) load(page)
      else if (script[2]) runInContext(script[2], page)
    }
    expect(runInContext('bootResult', page)).toBe('1,2')
  })

  it('accepts a single-quoted nonce and leaves an index with no script usable', () => {
    expect(ensureMobileCompatibility("<script nonce='test'>boot()</script>")).toContain('nonce="test"></script><script')
    // The bundle is an enhancement: a document it cannot be placed in must still be
    // served, because throwing here took the whole mobile frontend down with a 502.
    const headless = '<html><head><title>no scripts</title></head></html>'
    expect(ensureMobileCompatibility(headless)).toBe(headless)
  })

  it('never anchors to markup that an HTML comment made inert', () => {
    // Injecting into the comment would place the bundle in text that never runs, so
    // the fix would silently not apply while the page still looked fine.
    const commented = '<!-- <script src="/a.js"></script> --><html><body></body></html>'
    expect(ensureMobileCompatibility(commented)).toBe(commented)
    // With a live script later in the document, that one becomes the anchor instead.
    const mixed = '<!-- <script src="/a.js"></script> --><script src="/b.js"></script>'
    const output = ensureMobileCompatibility(mixed)
    expect(output).toContain(`<script src="/b.js"></script>`)
    expect(output.indexOf(MOBILE_COMPAT_PATH)).toBeGreaterThan(output.indexOf('-->'))
  })

  it('treats an already-injected bundle as present whatever quoting the document uses', () => {
    const single = `<html><script src='${MOBILE_COMPAT_PATH}'></script></html>`
    expect(ensureMobileCompatibility(single)).toBe(single)
    const spaced = `<html><script  src = "${MOBILE_COMPAT_PATH}" ></script></html>`
    expect(ensureMobileCompatibility(spaced)).toBe(spaced)
  })

  it('reads the real nonce instead of text that merely resembles one', () => {
    // A value that contains the attribute text must not be mistaken for the attribute.
    const decoy = `<script title='say nonce="fake"' nonce="real"></script>`
    expect(ensureMobileCompatibility(decoy)).toContain(`<script src="${MOBILE_COMPAT_PATH}" nonce="real"></script>`)
    const after = `<script nonce="real" data-nonce="decoy"></script>`
    expect(ensureMobileCompatibility(after)).toContain(`nonce="real"`)
  })
})

describe('early Promise capabilities', () => {
  for (const mode of ['bundle', 'Android document-start'] as const) {
    const install = (page: Context): void => { runInContext(mode === 'bundle' ? bundle : nativeShim, page) }

    it(`${mode} preserves constructor receivers, settlements and non-enumerable properties`, async () => {
      const page = legacyPage()
      install(page)
      expect(runInContext('class P extends Promise {}; P.withResolvers().promise instanceof P', page)).toBe(true)
      expect(() => runInContext('Promise.withResolvers.call({})', page)).toThrow()
      expect(() => runInContext('Promise.withResolvers.call(function () {})', page)).toThrow()
      expect(() => runInContext('Promise.withResolvers.call(function (executor) { executor(1, 2); })', page)).toThrow()
      expect(runInContext('Object.getOwnPropertyDescriptor(Promise, "withResolvers").enumerable', page)).toBe(false)
      expect(runInContext('Object.getOwnPropertyDescriptor(Promise, "withResolvers").writable', page)).toBe(true)
      await expect(runInContext('var fulfilled = Promise.withResolvers(); fulfilled.resolve(17); fulfilled.promise', page)).resolves.toBe(17)
      await expect(runInContext('var rejected = Promise.withResolvers(); rejected.reject("cancelled"); rejected.promise', page)).rejects.toBe('cancelled')
      const installed = runInContext('Promise.withResolvers', page)
      install(page)
      expect(runInContext('Promise.withResolvers', page)).toBe(installed)
      expect(runInContext('var bootReady = Promise.withResolvers(); typeof bootReady.resolve', page)).toBe('function')
    })

    it(`${mode} leaves native capabilities unchanged`, () => {
      const page = createContext({})
      const native = runInContext('Promise.withResolvers', page)
      install(page)
      expect(runInContext('Promise.withResolvers', page)).toBe(native)
    })
  }
})

describe('early AbortSignal composition', () => {
  it('accepts iterables, validates the complete sequence and retains first-aborted ordering', () => {
    const page = legacyPage()
    load(page)
    expect(runInContext('var first = new AbortController(); var second = new AbortController(); first.abort("first"); second.abort("second"); AbortSignal.any(new Set([second.signal, first.signal])).reason', page)).toBe('second')
    expect(runInContext('AbortSignal.any((function* () { yield first.signal; })()).reason', page)).toBe('first')
    expect(runInContext('AbortSignal.any([]).aborted', page)).toBe(false)
    for (const input of ['null', '{}', '[first.signal, {}]', '[{ aborted: false, addEventListener() {} }]']) {
      expect(() => runInContext(`AbortSignal.any(${input})`, page)).toThrow()
    }
    expect(runInContext('Object.getOwnPropertyDescriptor(AbortSignal, "any").enumerable', page)).toBe(false)
    expect(runInContext('var pending = new AbortController(); var iterable = AbortSignal.any(new Set([pending.signal])); pending.abort("iterable"); iterable.reason', page)).toBe('iterable')
    expect(runInContext('var closed = false; try { AbortSignal.any((function* () { try { yield {}; throw new Error("must not advance"); } finally { closed = true; } })()); } catch (error) {} closed', page)).toBe(true)
  })

  it('aborts synchronously with exact reason identity and detaches every source listener', () => {
    const page = legacyPage()
    load(page)
    expect(runInContext(`
      var sources = [new AbortController(), new AbortController()];
      var added = 0, removed = 0;
      for (var source of sources) {
        var signal = source.signal;
        signal.addEventListener = function (...args) { added++; return EventTarget.prototype.addEventListener.apply(this, args); };
        signal.removeEventListener = function (...args) { removed++; return EventTarget.prototype.removeEventListener.apply(this, args); };
      }
      var result = AbortSignal.any([sources[0].signal, sources[1].signal, sources[0].signal]);
      var events = 0, reason = {};
      result.addEventListener('abort', () => events++);
      sources[1].abort(reason);
      sources[0].abort('later');
      [result.aborted, result.reason === reason, events, added, removed];
    `, page)).toEqual([true, true, 1, 2, 2])
  })

  it('ignores synthetic abort events without consuming the real cancellation listener', () => {
    const page = legacyPage()
    load(page)
    expect(runInContext('var source = new AbortController(); var result = AbortSignal.any([source.signal]); source.signal.dispatchEvent(new Event("abort")); result.aborted', page)).toBe(false)
    expect(runInContext('source.abort("actual"); result.reason', page)).toBe('actual')
  })

  it('accepts native signals from another realm and does not mutate the process constructor', () => {
    const native = AbortSignal.any
    const page = legacyPage()
    const other = new AbortController()
    page.otherSignal = other.signal
    load(page)
    expect(runInContext('var result = AbortSignal.any([otherSignal]); result.aborted', page)).toBe(false)
    other.abort('other realm')
    expect(runInContext('result.reason', page)).toBe('other realm')
    expect(AbortSignal.any).toBe(native)
  })

  it('does not replace native composition and remains stable after a second load', () => {
    const nativePage = createContext({ AbortSignal, AbortController })
    load(nativePage)
    expect(runInContext('AbortSignal.any', nativePage)).toBe(AbortSignal.any)
    const legacy = legacyPage()
    load(legacy)
    const installed = runInContext('AbortSignal.any', legacy)
    load(legacy)
    expect(runInContext('AbortSignal.any', legacy)).toBe(installed)
  })

  it('still composes and detaches sources when weak-reference APIs are absent', () => {
    const page = legacyPage()
    runInContext('delete globalThis.WeakRef; delete globalThis.FinalizationRegistry;', page)
    load(page)
    expect(runInContext('var source = new AbortController(); var removed = 0; source.signal.removeEventListener = function (...args) { removed++; return EventTarget.prototype.removeEventListener.apply(this, args); }; var result = AbortSignal.any([source.signal]); source.abort("fallback"); [result.reason, removed]', page)).toEqual(['fallback', 1])
  })
})
