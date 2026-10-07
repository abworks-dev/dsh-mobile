/** Device-local module selection and the computer's defaults share a read-only catalog. */
import { createElement, type ReactElement } from 'react'
import { localAdminRequestHeaders } from './local-admin-host.js'
import type { MobileControlLocale } from './client-messages.js'

export const CLIENT_MODULE_COPY = {
  zh: { title: '移动页面模块', computer: '为移动访问设置默认加载模块，不卸载电脑上的插件。', device: '只为本设备选择加载模块，不改变其他手机或电脑。', open: '管理', loading: '正在读取模块…', hint: '勾选表示加载。启动必需的模块不能取消；依赖冲突会在保存时说明。', save: '保存，下次打开生效', reset: '恢复默认', close: '关闭', required: '启动必需', dependencies: '依赖：', saved: '已保存，不会自动刷新当前页面。重新打开 DSH 后生效。', failed: '暂时无法完成。请确认移动访问已启用，或检查下面的依赖冲突。', conflict: '无法保存：', computerSource: '使用电脑默认设置', deviceSource: '使用本设备设置', resetConfirm: '恢复默认模块选择？不会重新加载当前会话。' },
  en: { title: 'Mobile page modules', computer: 'Choose default modules for mobile access without uninstalling computer plugins.', device: 'Choose modules for this device only; other phones and computers are unchanged.', open: 'Manage', loading: 'Reading modules…', hint: 'Checked means loaded. Required boot modules cannot be unchecked; saving explains dependency conflicts.', save: 'Save for next open', reset: 'Restore defaults', close: 'Close', required: 'Required for boot', dependencies: 'Depends on: ', saved: 'Saved. This page is not reloaded automatically. Reopen DSH to apply.', failed: 'Could not complete this operation. Enable mobile access or check the dependency conflict below.', conflict: 'Could not save: ', computerSource: 'Using computer defaults', deviceSource: 'Using this device’s settings', resetConfirm: 'Restore default module selection? The current conversation will not reload.' },
  it: { title: 'Moduli della pagina mobile', computer: 'Scegli i moduli predefiniti senza disinstallare i plugin del computer.', device: 'Scegli i moduli solo per questo dispositivo, senza cambiare gli altri.', open: 'Gestisci', loading: 'Lettura dei moduli…', hint: 'Selezionato significa caricato. I moduli obbligatori non possono essere rimossi; il salvataggio mostra i conflitti.', save: 'Salva per la prossima apertura', reset: 'Ripristina predefiniti', close: 'Chiudi', required: 'Obbligatorio', dependencies: 'Dipende da: ', saved: 'Salvato. La pagina non viene ricaricata automaticamente. Riapri DSH per applicare.', failed: 'Operazione non completata. Abilita accesso mobile o controlla il conflitto sotto.', conflict: 'Impossibile salvare: ', computerSource: 'Predefiniti del computer', deviceSource: 'Impostazioni del dispositivo', resetConfirm: 'Ripristinare i moduli predefiniti? La conversazione attuale non verrà ricaricata.' },
} as const

export interface ClientModuleRow {
  readonly id: string
  readonly required: boolean
  readonly dependencies: readonly string[]
}
interface ClientModuleView {
  readonly entries: readonly ClientModuleRow[]
  readonly excludedClientModules: readonly string[]
  readonly source: 'device' | 'computer' | 'plugin'
}

class ClientModuleUiConflict extends Error {
  constructor(readonly detail: string) { super('client_module_conflict') }
}

/** Validate catalog response fields before creating interactive controls.
 * @param value - Gateway or computer-admin JSON response.
 * @returns The fields used by the module-selection dialog.
 */
export function parseClientModuleView(value: unknown): ClientModuleView {
  if (typeof value !== 'object' || value === null || !('entries' in value) || !Array.isArray(value.entries)
    || !('excludedClientModules' in value) || !Array.isArray(value.excludedClientModules)
    || !('source' in value) || !['device', 'computer', 'plugin'].includes(String(value.source))) throw new Error('invalid_module_catalog')
  const entries = value.entries.map((entry: unknown): ClientModuleRow => {
    if (typeof entry !== 'object' || entry === null || !('id' in entry) || typeof entry.id !== 'string'
      || !('required' in entry) || typeof entry.required !== 'boolean' || !('dependencies' in entry) || !Array.isArray(entry.dependencies)) throw new Error('invalid_module_catalog')
    const dependencies = entry.dependencies.map((dependency: unknown): string => {
      if (typeof dependency !== 'string') throw new Error('invalid_module_catalog')
      return dependency
    })
    return { id: entry.id, required: entry.required, dependencies }
  })
  const excludedClientModules = value.excludedClientModules.map((id: unknown): string => {
    if (typeof id !== 'string') throw new Error('invalid_module_catalog')
    return id
  })
  return { entries, excludedClientModules, source: value.source === 'device' ? 'device' : value.source === 'computer' ? 'computer' : 'plugin' }
}

export const CLIENT_MODULE_STYLES = `
.dsh-module-row{display:flex;align-items:center;gap:8px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsh-module-rowText{flex:1;min-width:0}.dsh-module-title{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}
.dsh-module-description{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dsh-module-button{min-height:48px;padding:0 14px;border:0;border-radius:24px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;cursor:pointer}
.dsh-module-button:focus-visible{outline:2px solid var(--dsw-alias-label-primary-bluish,#2563eb);outline-offset:2px}
.dsh-module-dialog{box-sizing:border-box;width:min(640px,calc(100vw - 24px));max-height:calc(100dvh - 32px);padding:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-panel,20px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#171a21);font:16px/1.5 var(--dsw-font-family,sans-serif);overflow:auto}
.dsh-module-dialog::backdrop{background:rgb(15 23 42 / 40%)}.dsh-module-dialog h2{font-size:20px;margin:0 0 12px}
.dsh-module-dialog p{overflow-wrap:anywhere}.dsh-module-list{display:flex;flex-direction:column;gap:4px;margin:12px 0}
.dsh-module-choice{display:flex;align-items:flex-start;gap:12px;min-height:48px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.dsh-module-choice input{width:24px;height:24px;flex:none;margin:2px 0}.dsh-module-choice span{min-width:0;overflow-wrap:anywhere}
.dsh-module-choice small{display:block;font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:18px}.dsh-module-actions{display:flex;flex-wrap:wrap;gap:8px}
.dsh-module-error{color:var(--dsw-alias-state-error-primary,#b42318)}
`

const openDialogs = new Set<() => void>()

/** Cancel pending dialogs when the owning plugin generation is disposed. */
export function disposeClientModuleDialogs(): void { for (const dispose of [...openDialogs]) dispose() }

/** Close the foreground module modal before navigating its underlying DSH settings.
 * @returns Whether an open module modal consumed the return action.
 */
export function closeClientModuleDialog(): boolean {
  const dispose = [...openDialogs].at(-1)
  if (dispose === undefined) return false
  dispose()
  return true
}

/** Open one modal; closing cancels reads and restores focus without reloading the page.
 * @param scope - Computer defaults or the authenticated device's own override.
 * @param locale - Current DSH display language.
 * @param trigger - Control to focus again when the modal closes.
 */
export function openClientModuleSettings(scope: 'computer' | 'device', locale: MobileControlLocale, trigger?: HTMLElement): void {
  const copy = CLIENT_MODULE_COPY[locale]
  const endpoint = scope === 'computer' ? '/api/mobile-access/client-modules' : '/mobile-access/client-modules'
  const controller = new AbortController()
  const dialog = document.createElement('dialog'); dialog.className = 'dsh-module-dialog'; dialog.setAttribute('aria-label', copy.title)
  const title = document.createElement('h2'); title.textContent = copy.title
  const intro = document.createElement('p'); intro.textContent = `${copy[scope]} ${copy.hint}`
  const status = document.createElement('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.tabIndex = -1
  const list = document.createElement('div'); list.className = 'dsh-module-list'
  const actions = document.createElement('div'); actions.className = 'dsh-module-actions'
  const button = (text: string): HTMLButtonElement => { const result = document.createElement('button'); result.type = 'button'; result.className = 'dsh-module-button'; result.textContent = text; return result }
  const save = button(copy.save); const reset = button(copy.reset); const close = button(copy.close)
  actions.append(save, reset, close); dialog.append(title, intro, status, list, actions)
  let disposed = false
  let busy = false
  let loaded = false
  const choices = new Map<string, HTMLInputElement>()
  const setBusy = (value: boolean): void => { busy = value; save.disabled = value || !loaded; reset.disabled = value || !loaded; for (const input of choices.values()) if (!input.dataset.required) input.disabled = value }
  const request = async (body?: Record<string, unknown>): Promise<ClientModuleView> => {
    const init: RequestInit = { method: body === undefined ? 'GET' : 'POST', signal: controller.signal, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
    init.headers = scope === 'computer' ? localAdminRequestHeaders(init, location) : { 'content-type': 'application/json' }
    if (scope === 'device' && body !== undefined) {
      const csrfCookie = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('__Host-dsh_ma_csrf='))
        ?? document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith('dsh_ma_csrf='))
      if (csrfCookie !== undefined) {
        const headers = new Headers(init.headers)
        headers.set('x-dsh-mobile-csrf', csrfCookie.slice(csrfCookie.indexOf('=') + 1))
        init.headers = headers
      }
    }
    const response = await fetch(endpoint, init)
    const value: unknown = await response.json()
    if (!response.ok) {
      const detail = typeof value === 'object' && value !== null && 'detail' in value && typeof value.detail === 'string' ? value.detail.slice(0, 512) : ''
      if (response.status === 409 && detail !== '' && typeof value === 'object' && value !== null && 'error' in value && value.error === 'excluded_client_modules_invalid') throw new ClientModuleUiConflict(detail)
      throw new Error('client_module_request_failed')
    }
    return parseClientModuleView(value)
  }
  const render = (view: ClientModuleView): void => {
    if (disposed) return
    loaded = true
    choices.clear(); list.replaceChildren()
    for (const entry of view.entries) {
      const label = document.createElement('label'); label.className = 'dsh-module-choice'
      const input = document.createElement('input'); input.type = 'checkbox'; input.checked = !view.excludedClientModules.includes(entry.id); input.disabled = entry.required; if (entry.required) input.dataset.required = 'true'
      const name = document.createElement('span'); name.textContent = entry.id
      const hint = document.createElement('small'); hint.textContent = entry.required ? copy.required : entry.dependencies.length === 0 ? '' : `${copy.dependencies}${entry.dependencies.join(', ')}`
      name.append(hint); label.append(input, name); list.append(label); choices.set(entry.id, input)
    }
    status.classList.remove('dsh-module-error'); status.textContent = view.source === 'device' ? copy.deviceSource : copy.computerSource
  }
  const failed = (error: unknown): void => {
    if (disposed || controller.signal.aborted) return
    status.classList.add('dsh-module-error'); status.textContent = error instanceof ClientModuleUiConflict ? `${copy.conflict}${error.detail}` : copy.failed
    status.focus({ preventScroll: true })
  }
  const mutate = (body: Record<string, unknown>): void => {
    if (busy || !loaded) return
    setBusy(true)
    void request(body).then(view => { render(view); if (!disposed) status.textContent = copy.saved }, failed).finally(() => { if (!disposed) setBusy(false) })
  }
  save.addEventListener('click', () => { mutate({ excludedClientModules: [...choices].filter(([, input]) => !input.checked).map(([id]) => id) }) })
  reset.addEventListener('click', () => { if (window.confirm(copy.resetConfirm)) mutate({ reset: true }) })
  const onBack = (event: Event): void => { if (!event.cancelable || !dialog.open || event.defaultPrevented) return; event.preventDefault(); event.stopImmediatePropagation(); dispose() }
  window.addEventListener('dsh-mobile:native-back', onBack, true)
  const dispose = (): void => {
    if (disposed) return
    disposed = true; controller.abort(); openDialogs.delete(dispose); window.removeEventListener('dsh-mobile:native-back', onBack, true); if (dialog.open) dialog.close(); dialog.remove()
    if (trigger?.isConnected) trigger.focus({ preventScroll: true })
  }
  openDialogs.add(dispose)
  dialog.addEventListener('close', dispose, { once: true }); close.addEventListener('click', dispose)
  document.body.append(dialog); dialog.showModal(); setBusy(true); status.textContent = copy.loading
  void request().then(render, failed).finally(() => { if (!disposed) setBusy(false) })
}

/** Settings row used on mobile pages and on the computer's General settings.
 * @param props - Selection scope and current locale.
 * @returns A native-style General settings row.
 */
export function ClientModuleSettingsRow(props: { readonly scope: 'computer' | 'device'; readonly locale: MobileControlLocale }): ReactElement {
  const copy = CLIENT_MODULE_COPY[props.locale]
  return createElement('div', { className: 'dsh-module-row', lang: props.locale },
    createElement('div', { className: 'dsh-module-rowText' }, createElement('div', { className: 'dsh-module-title' }, copy.title), createElement('div', { className: 'dsh-module-description' }, copy[props.scope])),
    createElement('button', { type: 'button', className: 'dsh-module-button', onClick: (event: { currentTarget: HTMLElement }) => { openClientModuleSettings(props.scope, props.locale, event.currentTarget) } }, copy.open),
  )
}
