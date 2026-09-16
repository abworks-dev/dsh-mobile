import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOUDFLARED_COMPONENT_RELEASE, CloudflaredComponentManager } from '../src/cloudflared-component.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function stateDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-cloudflared-component-'))
  temporaryDirectories.push(directory)
  return directory
}

/** The staging root is private; the purge contract still needs it observed. */
function stagingRoot(manager: CloudflaredComponentManager): string {
  return (manager as unknown as { readonly stagingRoot: string }).stagingRoot
}

async function missing(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

describe('managed cloudflared component', () => {
  it('pins the official release for Windows x64 only', () => {
    expect(CLOUDFLARED_COMPONENT_RELEASE.version).toMatch(/^\d{4}\.\d+\.\d+$/u)
    expect(CLOUDFLARED_COMPONENT_RELEASE.platform).toBe('win32')
    expect(CLOUDFLARED_COMPONENT_RELEASE.arch).toBe('x64')
    expect(CLOUDFLARED_COMPONENT_RELEASE.downloadUrl).toBe(
      `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_COMPONENT_RELEASE.version}/cloudflared-windows-amd64.exe`,
    )
    expect(CLOUDFLARED_COMPONENT_RELEASE.downloadUrl).toMatch(/^https:\/\/github\.com\/cloudflare\/cloudflared\//u)
    expect(CLOUDFLARED_COMPONENT_RELEASE.downloadSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(CLOUDFLARED_COMPONENT_RELEASE.downloadBytes).toBeGreaterThan(0)
  })

  it('reports an uninstalled component without touching the network', async () => {
    const directory = await stateDirectory()
    const fetchArtifact = vi.fn()
    const manager = new CloudflaredComponentManager({ stateDirectory: directory, platform: 'win32', arch: 'x64', fetchArtifact })
    await manager.initialize()
    expect(manager.status()).toMatchObject({ supported: true, installed: false })
    expect(manager.status().storagePath).toContain('cloudflared')
    expect(fetchArtifact).not.toHaveBeenCalled()
  })

  it('refuses unsupported hosts before downloading anything', async () => {
    const directory = await stateDirectory()
    const fetchArtifact = vi.fn()
    const manager = new CloudflaredComponentManager({ stateDirectory: directory, platform: 'linux', arch: 'x64', fetchArtifact })
    await manager.initialize()
    expect(manager.status()).toMatchObject({ supported: false, installed: false })
    await expect(manager.install()).rejects.toThrow('cloudflared_component_unsupported')
    expect(fetchArtifact).not.toHaveBeenCalled()
  })

  it('rejects an artifact whose size does not match the pinned bytes', async () => {
    const directory = await stateDirectory()
    const manager = new CloudflaredComponentManager({
      stateDirectory: directory,
      platform: 'win32',
      arch: 'x64',
      fetchArtifact: async () => new Uint8Array(16),
    })
    await manager.initialize()
    await expect(manager.install()).rejects.toThrow('cloudflared_download_size_mismatch')
    expect(manager.status().installed).toBe(false)
    expect(await missing(manager.executable)).toBe(true)
    // A refused install leaves the shared staging root empty, not removed.
    expect(await readdir(stagingRoot(manager))).toEqual([])
  })

  it('rejects an artifact whose digest does not match the pinned hash', async () => {
    const directory = await stateDirectory()
    const manager = new CloudflaredComponentManager({
      stateDirectory: directory,
      platform: 'win32',
      arch: 'x64',
      // Correct length, wrong bytes: the size gate passes, so this exercises the
      // digest gate. The buffer is allocated at the real pinned size deliberately.
      fetchArtifact: async () => new Uint8Array(CLOUDFLARED_COMPONENT_RELEASE.downloadBytes),
    })
    await manager.initialize()
    await expect(manager.install()).rejects.toThrow('cloudflared_download_hash_mismatch')
    expect(manager.status().installed).toBe(false)
    // Nothing unverified may survive at the published path or in staging.
    expect(await missing(manager.executable)).toBe(true)
    expect(await readdir(stagingRoot(manager))).toEqual([])
  })

  it('detects a planted executable that is not the pinned release', async () => {
    const directory = await stateDirectory()
    const manager = new CloudflaredComponentManager({ stateDirectory: directory, platform: 'win32', arch: 'x64' })
    await mkdir(manager.componentStorage, { recursive: true })
    // Exactly the pinned length but not the pinned bytes: the size gate cannot
    // catch this, so initialization must fall back to the digest.
    await writeFile(manager.executable, Buffer.alloc(CLOUDFLARED_COMPONENT_RELEASE.downloadBytes, 0x41))
    await manager.initialize()
    expect(manager.status()).toMatchObject({ installed: false, errorCode: 'cloudflared_component_invalid' })
  })

  it('reports a wrong-length planted executable as simply not installed', async () => {
    const directory = await stateDirectory()
    const manager = new CloudflaredComponentManager({ stateDirectory: directory, platform: 'win32', arch: 'x64' })
    await mkdir(manager.componentStorage, { recursive: true })
    await writeFile(manager.executable, 'not-the-real-cloudflared')
    await manager.initialize()
    expect(manager.status()).toMatchObject({ installed: false })
    expect(manager.status().errorCode).toBeUndefined()
  })

  it('purges every owned cloudflared directory', async () => {
    const directory = await stateDirectory()
    const manager = new CloudflaredComponentManager({ stateDirectory: directory, platform: 'win32', arch: 'x64' })
    await Promise.all([
      mkdir(manager.componentStorage, { recursive: true }),
      mkdir(manager.stateRoot, { recursive: true }),
      mkdir(manager.logRoot, { recursive: true }),
      mkdir(stagingRoot(manager), { recursive: true }),
    ])
    await writeFile(join(manager.componentStorage, 'cloudflared.exe'), 'planted')
    await manager.purge()
    expect(manager.status()).toMatchObject({ installed: false })
    for (const path of [manager.componentRoot, manager.stateRoot, manager.logRoot, stagingRoot(manager)]) {
      expect(await missing(path)).toBe(true)
    }
  })

  it('exposes one pinned byte/digest pair because the artifact is the executable', async () => {
    const directory = await stateDirectory()
    const manager = new CloudflaredComponentManager({ stateDirectory: directory, platform: 'win32', arch: 'x64' })
    await manager.initialize()
    const status = manager.status()
    expect(status.downloadBytes).toBe(status.installedBytes)
    expect(status.sourceUrl).toBe(CLOUDFLARED_COMPONENT_RELEASE.downloadUrl)
    // No account credential exists anywhere in the public status.
    expect(JSON.stringify(status)).not.toContain('token')
    expect(manager.executable.startsWith(directory)).toBe(true)
    expect(manager.executable).toContain(CLOUDFLARED_COMPONENT_RELEASE.version)
  })
})
