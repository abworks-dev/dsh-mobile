import { describe, expect, it } from 'vitest'
import {
  renderLoginPage,
  renderLoginScript,
  renderPairPage,
  renderPairScript,
  resolveAuthPageLocale,
} from '../src/auth-pages.js'

describe('browser authentication page localization', () => {
  it('negotiates the supported languages and falls back to English', () => {
    expect(resolveAuthPageLocale('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh')
    expect(resolveAuthPageLocale('it-IT,en-US;q=0.8')).toBe('it')
    expect(resolveAuthPageLocale('en-US;q=0.5,zh-CN;q=0.9')).toBe('zh')
    expect(resolveAuthPageLocale('zh-CN;q=0,en-US;q=0.8')).toBe('en')
    expect(resolveAuthPageLocale('fr-FR,de;q=0.8')).toBe('en')
    expect(resolveAuthPageLocale(undefined)).toBe('en')
  })

  it('renders the pairing form and script in the negotiated language', () => {
    const page = renderPairPage('zh')
    const script = renderPairScript('it')

    expect(page).toContain('<html lang="zh-CN">')
    expect(page).toContain('配对码')
    expect(page).toContain('配对')
    expect(script).toContain('Abbinamento…')
    expect(script).toContain('Abbinamento non riuscito')
    expect(script).toContain("/mobile-access/auth/pair")
  })

  it('renders localized reauthentication failure guidance', () => {
    const page = renderLoginPage('it')
    const script = renderLoginScript('zh')

    expect(page).toContain('<html lang="it-IT">')
    expect(page).toContain('Riconnetti questo dispositivo')
    expect(script).toContain('电脑当前不可用。')
    expect(script).toContain("/mobile-access/auth/renew")
  })
})
