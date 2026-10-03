import { lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const helperUrl = new URL('../scripts/mobile-boot-fixture.mjs', import.meta.url)
const fixture: {
  removeTemporaryRoot: (root: string, prefix?: string) => Promise<void>
  sanitized: (text: string) => string
} = await import(helperUrl.href)
const roots: string[] = []
const prefix = 'dsh-mobile-fixture-test-'

afterEach(async () => { for (const root of roots.splice(0)) await fixture.removeTemporaryRoot(root, prefix) })

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

describe('owned Mobile development fixture', () => {
  it('removes projected links without deleting their outside target', async () => {
    const root = await temporaryRoot()
    const outside = await temporaryRoot()
    const kept = join(outside, 'kept.txt')
    await writeFile(kept, 'keep outside data')
    await mkdir(join(root, 'profile', 'node_modules'), { recursive: true })
    await symlink(outside, join(root, 'profile', 'node_modules', 'projected'), process.platform === 'win32' ? 'junction' : 'dir')
    await fixture.removeTemporaryRoot(root, prefix)
    roots.splice(roots.indexOf(root), 1)
    expect(await readFile(kept, 'utf8')).toBe('keep outside data')
    await expect(lstat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a temporary path whose owner prefix does not match', async () => {
    const root = await temporaryRoot()
    await expect(fixture.removeTemporaryRoot(root, 'different-owner-')).rejects.toThrow('outside this owned temporary root')
    expect((await lstat(root)).isDirectory()).toBe(true)
  })

  it('redacts launch tokens and pairing fragments from error output', () => {
    const message = fixture.sanitized('http://127.0.0.1/?token=launch-secret /pair#token=pair-secret&label=demo /pair#key=key-secret')
    expect(message).not.toContain('launch-secret')
    expect(message).not.toContain('pair-secret')
    expect(message).not.toContain('key-secret')
    expect(message).toContain('&label=demo')
  })
})
