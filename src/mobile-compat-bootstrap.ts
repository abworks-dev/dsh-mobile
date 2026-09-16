import { AUTH_PREFIX } from './http-security.js'

export const MOBILE_COMPAT_PATH = `${AUTH_PREFIX}/compat.js`

/** Load the compatibility bundle synchronously, before the first DSH script. */
export function ensureMobileCompatibility(html: string): string {
  if (html.includes(`<script src="${MOBILE_COMPAT_PATH}"`)) return html
  const firstScript = /<script\b[^>]*>/iu.exec(html)
  if (firstScript?.index === undefined) throw new Error('upstream DSH index has no script for compatibility bootstrap')
  // Keep any upstream CSP nonce; do not move execution ahead of preceding CSP meta tags.
  const nonce = /\snonce\s*=\s*(?:"[^"]*"|'[^']*')/iu.exec(firstScript[0])?.[0] ?? ''
  const script = `<script src="${MOBILE_COMPAT_PATH}"${nonce}></script>`
  return `${html.slice(0, firstScript.index)}${script}${html.slice(firstScript.index)}`
}
