import { afterEach, describe, expect, it, vi } from 'vitest'
import { downloadPinnedArtifact } from '../src/component-download.js'

const BODY = 'abcd'
const BYTES = new TextEncoder().encode(BODY)
const URL_PINNED = 'https://github.com/owner/repo/releases/download/v1/tool.exe'
const URL_ASSET = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/2?token=x'

interface Call {
  readonly url: string
  readonly redirect: string | undefined
}

/** Replace global fetch with a scripted queue and record how each call was configured. */
function stubFetch(responses: readonly Response[]): Call[] {
  const calls: Call[] = []
  let index = 0
  vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), redirect: init?.redirect })
    const response = responses[index]
    index += 1
    if (response === undefined) throw new Error(`unexpected fetch #${String(index)} for ${String(url)}`)
    return Promise.resolve(response)
  })
  return calls
}

function response(status: number, headers: Record<string, string>, body: string = BODY): Response {
  return new Response(body, { status, headers })
}

afterEach(() => { vi.unstubAllGlobals() })

describe('pinned component download', () => {
  it('accepts a direct response whose length matches the pin', async () => {
    const calls = stubFetch([response(200, { 'content-length': String(BYTES.byteLength) })])
    const bytes = await downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })
    expect([...bytes]).toEqual([...BYTES])
    // A direct response is requested with manual redirects so a hop can be validated explicitly.
    expect(calls).toEqual([{ url: URL_PINNED, redirect: 'manual' }])
  })

  it('follows exactly one redirect to a release asset host', async () => {
    // This is the shape every GitHub release download uses, and the one `redirect: 'error'` broke.
    const calls = stubFetch([
      response(302, { location: URL_ASSET }),
      response(200, { 'content-length': String(BYTES.byteLength) }),
    ])
    const bytes = await downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })
    expect([...bytes]).toEqual([...BYTES])
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ url: URL_PINNED, redirect: 'manual' })
    expect(calls[1]?.url).toBe(URL_ASSET)
    // The hop target must serve the bytes itself: a second redirect is refused.
    expect(calls[1]?.redirect).toBe('error')
  })

  it('refuses a redirect to a host that is not a release asset host', async () => {
    stubFetch([response(302, { location: 'https://evil.example/tool.exe' })])
    await expect(downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })).rejects.toThrow('tool_download_redirect_rejected')
  })

  it('refuses a cleartext redirect and a redirect without a location', async () => {
    stubFetch([response(302, { location: 'http://release-assets.githubusercontent.com/tool.exe' })])
    await expect(downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })).rejects.toThrow('tool_download_redirect_rejected')

    vi.unstubAllGlobals()
    stubFetch([response(302, {})])
    await expect(downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })).rejects.toThrow('tool_download_redirect_missing')
  })

  it('refuses a body whose length differs from the pin', async () => {
    stubFetch([response(200, { 'content-length': '99' })])
    await expect(downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })).rejects.toThrow('tool_download_size_mismatch')
  })

  it('reports the http status when the artifact is not served', async () => {
    // A 5xx is retried once, so both attempts must answer before the verdict surfaces.
    stubFetch([response(503, {}), response(503, {})])
    await expect(downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })).rejects.toThrow('tool_download_http_503')
  })

  it('retries a transport failure once, because a long transfer can reset mid-stream', async () => {
    let call = 0
    vi.stubGlobal('fetch', () => {
      call += 1
      if (call === 1) return Promise.reject(new TypeError('fetch failed'))
      return Promise.resolve(response(200, { 'content-length': String(BYTES.byteLength) }))
    })
    const bytes = await downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })
    expect([...bytes]).toEqual([...BYTES])
    expect(call).toBe(2)
  })

  it('does not retry a verdict', async () => {
    let call = 0
    vi.stubGlobal('fetch', () => {
      call += 1
      return Promise.resolve(response(200, { 'content-length': '99' }))
    })
    await expect(downloadPinnedArtifact({
      url: URL_PINNED, expectedBytes: BYTES.byteLength, errorPrefix: 'tool', signal: new AbortController().signal,
    })).rejects.toThrow('tool_download_size_mismatch')
    expect(call).toBe(1)
  })
})
