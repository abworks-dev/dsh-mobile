import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { execFileText } from '../src/exec-file.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash'
const unixPath = (path: string) => path.replaceAll('\\', '/').replace(/^([A-Za-z]):/u, (_, drive: string) => '/' + drive.toLowerCase())
const sha = 'b'.repeat(40)

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
  for (const scenario of ['occupied', 'api401', 'api403', 'api500', 'network', 'wrong-tag', 'fail-create', 'fail-upload', 'fail-download', 'diff', 'fail-edit', 'verify-fail', 'valid']) {
    const work = join(root, scenario); await mkdir(work)
    await mkdir(join(work, 'component-release')); await writeFile(join(work, 'component-release', 'asset'), 'known reviewed bytes')
    const log = join(work, 'calls'); await writeFile(log, '')
    let success = false
    try {
      await execFileText(bash, [unixPath(script)], { env: { ...process.env, CASE: scenario, FAKE_BIN: unixPath(bin),
        RUNNER_TEMP: unixPath(work), CALL_LOG: unixPath(log), SOURCE_COMMIT: sha, GH_REPO: 'abworks-dev/dsh-mobile',
        COMPONENT_TAG: 'caddy-component-2.11.6-tencentcloud-0.4.3-review.1', RUN_ID: '123', RUN_ATTEMPT: '1', GH_TOKEN: 'synthetic-only' }, timeout: 15_000 })
      success = true
    } catch { /* Deliberately failed external tools are the boundary under test. */ }
    const calls = await readFile(log, 'utf8')
    expect(success, scenario).toBe(scenario === 'valid')
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
