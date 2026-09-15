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

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-compat-'))
  await build({ ...mobileCompatibilityBuild, config: false, outDir: directory, sourcemap: false })
  bundle = await readFile(join(directory, 'mobile-compat.js'), 'utf8')
})

afterAll(async () => {
  if (directory === undefined) return
  const withinTemp = relative(tmpdir(), directory)
  if (!withinTemp || withinTemp.startsWith('..') || isAbsolute(withinTemp)) throw new Error('unsafe test cleanup path')
  await rm(directory, { recursive: true, force: true })
})

function legacyPage(): Context {
  const page = createContext({})
  runInContext('var intrinsicIterator = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())); ' +
    'for (var key of Reflect.ownKeys(intrinsicIterator)) { if (key !== Symbol.iterator) delete intrinsicIterator[key]; } ' +
    'delete globalThis.Iterator;', page)
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

  it('accepts a single-quoted nonce and refuses an index without a script', () => {
    expect(ensureMobileCompatibility("<script nonce='test'>boot()</script>")).toContain("nonce='test'></script><script")
    expect(() => ensureMobileCompatibility('<html><head></head></html>')).toThrow('no script')
  })
})
