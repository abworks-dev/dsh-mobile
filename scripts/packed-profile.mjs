import { spawn } from 'node:child_process'
import { access, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Run one owned packaging command and await its exit, including on timeout. */
export async function runPackagingCommand(command, args, cwd) {
  const environment = { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' }
  for (const name of Object.keys(environment)) {
    if (/(?:KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)) delete environment[name]
  }
  const child = spawn(command, args, {
    cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: environment,
  })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout = `${stdout}${chunk}`.slice(-40_000) })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-40_000) })
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 180_000)
  try {
    const result = await new Promise((fulfill, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { fulfill({ code, signal }) })
    })
    if (timedOut || result.code !== 0 || result.signal !== null) {
      throw new Error(`Packaging command failed (${JSON.stringify({ ...result, timedOut })}): ${command}\n${stdout}\n${stderr}`)
    }
    return stdout
  } finally { clearTimeout(timer) }
}

/** Locate npm's JavaScript entry so Windows runs it without a command shell. */
export async function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  for (const candidate of candidates) {
    if (candidate === undefined || !candidate.endsWith('npm-cli.js')) continue
    try { await access(candidate) } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    return candidate
  }
  throw new Error('Cannot locate npm-cli.js; run this smoke through npm run smoke:dsh-boot')
}

/** Produce the actual npm tarball; npm's files rules select every shipped file. */
export async function packBundle(source, destination) {
  const output = await runPackagingCommand(process.execPath, [
    await npmCli(), 'pack', '--ignore-scripts', '--json', '--pack-destination', destination,
  ], source)
  const [packed] = JSON.parse(output)
  if (typeof packed?.filename !== 'string' || /[/\\]/u.test(packed.filename)) {
    throw new Error('npm pack returned no package filename')
  }
  return join(destination, packed.filename)
}

/** Install the tarball into the profile, including its real runtime dependencies. */
export async function installPackedBundle(tarball, profile) {
  await runPackagingCommand(process.execPath, [
    await npmCli(), 'install', '--ignore-scripts', '--legacy-peer-deps', '--omit=dev',
    '--no-audit', '--no-fund', '--package-lock=false', resolve(tarball),
  ], profile)
}

function contained(directory, file) {
  const path = relative(directory, file)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

/** Reject missing bundled components and workspace/global copies that mask them. */
export async function assertBundledComponents(installed) {
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'))
  const require = createRequire(join(installed, 'package.json'))
  for (const name of manifest.bundledDependencies ?? []) {
    const expected = join(installed, 'node_modules', name)
    let root
    try { root = await realpath(expected) } catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Packed bundle is missing nested component ${name}`)
      throw error
    }
    if (!contained(await realpath(installed), root)) {
      throw new Error(`Packed component ${name} resolves outside the installed bundle: ${root}`)
    }
    for (const specifier of [name, `${name}/client`, `${name}/package.json`]) {
      const file = await realpath(require.resolve(specifier))
      if (!contained(root, file)) throw new Error(`Packed component ${specifier} resolves outside its nested package: ${file}`)
    }
  }
}
