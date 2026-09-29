import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FollowingMobileAccessRuntime,
  JsonMobileAccessControlStore,
  MobileAccessGatewayController,
  type MobileAccessControlState,
  type MobileAccessControlStore,
  type MobileAccessRuntime,
} from '../src/control.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function controlFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-control-'))
  temporaryDirectories.push(directory)
  return join(directory, 'nested', 'control.json')
}

class MemoryControlStore implements MobileAccessControlStore {
  readonly saved: MobileAccessControlState[] = []
  failNextSave: Error | undefined

  constructor(public state: MobileAccessControlState) {}

  async load(): Promise<MobileAccessControlState> {
    return { ...this.state }
  }

  async save(state: MobileAccessControlState): Promise<void> {
    if (this.failNextSave !== undefined) {
      const error = this.failNextSave
      this.failNextSave = undefined
      throw error
    }
    this.state = { ...state }
    this.saved.push({ ...state })
  }
}

function runtime(close: () => void | Promise<void> = () => {}): MobileAccessRuntime {
  return { close: async () => close() }
}

describe('mobile-access control state', () => {
  it('uses the installation default only for a missing file and persists a disabled restart', async () => {
    const file = await controlFile()
    const store = new JsonMobileAccessControlStore(file, true)

    await expect(store.load()).resolves.toEqual({ version: 1, enabled: true })
    await store.save({ version: 1, enabled: false })
    await expect(new JsonMobileAccessControlStore(file, true).load()).resolves.toEqual({ version: 1, enabled: false })

    const initiallyOff = await controlFile()
    await expect(new JsonMobileAccessControlStore(initiallyOff, false).load())
      .resolves.toEqual({ version: 1, enabled: false })
  })

  it('rejects malformed or extended durable state', async () => {
    const file = await controlFile()
    const store = new JsonMobileAccessControlStore(file, false)
    await store.save({ version: 1, enabled: false })
    await writeFile(file, '{"version":1,"enabled":false,"extra":true}\n')
    await expect(new JsonMobileAccessControlStore(file, false).load()).rejects.toThrow(/unsupported format/)
  })

  it('persists disabled state when an absent provider would otherwise start by default', async () => {
    const file = await controlFile()
    const store = new JsonMobileAccessControlStore(file, true)
    await store.disableIfPresent()
    await expect(store.load()).resolves.toEqual({ version: 1, enabled: false })
  })
})

describe('MobileAccessGatewayController', () => {
  it('starts by default, persists false, and stays stopped after restart', async () => {
    const file = await controlFile()
    const start = vi.fn(async () => {
      return runtime()
    })
    const first = new MobileAccessGatewayController(new JsonMobileAccessControlStore(file, true), start)

    await first.initialize()
    expect(first.isRunning()).toBe(true)
    await first.setRunning(false)
    expect(first.isRunning()).toBe(false)
    expect(start).toHaveBeenCalledOnce()
    await first.close()

    const secondStart = vi.fn(async () => runtime())
    const second = new MobileAccessGatewayController(new JsonMobileAccessControlStore(file, true), secondStart)
    await second.initialize()
    expect(second.isRunning()).toBe(false)
    expect(secondStart).not.toHaveBeenCalled()
    await second.close()
  })

  it('serializes concurrent transitions in request order', async () => {
    const events: string[] = []
    const store = new MemoryControlStore({ version: 1, enabled: false })
    const controller = new MobileAccessGatewayController(store, async () => {
      events.push('start')
      return runtime(() => { events.push('stop') })
    })
    await controller.initialize()

    const enable = controller.setRunning(true).then(() => { events.push('enabled') })
    const disable = controller.setRunning(false).then(() => { events.push('disabled') })
    await Promise.all([enable, disable])

    expect(events).toEqual(['start', 'enabled', 'stop', 'disabled'])
    expect(store.saved).toEqual([
      { version: 1, enabled: true },
      { version: 1, enabled: false },
    ])
    expect(controller.isRunning()).toBe(false)
    await controller.close()
  })

  it('keeps false state and disk unchanged when start fails', async () => {
    const store = new MemoryControlStore({ version: 1, enabled: false })
    const controller = new MobileAccessGatewayController(store, () => Promise.reject(new Error('bind failed')))
    await controller.initialize()

    await expect(controller.setRunning(true)).rejects.toThrow('bind failed')
    expect(controller.isRunning()).toBe(false)
    expect(store.saved).toEqual([])
    expect(store.state.enabled).toBe(false)
    await controller.close()
  })

  it('closes a newly started runtime when persisting enablement fails', async () => {
    const store = new MemoryControlStore({ version: 1, enabled: false })
    const close = vi.fn()
    const controller = new MobileAccessGatewayController(store, async () => runtime(close))
    await controller.initialize()
    store.failNextSave = new Error('disk full')

    await expect(controller.setRunning(true)).rejects.toThrow('disk full')
    expect(close).toHaveBeenCalledOnce()
    expect(controller.isRunning()).toBe(false)
    expect(store.state.enabled).toBe(false)
    await controller.close()
  })

  it('restarts the old true state when persisting disablement fails', async () => {
    const store = new MemoryControlStore({ version: 1, enabled: true })
    const close = vi.fn()
    const start = vi.fn(async () => runtime(close))
    const controller = new MobileAccessGatewayController(store, start)
    await controller.initialize()
    store.failNextSave = new Error('disk full')

    await expect(controller.setRunning(false)).rejects.toThrow('disk full')
    expect(start).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledOnce()
    expect(controller.isRunning()).toBe(true)
    expect(store.state.enabled).toBe(true)
    await controller.close()
  })

  it('does not persist false during owner teardown', async () => {
    const store = new MemoryControlStore({ version: 1, enabled: true })
    const close = vi.fn()
    const controller = new MobileAccessGatewayController(store, async () => runtime(close))
    await controller.initialize()

    await controller.close()
    expect(close).toHaveBeenCalledOnce()
    expect(store.saved).toEqual([])
    expect(store.state.enabled).toBe(true)
    await expect(controller.setRunning(false)).rejects.toThrow(/closing/)
  })
})

describe('FollowingMobileAccessRuntime', () => {
  it('keeps the current runtime until the selected LAN address changes', async () => {
    const events: string[] = []
    let selected = '192.168.1.20/24'
    const following = new FollowingMobileAccessRuntime(async () => {
      const key = selected
      return {
        key,
        start: async () => {
          events.push(`start:${key}`)
          return runtime(() => { events.push(`stop:${key}`) })
        },
      }
    }, error => { throw error })

    await following.initialize()
    await following.refresh()
    selected = '192.168.43.12/24'
    await following.refresh()
    await following.close()

    expect(events).toEqual([
      'start:192.168.1.20/24',
      'stop:192.168.1.20/24',
      'start:192.168.43.12/24',
      'stop:192.168.43.12/24',
    ])
  })

  it('retries a replacement that failed after the old address disappeared', async () => {
    const events: string[] = []
    let selected = 'old'
    let failReplacement = true
    const following = new FollowingMobileAccessRuntime(async () => {
      const key = selected
      return {
        key,
        start: async () => {
          events.push(`start:${key}`)
          if (key === 'new' && failReplacement) {
            failReplacement = false
            throw new Error('address not ready')
          }
          return runtime(() => { events.push(`stop:${key}`) })
        },
      }
    }, error => { throw error })

    await following.initialize()
    selected = 'new'
    await expect(following.refresh()).rejects.toThrow('address not ready')
    await following.refresh()
    await following.close()

    expect(events).toEqual(['start:old', 'stop:old', 'start:new', 'start:new', 'stop:new'])
  })

  it('recovers through beginPolling when the first selection is down', async () => {
    const events: string[] = []
    let networkUp = false
    const errors: unknown[] = []
    const following = new FollowingMobileAccessRuntime(async () => {
      if (!networkUp) throw new Error('saved LAN interface "WLAN 3" is not connected')
      return {
        key: 'up',
        start: async () => {
          events.push('start:up')
          return runtime(() => { events.push('stop:up') })
        },
      }
    }, error => { errors.push(error) })

    // Boot path: initial selection fails, poller stays armed instead of throwing.
    following.beginPolling(10)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(events).toEqual([])
    expect(errors.length).toBeGreaterThan(0)

    // The saved interface returns: the next poll starts the gateway on its own.
    networkUp = true
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(events).toEqual(['start:up'])
    await following.close()
    expect(events).toEqual(['start:up', 'stop:up'])
  })
})
