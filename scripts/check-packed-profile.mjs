import { realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [dshBin, profileDir, home] = process.argv.slice(2)
if (dshBin === undefined || profileDir === undefined || home === undefined) {
  throw new Error('Usage: check-packed-profile.mjs <dsh-bin> <profile> <home>')
}
const require = createRequire(dshBin)
const installation = require.resolve('@deepseek-ai/dsh/package.json')
const { loadProfileDirectory, createRuntimeResolution, PluginPackages } = await import(
  pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot'))
)
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
const { ModuleLoader } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis-plugin-loader')))
const { ClientModuleRegistry } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-client-modules')))
const profile = loadProfileDirectory('dsh', profileDir, installation)
const installed = await realpath(join(profileDir, 'node_modules', 'dsh-mobile'))
const selected = profile.layers.find(layer => layer.packageName === 'dsh-mobile')
if (selected === undefined || await realpath(selected.packageDir) !== installed) {
  throw new Error('DSH selected Mobile outside the installed test profile; install the DSH runtime without dsh-mobile')
}
const resolution = await createRuntimeResolution({ installAnchor: installation, profile, home })
const context = new Context()
const baseUrl = `${pathToFileURL(profileDir).href}/`
context.baseUrl = baseUrl
try {
  new PluginPackages(context, { resolution })
  const internal = ModuleLoader.fromInternal()
  if (internal === undefined) throw new Error('DSH internal module resolver is unavailable')
  const entry = resolution.entries.find(candidate => candidate.name === 'dsh-mobile-question-fixes')
  const expected = await realpath(join(installed, 'node_modules', 'dsh-mobile-question-fixes'))
  if (entry === undefined || await realpath(entry.packageDir) !== expected) {
    throw new Error('DSH resolved the question-card component outside the installed Mobile bundle')
  }
  const node = await internal.import('dsh-mobile-question-fixes', baseUrl, {})
  if (typeof node.apply !== 'function') throw new Error('Packed question-card component has no Host apply export')
  context.provide('loader', {
    internal,
    *entries() {
      yield {
        options: { name: 'dsh-mobile-question-fixes' }, fiber: {}, disabled: false,
        parent: { tree: { ctx: { baseUrl } } },
      }
    },
  })
  const registry = new ClientModuleRegistry(context)
  const clientPath = registry.clientPath('dsh-mobile-question-fixes')
  if (clientPath === undefined || await realpath(dirname(dirname(clientPath))) !== expected) {
    throw new Error('DSH client discovery did not select the packed question-card component')
  }
  if (!registry.graph().entries.some(candidate => candidate.id === 'dsh-mobile-question-fixes')) {
    throw new Error('Packed question-card component is absent from the DSH client graph')
  }
  console.log('Packed question-card component resolves through DSH from the isolated profile')
} finally { await context.fiber.dispose() }
