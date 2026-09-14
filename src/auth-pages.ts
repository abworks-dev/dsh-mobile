/** Browser-facing pairing and reauthentication pages with language negotiation. */
export type AuthPageLocale = 'zh' | 'en' | 'it'

interface AuthPageCopy {
  readonly lang: string
  readonly pairTitle: string
  readonly pairHeading: string
  readonly pairingCode: string
  readonly deviceName: string
  readonly pair: string
  readonly pairing: string
  readonly pairFailed: string
  readonly unavailable: string
  readonly reconnectTitle: string
  readonly reconnectHeading: string
  readonly restoring: string
  readonly noLongerPaired: string
  readonly openPairing: string
}

const COPY: Record<AuthPageLocale, AuthPageCopy> = {
  en: {
    lang: 'en', pairTitle: 'Pair DSH mobile access', pairHeading: 'Pair this device',
    pairingCode: 'Pairing code', deviceName: 'Device name', pair: 'Pair', pairing: 'Pairing…',
    pairFailed: 'Pairing failed', unavailable: 'The computer is unavailable.',
    reconnectTitle: 'Reconnect DSH mobile access', reconnectHeading: 'Reconnect this device',
    restoring: 'Restoring the secure Session…', noLongerPaired: 'This device is no longer paired. Open pairing on the computer, then pair it again.',
    openPairing: 'Open pairing',
  },
  zh: {
    lang: 'zh-CN', pairTitle: '配对 DSH 移动访问', pairHeading: '配对此设备',
    pairingCode: '配对码', deviceName: '设备名称', pair: '配对', pairing: '正在配对…',
    pairFailed: '配对失败', unavailable: '电脑当前不可用。',
    reconnectTitle: '重新连接 DSH 移动访问', reconnectHeading: '重新连接此设备',
    restoring: '正在恢复安全会话…', noLongerPaired: '此设备已不在配对列表中。请在电脑端打开配对，然后重新配对。',
    openPairing: '打开配对页面',
  },
  it: {
    lang: 'it-IT', pairTitle: 'Abbina accesso mobile DSH', pairHeading: 'Abbina questo dispositivo',
    pairingCode: 'Codice di abbinamento', deviceName: 'Nome dispositivo', pair: 'Abbina', pairing: 'Abbinamento…',
    pairFailed: 'Abbinamento non riuscito', unavailable: 'Il computer non è disponibile.',
    reconnectTitle: 'Riconnetti accesso mobile DSH', reconnectHeading: 'Riconnetti questo dispositivo',
    restoring: 'Ripristino della sessione sicura…', noLongerPaired: 'Questo dispositivo non è più abbinato. Apri l’abbinamento sul computer e ripeti la procedura.',
    openPairing: 'Apri abbinamento',
  },
}

/** Choose Chinese, Italian, or English from an HTTP Accept-Language header. */
export function resolveAuthPageLocale(header: string | undefined): AuthPageLocale {
  const values = header?.split(',').map((value, index) => {
    const [language, ...parameters] = value.split(';')
    const quality = parameters.find(parameter => parameter.trim().toLowerCase().startsWith('q='))
    const parsedQuality = quality === undefined ? 1 : Number(quality.trim().slice(2))
    return {
      language: language?.trim().toLowerCase() ?? '',
      quality: Number.isFinite(parsedQuality) ? Math.max(0, Math.min(1, parsedQuality)) : 0,
      index,
    }
  }).filter(value => value.quality > 0).sort((left, right) => right.quality - left.quality || left.index - right.index).map(value => value.language) ?? []
  for (const value of values) {
    if (value.startsWith('zh')) return 'zh'
    if (value.startsWith('it')) return 'it'
    if (value.startsWith('en')) return 'en'
  }
  return 'en'
}

/** Render the browser pairing form without reflecting request data into HTML. */
export function renderPairPage(locale: AuthPageLocale): string {
  const copy = COPY[locale]
  return `<!doctype html>
<html lang="${copy.lang}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${copy.pairTitle}</title>
<main>
  <h1>${copy.pairHeading}</h1>
  <form id="pair-form">
    <label>${copy.pairingCode} <input id="pair-token" autocomplete="one-time-code" required></label>
    <label>${copy.deviceName} <input id="device-label" maxlength="64" autocomplete="off"></label>
    <button type="submit">${copy.pair}</button>
    <output id="pair-status" aria-live="polite"></output>
  </form>
</main>
<script src="/mobile-access/pair.js" defer></script>
</html>
`
}

/** Render the pairing form script with locale-owned status messages. */
export function renderPairScript(locale: AuthPageLocale): string {
  const copy = COPY[locale]
  return `(() => {
  const form = document.getElementById('pair-form')
  const token = document.getElementById('pair-token')
  const label = document.getElementById('device-label')
  const status = document.getElementById('pair-status')
  const fragment = new URLSearchParams(location.hash.slice(1))
  const supplied = fragment.get('token')
  history.replaceState(null, '', location.pathname)
  if (supplied) token.value = supplied
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    status.value = ${JSON.stringify(copy.pairing)}
    try {
      const response = await fetch('/mobile-access/auth/pair', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: token.value, label: label.value || undefined }),
      })
      if (!response.ok) {
        status.value = ${JSON.stringify(copy.pairFailed)}
        return
      }
      location.replace('/')
    } catch {
      status.value = ${JSON.stringify(copy.unavailable)}
    }
  })
})()
`
}

/** Render the browser reauthentication page. */
export function renderLoginPage(locale: AuthPageLocale): string {
  const copy = COPY[locale]
  return `<!doctype html>
<html lang="${copy.lang}">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${copy.reconnectTitle}</title>
<main>
  <h1>${copy.reconnectHeading}</h1>
  <p id="login-progress" aria-live="polite">${copy.restoring}</p>
  <section id="login-failed" hidden>
    <p>${copy.noLongerPaired}</p>
    <a href="/mobile-access/pair">${copy.openPairing}</a>
  </section>
</main>
<script src="/mobile-access/login.js" defer></script>
</html>
`
}

/** Render the reauthentication script with locale-owned failure text. */
export function renderLoginScript(locale: AuthPageLocale): string {
  const copy = COPY[locale]
  return `(() => {
  const candidate = new URL(location.href).searchParams.get('return')
  let returnPath = '/'
  if (candidate && candidate.startsWith('/')) {
    try {
      const resolved = new URL(candidate, location.origin)
      const pathname = decodeURIComponent(resolved.pathname)
      if (resolved.origin === location.origin && pathname !== '/mobile-access'
        && !pathname.startsWith('/mobile-access/') && !pathname.includes('\\\\')) {
        returnPath = resolved.pathname + resolved.search + resolved.hash
      }
    } catch {
      // Malformed untrusted return targets keep the safe root default.
    }
  }
  fetch('/mobile-access/auth/renew', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).then((response) => {
    if (response.ok) {
      location.replace(returnPath)
      return
    }
    document.getElementById('login-progress').hidden = true
    document.getElementById('login-failed').hidden = false
  }).catch(() => {
    document.getElementById('login-progress').textContent = ${JSON.stringify(copy.unavailable)}
  })
})()
`
}
