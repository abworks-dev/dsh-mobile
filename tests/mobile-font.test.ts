import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_MOBILE_FONT_SIZE, MOBILE_FONT_STORAGE_KEY, MobileFontPreference, parseMobileFontSize } from '../src/mobile-font.js'

describe('mobile font preference', () => {
  it('defaults locally instead of inheriting a Host preference', () => {
    expect(new MobileFontPreference(null).getSnapshot()).toBe(16)
    for (const value of [null, '', '20px', '-1', '33', '11', '16.5', 'Infinity']) expect(parseMobileFontSize(value)).toBe(DEFAULT_MOBILE_FONT_SIZE)
    expect(parseMobileFontSize('20')).toBe(20)
  })

  it('persists local changes and restores them without Host RPCs', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const preference = new MobileFontPreference(storage)
    const listener = vi.fn()
    const unsubscribe = preference.subscribe(listener)
    preference.set(20)
    expect(values.get(MOBILE_FONT_STORAGE_KEY)).toBe('20')
    expect(new MobileFontPreference(storage).getSnapshot()).toBe(20)
    expect(listener).toHaveBeenCalledTimes(1)
    preference.set(20)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    preference.set(18)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps controls usable when storage is denied', () => {
    const storage = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') } }
    const preference = new MobileFontPreference(storage)
    expect(preference.getSnapshot()).toBe(16)
    preference.set(22)
    expect(preference.getSnapshot()).toBe(22)
  })

  it('rejects malformed sizes without changing the saved preference', () => {
    const preference = new MobileFontPreference(null)
    for (const size of [11, 33, 16.5, NaN, Infinity]) expect(() => preference.set(size)).toThrow(RangeError)
    expect(preference.getSnapshot()).toBe(16)
  })
})
