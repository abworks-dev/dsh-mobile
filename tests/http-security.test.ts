import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { HttpError, assertLocalAdminTrust } from '../src/http-security.js'

function fakeRequest(init: {
  readonly remoteAddress?: string | undefined
  readonly host?: string
  readonly origin?: string
  readonly site?: string
}): IncomingMessage {
  const headers: Record<string, string> = {}
  if (init.host !== undefined) headers.host = init.host
  if (init.origin !== undefined) headers.origin = init.origin
  if (init.site !== undefined) headers['sec-fetch-site'] = init.site
  return {
    socket: {
      remoteAddress: Object.hasOwn(init, 'remoteAddress') ? init.remoteAddress : '127.0.0.1',
    },
    headers,
  } as IncomingMessage
}

function reject(init: Parameters<typeof fakeRequest>[0], requireOrigin = false): void {
  expect(() => assertLocalAdminTrust(fakeRequest(init), requireOrigin)).toThrow(HttpError)
  try {
    assertLocalAdminTrust(fakeRequest(init), requireOrigin)
  } catch (error) {
    expect(error).toMatchObject({ status: 403, code: 'forbidden' })
  }
}

describe('assertLocalAdminTrust', () => {
  it('keeps loopback Host and TCP peer working', () => {
    expect(() => assertLocalAdminTrust(fakeRequest({ host: '127.0.0.1:8787' }), false)).not.toThrow()
    expect(() => assertLocalAdminTrust(fakeRequest({ host: 'localhost:8787' }), false)).not.toThrow()
    expect(() => assertLocalAdminTrust(fakeRequest({ host: '[::1]:8787' }), false)).not.toThrow()
  })

  it('accepts RFC1918 and IPv4 link-local Host values when the TCP peer is loopback', () => {
    expect(() => assertLocalAdminTrust(fakeRequest({
      remoteAddress: '127.0.0.1',
      host: '192.168.50.23:8080',
    }), false)).not.toThrow()
    expect(() => assertLocalAdminTrust(fakeRequest({
      remoteAddress: '::1',
      host: '10.0.0.8:8080',
      origin: 'http://10.0.0.8:8080',
      site: 'same-origin',
    }), true)).not.toThrow()
    expect(() => assertLocalAdminTrust(fakeRequest({
      remoteAddress: '::ffff:127.0.0.1',
      host: '172.16.1.9:8080',
    }), false)).not.toThrow()
    expect(() => assertLocalAdminTrust(fakeRequest({
      remoteAddress: '127.0.0.1',
      host: '169.254.12.4:8080',
    }), false)).not.toThrow()
  })

  it('still rejects DNS rebinding, public, and CGNAT Host values', () => {
    reject({ host: 'evil.example' })
    reject({ host: 'dsh.example.com:8080' })
    reject({ host: '8.8.8.8:8080' })
    reject({ host: '100.64.1.8:8080' })
    reject({ host: '203.0.113.10:8080' })
  })

  it('still requires a loopback TCP peer', () => {
    reject({ remoteAddress: '192.168.50.23', host: '192.168.50.23:8080' })
    reject({ remoteAddress: '192.168.50.23', host: 'localhost:8080' })
    reject({ remoteAddress: '10.0.0.8', host: '127.0.0.1:8080' })
    reject({ remoteAddress: '::ffff:192.168.50.23', host: '192.168.50.23:8080' })
    reject({ remoteAddress: undefined, host: '127.0.0.1:8080' })
  })

  it('rejects a mismatched or non-http Origin even on a private Host', () => {
    reject({
      host: '192.168.50.23:8080',
      origin: 'http://127.0.0.1:8080',
    })
    reject({
      host: '192.168.50.23:8080',
      origin: 'ftp://192.168.50.23:8080',
    })
    reject({
      host: '192.168.50.23:8080',
      origin: 'http://evil.example',
    })
  })

  it('allows https Origin when the Host authority matches, for TLS-terminating reverse proxies', () => {
    expect(() => assertLocalAdminTrust(fakeRequest({
      host: '192.168.50.23:8080',
      origin: 'https://192.168.50.23:8080',
    }), false)).not.toThrow()
  })

  it('requires a same-origin browser Origin on mutating requests when Sec-Fetch-Site is present', () => {
    reject({
      host: '192.168.50.23:8080',
      site: 'same-origin',
    }, true)
    reject({
      host: '192.168.50.23:8080',
      origin: 'http://192.168.50.23:8080',
      site: 'cross-site',
    }, true)
    expect(() => assertLocalAdminTrust(fakeRequest({
      host: '192.168.50.23:8080',
      origin: 'http://192.168.50.23:8080',
      site: 'same-origin',
    }), true)).not.toThrow()
  })

  it('rejects mutating requests with no Origin even when Fetch Metadata is absent', () => {
    reject({ host: '192.168.50.23:8080' }, true)
  })
})
