import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { restrictPrivateFile } from './private-file.js'

const INSTALLATION_ID_PATTERN = /^[a-f0-9]{64}\n$/u
const INSTALLATION_ID_BYTES = 65

async function readInstallationId(file: string): Promise<string> {
  const entry = await lstat(file)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size !== INSTALLATION_ID_BYTES) {
    throw new Error('installation_id_invalid')
  }
  const contents = await readFile(file, 'utf8')
  if (!INSTALLATION_ID_PATTERN.test(contents)) throw new Error('installation_id_invalid')
  await restrictPrivateFile(file)
  return contents.slice(0, -1)
}

/** Keep one random plugin identity across setup changes, restarts, and FRP resets. */
export async function loadOrCreateInstallationId(file: string): Promise<string> {
  if (!isAbsolute(file)) throw new Error('installation ID path must be absolute')
  const target = resolve(file)
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  try {
    await writeFile(target, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  return readInstallationId(target)
}
