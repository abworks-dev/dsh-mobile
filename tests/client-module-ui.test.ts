import { describe, expect, it } from 'vitest'
import { CLIENT_MODULE_COPY, CLIENT_MODULE_STYLES, parseClientModuleView } from '../src/client-module-ui.js'

describe('client module settings response', () => {
  const catalog = { source: 'device', excludedClientModules: ['optional'], entries: [
    { id: 'core', required: true, dependencies: [] },
    { id: 'optional', required: false, dependencies: ['core'] },
  ] }
  it('retains the required marker, exact module ids and dependencies', () => {
    expect(parseClientModuleView(catalog)).toEqual(catalog)
  })
  it('rejects malformed wire values before making choices interactive', () => {
    for (const value of [null, {}, { ...catalog, source: 'admin' }, { ...catalog, entries: [null] }, { ...catalog, entries: [{ id: 'x', required: 'yes', dependencies: [] }] }, { ...catalog, excludedClientModules: [null] }, { ...catalog, entries: [{ id: 'x', required: false, dependencies: [{}] }] }]) {
      expect(() => parseClientModuleView(value)).toThrow('invalid_module_catalog')
    }
  })
  it('has the same controls and copy in each supported locale', () => {
    const keys = Object.keys(CLIENT_MODULE_COPY.en).sort()
    for (const locale of ['zh', 'it'] as const) {
      expect(Object.keys(CLIENT_MODULE_COPY[locale]).sort()).toEqual(keys)
      expect(Object.values(CLIENT_MODULE_COPY[locale]).every(value => value.length > 0)).toBe(true)
    }
  })
  it('keeps long module names shrinkable and actions touch-sized', () => {
    expect(CLIENT_MODULE_STYLES).toContain('min-height:48px')
    expect(CLIENT_MODULE_STYLES).toContain('min-width:0;overflow-wrap:anywhere')
    expect(CLIENT_MODULE_STYLES).toContain('max-height:calc(100dvh - 32px)')
  })
})
