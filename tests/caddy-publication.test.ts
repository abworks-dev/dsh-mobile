import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { execFileText } from '../src/exec-file.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const unixPath = (path: string) => path.replaceAll('\\', '/').replace(/^([A-Za-z]):/u, (_, drive: string) => '/' + drive.toLowerCase())
const sha = 'b'.repeat(40)

function gitBashPath(execPath: string): string {
  return win32.resolve(execPath.trim(), '../../../bin/bash.exe')
}

async function publisherBash(): Promise<string> {
  if (process.platform !== 'win32') return '/bin/bash'
  // Git identifies its own installation; a bare bash may select the Windows WSL launcher.
  const { stdout } = await execFileText('git', ['--exec-path'], { timeout: 10_000 })
  if (!win32.isAbsolute(stdout.trim())) throw new Error('Git for Windows returned no absolute exec path')
  return gitBashPath(stdout)
}

function deliberateExitCode(error: unknown): number {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'number'
    || error.code === 0 || ('killed' in error && error.killed === true)
    || ('signal' in error && error.signal !== null && error.signal !== undefined)) throw error
  return error.code
}

function publisherEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(base)
    .filter(([key]) => !['BASH_ENV', 'ENV'].includes(key.toUpperCase())))
}

it('locates Git Bash within default, custom and per-user Git installations', () => {
  expect(gitBashPath('C:/Program Files/Git/mingw64/libexec/git-core')).toBe('C:\\Program Files\\Git\\bin\\bash.exe')
  expect(gitBashPath('C:/develop/Git/mingw64/libexec/git-core\n')).toBe('C:\\develop\\Git\\bin\\bash.exe')
  expect(gitBashPath('C:/Users/test/AppData/Local/Programs/Git/mingw32/libexec/git-core')).toBe('C:\\Users\\test\\AppData\\Local\\Programs\\Git\\bin\\bash.exe')
})

it('does not treat a missing shell or an interrupted child as a publisher rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'caddy-missing-shell-')); roots.push(root)
  await expect(execFileText(join(root, 'missing-bash'), [], { timeout: 5_000 })
    .catch(error => deliberateExitCode(error))).rejects.toMatchObject({ code: 'ENOENT' })
  for (const details of [{ code: 1, killed: true }, { code: 1, signal: 'SIGTERM' }, { code: 0 }]) {
    const error = Object.assign(new Error('child did not exit deliberately'), details)
    expect(() => deliberateExitCode(error)).toThrow(error)
  }
  expect(deliberateExitCode(Object.assign(new Error('expected tool failure'), { code: 7, killed: false, signal: null }))).toBe(7)
})

it('removes inherited Bash startup hooks without changing the parent environment', () => {
  const base = { PATH: 'test-path', BASH_ENV: 'user-startup.sh', Env: 'other-startup.sh' }
  expect(publisherEnvironment(base)).toEqual({ PATH: 'test-path' })
  expect(base.BASH_ENV).toBe('user-startup.sh')
  expect(base.Env).toBe('other-startup.sh')
})

function stepBody(workflow: string, name: string) {
  workflow = workflow.replaceAll('\r\n', '\n')
  const start = workflow.indexOf('      - name: ' + name)
  if (start < 0) throw new Error('Publisher step missing')
  const lines = workflow.slice(start).split('\n')
  const run = lines.findIndex(line => line === '        run: |')
  if (run < 0) throw new Error('Publisher script missing')
  const body: string[] = []
  for (const line of lines.slice(run + 1)) {
    if (line !== '' && !line.startsWith('          ')) break
    body.push(line.slice(10))
  }
  return body.join('\n')
}

it('executes actual publisher shell with fake gh and fails closed before public edit', async () => {
  const bash = await publisherBash()
  const shellEnvironment = publisherEnvironment(process.env)
  // Missing executables and broken shell setup are prerequisites, not passing negative cases.
  await execFileText(bash, ['--noprofile', '--norc', '-c', 'true'], { env: shellEnvironment, timeout: 10_000 })
  const workflow = await readFile(new URL('../.github/workflows/caddy-component.yml', import.meta.url), 'utf8')
  expect(workflow).toContain("github.event_name == 'workflow_dispatch' && inputs.publish_review_prerelease && github.repository == 'abworks-dev/dsh-mobile'")
  expect(workflow).toContain('default: false')
  expect(workflow).toContain('needs: caddy-review-artifact')
  expect(workflow).toContain('persist-credentials: false')
  const body = stepBody(workflow, 'Create new draft component prerelease without overwriting releases or assets') + '\n' +
    stepBody(workflow, 'Publish prerelease then verify actual installer HTTPS downloads and emit review-only catalog')
  const root = await mkdtemp(join(tmpdir(), 'caddy-publish-test-')); roots.push(root)
  const bin = join(root, 'bin'); await mkdir(bin)
  const gh = join(bin, 'gh')
  await writeFile(gh, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALL_LOG"
if [[ "$1" == api ]]; then
  if [[ "$*" == *'/commits/'* ]]; then
    if [[ "$CASE" == wrong-tag ]]; then printf '%040d\\n' 0; else printf '%s\\n' "$SOURCE_COMMIT"; fi
    exit 0
  fi
  case "$CASE" in
    occupied) printf '{}\\n'; exit 0;;
    api401) printf 'HTTP/2.0 401 Unauthorized\\n' >&2; exit 1;;
    api403) printf 'HTTP/2.0 403 Forbidden\\n' >&2; exit 1;;
    api500) printf 'HTTP/2.0 500 Internal Server Error\\n' >&2; exit 1;;
    network) printf 'connection failed\\n' >&2; exit 1;;
    *) printf 'HTTP/2.0 404 Not Found\\n' >&2; exit 1;;
  esac
fi
[[ "$1" == release ]] || exit 9
if [[ "$CASE" == "fail-$2" ]]; then exit 7; fi
if [[ "$2" == download ]]; then
  mkdir "$RUNNER_TEMP/draft-download"
  cp "$RUNNER_TEMP/component-release/"* "$RUNNER_TEMP/draft-download/"
  if [[ "$CASE" == diff ]]; then printf 'different' > "$RUNNER_TEMP/draft-download/asset"; fi
fi
`)
  const node = join(bin, 'node')
  await writeFile(node, `#!/usr/bin/env bash
set -euo pipefail
printf 'verify\\n' >> "$CALL_LOG"
if [[ "$CASE" == verify-fail ]]; then exit 8; fi
printf '{}' > "$RUNNER_TEMP/caddy-review-catalog.json"
`)
  await chmod(gh, 0o700); await chmod(node, 0o700)
  const script = join(root, 'publish.sh')
  await writeFile(script, 'export PATH="$FAKE_BIN:$PATH"\n' + body)
  const scenarios = [
    ['occupied', 1], ['api401', 1], ['api403', 1], ['api500', 1], ['network', 1], ['wrong-tag', 1],
    ['fail-create', 7], ['fail-upload', 7], ['fail-download', 7], ['diff', 1], ['fail-edit', 7],
    ['verify-fail', 8], ['valid', 0],
  ] as const
  for (const [scenario, expectedExitCode] of scenarios) {
    const work = join(root, scenario); await mkdir(work)
    await mkdir(join(work, 'component-release')); await writeFile(join(work, 'component-release', 'asset'), 'known reviewed bytes')
    const log = join(work, 'calls'); await writeFile(log, '')
    let exitCode = 0
    try {
      await execFileText(bash, ['--noprofile', '--norc', unixPath(script)], { env: { ...shellEnvironment, CASE: scenario, FAKE_BIN: unixPath(bin),
        RUNNER_TEMP: unixPath(work), CALL_LOG: unixPath(log), SOURCE_COMMIT: sha, GH_REPO: 'abworks-dev/dsh-mobile',
        COMPONENT_TAG: 'caddy-component-2.11.6-tencentcloud-0.4.3-review.1', RUN_ID: '123', RUN_ATTEMPT: '1', GH_TOKEN: 'synthetic-only' }, timeout: 15_000 })
    } catch (error) { exitCode = deliberateExitCode(error) }
    const calls = await readFile(log, 'utf8')
    expect(exitCode, scenario).toBe(expectedExitCode)
    const reachedPublicEdit = ['valid', 'fail-edit', 'verify-fail'].includes(scenario)
    expect(calls.includes('release edit '), scenario).toBe(reachedPublicEdit)
    expect(calls.includes('verify\n'), scenario).toBe(['valid', 'verify-fail'].includes(scenario))
    if (calls.includes('release create ')) {
      expect(calls).toContain('--verify-tag --draft --prerelease --latest=false')
      expect(calls).not.toContain('--clobber')
    }
    if (scenario === 'valid') expect((await lstat(join(work, 'caddy-review-catalog.json'))).isFile()).toBe(true)
    else await expect(lstat(join(work, 'caddy-review-catalog.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(calls).not.toContain('synthetic-only')
  }
}, 45_000)
