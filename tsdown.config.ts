import { defineConfig, type UserConfig } from 'tsdown'

/** Standalone IIFE: no module loader or DSH services may be required at this point. */
export const mobileCompatibilityBuild = {
  entry: { 'mobile-compat': 'src/mobile-compat.ts' },
  outDir: 'lib',
  format: ['iife'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  minify: true,
  deps: { alwaysBundle: ['core-js'], onlyBundle: ['core-js'] },
  outputOptions: { entryFileNames: 'mobile-compat.js' },
} satisfies UserConfig

export default defineConfig([{
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  sourcemap: true,
  clean: true,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-host-webserver',
    ],
  },
}, {
  entry: ['src/cli.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: false,
  sourcemap: true,
  clean: false,
  outputOptions: { entryFileNames: 'cli.js' },
}, {
  entry: { client: 'src/client.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { neverBundle: ['react'] },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-mobile", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}, {
  entry: { 'mobile-layout': 'src/mobile-layout.ts' },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: { neverBundle: ['react'] },
  outputOptions: {
    entryFileNames: 'mobile-layout.js',
    banner: 'window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-ui-layout", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}, mobileCompatibilityBuild])
