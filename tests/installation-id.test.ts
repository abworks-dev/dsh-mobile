import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadOrCreateInstallationId } from '../src/installation-id.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function installationFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mobile-installation-id-'))
  temporaryDirectories.push(directory)
  return join(directory, 'installation-id')
}

describe('plugin installation identity', () => {
  it('persists one private random ID across repeated loads', async () => {
    const file = await installationFile()
    const first = await loadOrCreateInstallationId(file)
    expect(first).toMatch(/^[a-f0-9]{64}$/u)
    expect(await readFile(file, 'utf8')).toBe(`${first}\n`)
    expect(await loadOrCreateInstallationId(file)).toBe(first)
  })

  it('creates different IDs in separate private roots', async () => {
    const first = await loadOrCreateInstallationId(await installationFile())
    const second = await loadOrCreateInstallationId(await installationFile())
    expect(first).not.toBe(second)
  })

  it('rejects invalid, oversized, and non-file markers without replacing them', async () => {
    const invalid = await installationFile()
    await writeFile(invalid, `${'A'.repeat(64)}\n`)
    await expect(loadOrCreateInstallationId(invalid)).rejects.toThrow('installation_id_invalid')
    expect(await readFile(invalid, 'utf8')).toBe(`${'A'.repeat(64)}\n`)

    const oversized = await installationFile()
    await writeFile(oversized, `${'a'.repeat(65)}\n`)
    await expect(loadOrCreateInstallationId(oversized)).rejects.toThrow('installation_id_invalid')

    const directory = await installationFile()
    await mkdir(directory)
    await expect(loadOrCreateInstallationId(directory)).rejects.toThrow('installation_id_invalid')
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink marker', async () => {
    const target = await installationFile()
    await writeFile(target, `${'a'.repeat(64)}\n`)
    const link = await installationFile()
    await symlink(target, link)
    await expect(loadOrCreateInstallationId(link)).rejects.toThrow('installation_id_invalid')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
  })
})
