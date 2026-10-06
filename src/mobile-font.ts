/** Device-local typography for authenticated mobile pages, without Host settings writes. */
import { createElement, useSyncExternalStore } from 'react'

export const MOBILE_FONT_STORAGE_KEY = 'dsh-mobile.content-font-size.v1'
export const DEFAULT_MOBILE_FONT_SIZE = 16
export const MIN_MOBILE_FONT_SIZE = 12
export const MAX_MOBILE_FONT_SIZE = 32

/** Read one local storage value; malformed or unavailable preferences use the mobile default. */
export function parseMobileFontSize(value: string | null): number {
  if (value === null || !/^\d+$/.test(value)) return DEFAULT_MOBILE_FONT_SIZE
  const size = Number(value)
  return Number.isInteger(size) && size >= MIN_MOBILE_FONT_SIZE && size <= MAX_MOBILE_FONT_SIZE
    ? size : DEFAULT_MOBILE_FONT_SIZE
}

/** Local preference storage; unavailable browser storage still permits in-page adjustment. */
export class MobileFontPreference {
  private size = DEFAULT_MOBILE_FONT_SIZE
  private readonly listeners = new Set<() => void>()

  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null) {
    try { this.size = parseMobileFontSize(storage?.getItem(MOBILE_FONT_STORAGE_KEY) ?? null) }
    catch (error) { /* Private or restricted storage keeps the in-page default. */ }
  }

  getSnapshot = (): number => this.size
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Apply a user-selected size locally; never send it to DSH's settings RPC. */
  set(size: number): void {
    if (!Number.isInteger(size) || size < MIN_MOBILE_FONT_SIZE || size > MAX_MOBILE_FONT_SIZE) {
      throw new RangeError('Mobile font size must be an integer from 12 to 32')
    }
    if (this.size === size) return
    this.size = size
    try { this.storage?.setItem(MOBILE_FONT_STORAGE_KEY, String(size)) }
    catch (error) { /* Adjust the current page even when persistence is unavailable. */ }
    for (const listener of this.listeners) listener()
  }
}

/** Keep mobile typography independent from Host theme changes, including body-level portals. */
export function installMobileFontPreference(): { preference: MobileFontPreference; dispose: () => void } {
  let storage: Storage | null = null
  try { storage = window.localStorage }
  catch (error) { /* Some browser privacy modes deny access to localStorage entirely. */ }
  const preference = new MobileFontPreference(storage)
  const property = '--dsh-content-font-size'
  let previous = document.body.style.getPropertyValue(property)
  let previousPriority = document.body.style.getPropertyPriority(property)
  let ownedValue: string | undefined
  const apply = (): void => {
    const current = document.body.style.getPropertyValue(property)
    if (ownedValue !== undefined && current !== ownedValue) {
      previous = current
      previousPriority = document.body.style.getPropertyPriority(property)
    }
    const value = `${preference.getSnapshot()}px`
    ownedValue = value
    if (current !== value) document.body.style.setProperty(property, value)
  }
  apply()
  const unsubscribe = preference.subscribe(apply)
  const observer = new MutationObserver(apply)
  observer.observe(document.body, { attributes: true, attributeFilter: ['style'] })
  return { preference, dispose: () => {
    observer.disconnect()
    unsubscribe()
    if (previous === '') document.body.style.removeProperty(property)
    else document.body.style.setProperty(property, previous, previousPriority)
  } }
}

const messages = {
  zh: { title: '移动端字号', description: '仅保存在当前访问地址的本地数据中，不影响电脑或其他设备。', decrease: '减小移动端字号', increase: '增大移动端字号' },
  en: { title: 'Mobile font size', description: 'Saved locally for this address, without changing your computer or other devices.', decrease: 'Decrease mobile font size', increase: 'Increase mobile font size' },
  it: { title: 'Dimensione testo mobile', description: 'Salvata localmente per questo indirizzo, senza modificare il computer o altri dispositivi.', decrease: 'Riduci il testo mobile', increase: 'Aumenta il testo mobile' },
} as const

/** General settings row matching the existing Mobile controls and DSH theme tokens. */
export function MobileFontSizeRow({ preference, locale }: { preference: MobileFontPreference; locale: keyof typeof messages }) {
  const size = useSyncExternalStore(preference.subscribe, preference.getSnapshot)
  const copy = messages[locale]
  return createElement('div', { className: 'dsh-mobile-settings_row', lang: locale, 'data-mobile-font-setting': true },
    createElement('div', { className: 'dsh-mobile-settings_rowText' },
      createElement('div', { className: 'dsh-mobile-settings_title' }, copy.title),
      createElement('div', { className: 'dsh-mobile-settings_desc' }, copy.description)),
    createElement('div', { className: 'dsh-mobile-settings_fontControls' },
      createElement('button', { type: 'button', className: 'dsh-mobile-settings_selector', 'aria-label': copy.decrease,
        disabled: size === MIN_MOBILE_FONT_SIZE, onClick: () => { preference.set(size - 1) } }, '−'),
      createElement('output', { 'aria-live': 'polite', 'aria-label': copy.title }, `${size}px`),
      createElement('button', { type: 'button', className: 'dsh-mobile-settings_selector', 'aria-label': copy.increase,
        disabled: size === MAX_MOBILE_FONT_SIZE, onClick: () => { preference.set(size + 1) } }, '+')))
}
