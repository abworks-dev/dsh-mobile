import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { execFileText } from '../src/exec-file.js'
import { afterEach, describe, expect, it } from 'vitest'

const inputHelpers = await import(new URL('../scripts/caddy-component-build-inputs.mjs', import.meta.url).href)
const helpers = await import(new URL('../scripts/caddy-component-artifacts.mjs', import.meta.url).href)
const lock = inputHelpers.CADDY_BUILD_LOCK
const { sha256, buildLockSha256, reviewTag, verifyArtifact, readArtifact } = helpers
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

function fixture(platform = 'win32') {
  const binary = Buffer.from('pinned-test-bytes')
  const deps = ['caddy', 'tencentcloud'].map(name => ({ Path: lock.sources[name].path, Version: lock.sources[name].version, Sum: lock.sources[name].sum }))
  const build = { GoVersion: lock.toolchain, Main: { Path: 'caddy' }, Deps: deps,
    Settings: Object.entries({ '-buildmode': 'exe', '-compiler': 'gc', '-trimpath': 'true', CGO_ENABLED: '0',
      GOOS: platform === 'win32' ? 'windows' : 'linux', GOARCH: 'amd64', GOAMD64: 'v1' }).map(([Key, Value]) => ({ Key, Value })) }
  const manifest = { version: lock.core.slice(1), dnsPluginVersion: lock.dns, xcaddyVersion: lock.xcaddy, goVersion: lock.toolchain,
    platform, arch: 'x64', executableName: platform === 'win32' ? 'caddy.exe' : 'caddy', downloadBytes: binary.length,
    executableBytes: binary.length, downloadSha256: sha256(binary), executableSha256: sha256(binary),
    sourceProvenanceVerified: true, buildLockSha256: buildLockSha256(), publication: 'not-published',
    sourceRevisions: Object.fromEntries(Object.entries(lock.sources).map(([name, pin]) => [name, (pin as { revision: string }).revision])),
    dependencies: deps.map(dep => ({ path: dep.Path, version: dep.Version, sum: dep.Sum, licenses: ['LICENSE'] })),
  }
  return { binary, manifest, build }
}

async function diskFixture(platform = 'win32') {
  const root = await mkdtemp(join(tmpdir(), 'caddy-artifact-test-')); roots.push(root)
  const data = fixture(platform)
  const licenses = ['DSH Mobile optional managed Caddy - embedded dependency licenses', '',
    ...data.manifest.dependencies.map(dep => `${dep.path}@${dep.version} / LICENSE\nSHA-256: ${'a'.repeat(64)}\nfixture license`),
    `Go ${lock.toolchain} / LICENSE\nfixture license`, `Go ${lock.toolchain} / PATENTS\nfixture patents`, ''].join('\n')
  const files = { 'manifest.json': JSON.stringify(data.manifest), 'go-build.json': JSON.stringify(data.build),
    'version.txt': lock.core + ' ' + lock.sources.caddy.sum + '\n',
    'modules.txt': 'tls.issuance.internal ' + lock.core + '\n  Standard modules: 1\n\ndns.providers.tencentcloud ' + lock.dns + '\n  Non-standard modules: 1\n',
    'THIRD_PARTY_LICENSES.txt': licenses, [data.manifest.executableName]: data.binary }
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(root, name), bytes)
  return { root, data }
}

async function cli(name: string, args: string[]) {
  return execFileText(process.execPath, [fileURLToPath(new URL('../scripts/' + name, import.meta.url)), ...args], { timeout: 15_000 })
}

async function provedFixture(platform: string) {
  const first = await diskFixture(platform)
  const second = await diskFixture(platform)
  await cli('compare-caddy-builds.mjs', ['--first', first.root, '--second', second.root, '--target', platform + '-x64'])
  return first
}

describe('review component artifact binding', () => {
  it('requires exact version-bound review tags that cannot trigger v* plugin releases', () => {
    expect(reviewTag('caddy-component-2.11.6-tencentcloud-0.4.3-review.1')).toContain('-review.1')
    for (const tag of ['v0.6.1', 'latest', 'caddy-component-2.11.7-tencentcloud-0.4.3-review.1',
      'caddy-component-2.11.6-tencentcloud-0.4.3-review.0', 'caddy-component-2.11.6-tencentcloud-0.4.3-review.01']) {
      expect(() => reviewTag(tag)).toThrow('review tag')
    }
  })
  it.each(['win32', 'linux'])('binds metadata, raw bytes, source and graph for %s', platform => {
    const data = fixture(platform)
    expect(() => verifyArtifact(data.manifest, data.build, data.binary, platform + '-x64')).not.toThrow()
  })
  it('rejects incorrect size/hash, metadata, target, source revision and build lock', () => {
    const { manifest, build, binary } = fixture()
    for (const override of [{ version: '2.11.7' }, { sourceProvenanceVerified: false }, { platform: 'linux' },
      { executableName: 'renamed.exe' }, { downloadBytes: binary.length + 1 }, { executableSha256: 'a'.repeat(64) },
      { buildLockSha256: 'a'.repeat(64) }, { sourceRevisions: {} }, { publication: 'published' }, { dependencies: [] }]) {
      expect(() => verifyArtifact({ ...manifest, ...override }, build, binary, 'win32-x64')).toThrow()
    }
    const corrupted = Buffer.from(binary); corrupted[0] = corrupted[0]! ^ 1
    expect(() => verifyArtifact(manifest, build, corrupted, 'win32-x64')).toThrow('SHA-256 mismatch')
    expect(() => verifyArtifact(manifest, build, binary, 'darwin-x64')).toThrow()
  })
  it('reads a complete bounded artifact without executing fake bytes', async () => {
    const { root, data } = await diskFixture()
    const result = await readArtifact(root, 'win32-x64')
    expect(result.files.get('caddy.exe')).toEqual(data.binary)
  })
  it('rejects missing independent-build evidence in a publication input', async () => {
    const { root } = await diskFixture()
    await expect(readArtifact(root, 'win32-x64', true)).rejects.toThrow('Unexpected')
  })
  it('rejects false independent-build proof even when binary hashes agree', async () => {
    const { root, data } = await diskFixture()
    await writeFile(join(root, 'reproducibility.json'), JSON.stringify({ schemaVersion: 1, target: 'win32-x64', independentBuilds: 1,
      buildLockSha256: buildLockSha256(), bytes: data.binary.length, firstSha256: sha256(data.binary), secondSha256: sha256(data.binary) }))
    await expect(readArtifact(root, 'win32-x64', true)).rejects.toThrow('reproducibility evidence mismatch')
  })
  it('rejects unexpected file or remaining work directories', async () => {
    const { root } = await diskFixture(); await mkdir(join(root, '.build-leftover'))
    await expect(readArtifact(root, 'win32-x64')).rejects.toThrow('Unexpected')
  })
  it('rejects forged version, module and missing license evidence', async () => {
    const { root } = await diskFixture()
    const original = await readFile(join(root, 'version.txt'))
    await writeFile(join(root, 'version.txt'), 'v2.11.7 fake')
    await expect(readArtifact(root, 'win32-x64')).rejects.toThrow('version evidence')
    await writeFile(join(root, 'version.txt'), original)
    await writeFile(join(root, 'modules.txt'), 'dns.providers.tencentcloud v0.4.3\nNon-standard modules: 2\n')
    await expect(readArtifact(root, 'win32-x64')).rejects.toThrow('DNS module evidence')
    await writeFile(join(root, 'modules.txt'), 'tls.issuance.internal ' + lock.core + '\n  Standard modules: 1\n\ndns.providers.tencentcloud ' + lock.dns + '\n  Non-standard modules: 1\n')
    await writeFile(join(root, 'THIRD_PARTY_LICENSES.txt'), 'missing licenses')
    await expect(readArtifact(root, 'win32-x64')).rejects.toThrow('license evidence')
  })
  it('rejects extra nonstandard modules even with a forged count of one', async () => {
    const { root } = await diskFixture()
    const original = await readFile(join(root, 'modules.txt'), 'utf8')
    for (const addition of ['dns.providers.cloudflare v1.0.0\n', 'Non-standard modules: 1\n', 'Standard modules: 1\n']) {
      await writeFile(join(root, 'modules.txt'), original + addition)
      await expect(readArtifact(root, 'win32-x64')).rejects.toThrow('DNS module evidence')
    }
  })
  it('rejects empty license sections, malformed digests and duplicate headings', async () => {
    const { root } = await diskFixture()
    const original = await readFile(join(root, 'THIRD_PARTY_LICENSES.txt'), 'utf8')
    for (const changed of [original.replaceAll('fixture license', ''), original.replaceAll('a'.repeat(64), 'invalid'),
      original + '\nGo ' + lock.toolchain + ' / LICENSE\nfixture license\n']) {
      await writeFile(join(root, 'THIRD_PARTY_LICENSES.txt'), changed)
      await expect(readArtifact(root, 'win32-x64')).rejects.toThrow('license evidence')
    }
  })
  it('runs the actual comparison CLI and rejects identical directories or a previous report', async () => {
    const first = await provedFixture('win32')
    expect((await readArtifact(first.root, 'win32-x64', true)).manifest.executableSha256).toBe(sha256(first.data.binary))
    await expect(cli('compare-caddy-builds.mjs', ['--first', first.root, '--second', first.root, '--target', 'win32-x64'])).rejects.toThrow('Independent')
    const second = await diskFixture()
    await expect(cli('compare-caddy-builds.mjs', ['--first', first.root, '--second', second.root, '--target', 'win32-x64'])).rejects.toThrow('Unexpected')
  })
  it('prepares exactly both platform proofs through the real CLI and never overwrites existing output', async () => {
    const wrapper = await mkdtemp(join(tmpdir(), 'caddy-release-input-')); roots.push(wrapper)
    const input = join(wrapper, 'input'); await mkdir(input)
    for (const platform of ['linux', 'win32']) {
      const proved = await provedFixture(platform)
      await cp(proved.root, join(input, 'managed-caddy-review-' + platform + '-x64'), { recursive: true })
    }
    const output = join(wrapper, 'prepared')
    const args = ['--input-dir', input, '--output-dir', output, '--repository', 'abworks-dev/dsh-mobile',
      '--tag', 'caddy-component-2.11.6-tencentcloud-0.4.3-review.1', '--commit', 'b'.repeat(40), '--run-id', '123', '--run-attempt', '1']
    await cli('prepare-caddy-release.mjs', args)
    const index = JSON.parse(await readFile(join(output, 'COMPONENT-RELEASE.json'), 'utf8'))
    expect(Object.keys(index.binaryAssets).sort()).toEqual(['linux-x64', 'win32-x64'])
    expect(index.productionCatalogEnabled).toBe(false)
    const original = await readFile(join(output, 'SHA256SUMS'))
    await expect(cli('prepare-caddy-release.mjs', args)).rejects.toThrow()
    expect(await readFile(join(output, 'SHA256SUMS'))).toEqual(original)
    const bad = [...args]; bad[5] = '../foreign/repo'
    await expect(cli('prepare-caddy-release.mjs', bad)).rejects.toThrow('identity')
    const wrongTag = [...args]; wrongTag[7] = 'v0.6.1'
    await expect(cli('prepare-caddy-release.mjs', wrongTag)).rejects.toThrow('review tag')
    const missing = await mkdtemp(join(tmpdir(), 'caddy-release-missing-')); roots.push(missing)
    await cp(join(input, 'managed-caddy-review-win32-x64'), join(missing, 'managed-caddy-review-win32-x64'), { recursive: true })
    const missingArgs = [...args]; missingArgs[1] = missing
    await expect(cli('prepare-caddy-release.mjs', missingArgs)).rejects.toThrow('both native platform')
    await mkdir(join(input, 'foreign-target'))
    await expect(cli('prepare-caddy-release.mjs', args)).rejects.toThrow('both native platform')
  })
  it.runIf(process.platform !== 'win32')('refuses symlinked metadata rather than reading its target', async () => {
    const { root } = await diskFixture()
    const outside = join(root, 'outside.json')
    await writeFile(outside, '{}'); await rm(join(root, 'manifest.json'))
    await symlink(outside, join(root, 'manifest.json')); await rm(outside)
    await expect(readArtifact(root, 'win32-x64')).rejects.toThrow('Invalid')
  })
})
