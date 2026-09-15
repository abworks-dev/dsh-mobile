/** Browser-safe desktop-admin Host checks. Do not import Node APIs here. */

function unwrapBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

function parseIpv4(hostname: string): readonly [number, number, number, number] | undefined {
  const parts = hostname.split('.')
  if (parts.length !== 4) return undefined
  const octets: number[] = []
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) return undefined
    const value = Number(part)
    if (value > 255) return undefined
    octets.push(value)
  }
  return octets as [number, number, number, number]
}

function isLoopbackIpv4(octets: readonly [number, number, number, number]): boolean {
  return octets[0] === 127
}

function isPrivateIpv4(octets: readonly [number, number, number, number]): boolean {
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168)
}

function isLinkLocalIpv4(octets: readonly [number, number, number, number]): boolean {
  return octets[0] === 169 && octets[1] === 254
}

/**
 * Hostnames that may appear on the DSH desktop admin surface.
 * Loopback, RFC1918, and IPv4 link-local are accepted. Public IPs,
 * CGNAT, and arbitrary DNS names stay rejected so DNS rebinding
 * cannot reach `/api/mobile-access`.
 */
export function isLocalAdminHostname(hostname: string): boolean {
  const host = unwrapBrackets(hostname).trim().toLowerCase()
  if (host === 'localhost' || host === '::1') return true
  const octets = parseIpv4(host)
  if (octets === undefined) return false
  return isLoopbackIpv4(octets) || isPrivateIpv4(octets) || isLinkLocalIpv4(octets)
}

/**
 * Whether the current browser document should mount the desktop Mobile access
 * control. Dedicated Mobile HTTPS (the phone surface) stays native even when
 * the Host is a private LAN address.
 */
export function isDesktopAdminSurface(
  hostname: string,
  search = '',
  frontend?: string,
): boolean {
  const query = search.startsWith('?') ? search.slice(1) : search
  return isLocalAdminHostname(hostname)
    && frontend !== 'dedicated'
    && !new URLSearchParams(query).has('dsh-mobile-preview')
}
