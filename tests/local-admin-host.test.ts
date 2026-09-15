import { describe, expect, it } from 'vitest'
import { isDesktopAdminSurface, isLocalAdminHostname } from '../src/local-admin-host.js'

describe('desktop admin hostnames', () => {
  it.each([
    'localhost',
    'LOCALHOST',
    '127.0.0.1',
    '127.255.255.255',
    '::1',
    '[::1]',
    '10.0.0.1',
    '10.255.255.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '169.254.1.1',
  ])('accepts %s', (hostname) => {
    expect(isLocalAdminHostname(hostname)).toBe(true)
  })

  it.each([
    '',
    'example.com',
    'evil.example',
    'dsh.example.com',
    '8.8.8.8',
    '1.1.1.1',
    '100.64.0.1',
    '100.127.255.254',
    '203.0.113.10',
    '192.0.2.1',
    '169.253.0.1',
    '172.15.0.1',
    '172.32.0.1',
    '0.0.0.0',
    '255.255.255.255',
    '192.168.1',
    '192.168.001.1',
    'localhost.example',
    '::ffff:192.168.1.1',
    'fc00::1',
    'fe80::1',
  ])('rejects %s', (hostname) => {
    expect(isLocalAdminHostname(hostname)).toBe(false)
  })
})

describe('desktop admin surface', () => {
  it('treats private LAN DSH Web as the desktop admin surface', () => {
    expect(isDesktopAdminSurface('localhost')).toBe(true)
    expect(isDesktopAdminSurface('127.0.0.1')).toBe(true)
    expect(isDesktopAdminSurface('192.168.50.23')).toBe(true)
    expect(isDesktopAdminSurface('10.0.0.8', '')).toBe(true)
  })

  it('keeps the dedicated Mobile HTTPS frontend on the phone surface', () => {
    expect(isDesktopAdminSurface('192.168.50.23', '', 'dedicated')).toBe(false)
    expect(isDesktopAdminSurface('localhost', '', 'dedicated')).toBe(false)
  })

  it('keeps the preview query on the phone surface', () => {
    expect(isDesktopAdminSurface('localhost', '?dsh-mobile-preview')).toBe(false)
    expect(isDesktopAdminSurface('192.168.50.23', 'dsh-mobile-preview=1')).toBe(false)
  })

  it('rejects public and DNS-rebinding Host values', () => {
    expect(isDesktopAdminSurface('evil.example')).toBe(false)
    expect(isDesktopAdminSurface('8.8.8.8')).toBe(false)
  })
})
