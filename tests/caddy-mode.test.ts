import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createVolatileRemoteControlStore, JsonOriginModeStore, ManagedOriginController, type OriginModeState } from '../src/managed-origin.js'
import type { RemoteProviderController } from '../src/remote.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function controller(name: string, events: string[]): RemoteProviderController {
  let enabled = false
  return { initialize: async () => { events.push(name + ':init') }, gateway: () => undefined,
    status: () => ({ enabled, state: enabled ? 'ready' : 'off' }),
    setEnabled: async value => { events.push(name + ':' + String(value)); enabled = value; return { enabled, state: value ? 'ready' : 'off' } },
    reconnect: async () => { events.push(name + ':reconnect'); enabled = true; return { enabled, state: 'ready' } },
    reset: async () => { enabled = false; return { enabled, state: 'off' } }, close: async () => { events.push(name + ':close'); enabled = false },
  }
}
describe('origin upstream ownership', () => {
  it('defaults to external mode without writing existing settings or changing other providers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-caddy-mode-')); cleanups.push(() => rm(root, { recursive: true, force: true }))
    const modeStore = new JsonOriginModeStore(join(root, 'upstream.json'))
    expect(await modeStore.load()).toEqual({ version: 1, mode: 'external' })
    const events: string[] = []; const controlStore = createVolatileRemoteControlStore(); await controlStore.save({ version: 1, enabled: true })
    const wrapper = new ManagedOriginController({ modeStore, store: controlStore, external: controller('external', events), managed: controller('managed', events) })
    cleanups.push(() => wrapper.close()); await wrapper.initialize()
    expect(wrapper.status()).toMatchObject({ enabled: true, state: 'ready', mode: 'external' })
    expect(events).toEqual(['external:init', 'managed:init', 'external:false', 'managed:false', 'external:true'])
    await expect(readFile(join(root, 'upstream.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await wrapper.selectMode('managed')
    expect(events.slice(-2)).toEqual(['external:false', 'managed:true'])
    expect(await modeStore.load()).toEqual({ version: 1, mode: 'managed' })
    await wrapper.setEnabled(false); expect(wrapper.status().enabled).toBe(false)
  })
  it('restores the previous mode on a persistence failure', async () => {
    const events: string[] = []; const store = createVolatileRemoteControlStore(); await store.save({ version: 1, enabled: true })
    const wrapper = new ManagedOriginController({ store, external: controller('external', events), managed: controller('managed', events),
      modeStore: { load: async () => ({ version: 1, mode: 'external' }), save: async () => { throw new Error('write failed') } } })
    cleanups.push(() => wrapper.close()); await wrapper.initialize()
    await expect(wrapper.selectMode('managed')).rejects.toThrow('write failed')
    expect(wrapper.status()).toMatchObject({ enabled: true, mode: 'external', state: 'ready' })
    expect(events.slice(-2)).toEqual(['external:false', 'external:true'])
  })
  it('stops both children when activation fails and never revives the unselected child', async () => {
    const events: string[] = []; let mode: OriginModeState = { version: 1, mode: 'external' }
    const managed = controller('managed', events)
    const enable = managed.setEnabled
    managed.setEnabled = vi.fn(async value => { if (value) throw new Error('start failed'); return enable(value) })
    const store = createVolatileRemoteControlStore(); await store.save({ version: 1, enabled: true })
    const wrapper = new ManagedOriginController({ store, external: controller('external', events), managed,
      modeStore: { load: async () => mode, save: async value => { mode = value } } })
    cleanups.push(() => wrapper.close()); await wrapper.initialize()
    await expect(wrapper.selectMode('managed')).rejects.toThrow('start failed')
    expect(events.slice(-2)).toEqual(['external:false', 'managed:false'])
    expect(wrapper.mode()).toBe('managed'); expect(wrapper.gateway()).toBeUndefined()
  })
})
