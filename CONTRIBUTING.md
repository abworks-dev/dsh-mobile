# Contributing

Keep pull requests focused on observable behavior. Explain the change, cover new failure/rejection paths, and update the relevant English and Chinese guides together. Preserve contributor history and keep real credentials out of fixtures.

## Local setup and baseline

Use the Node engine range in [package.json](package.json). From this repository:

```sh
npm ci
npm run verify
```

`verify` checks version alignment, documentation links/structure, bundled licenses, mobile assets, TypeScript, tests and build/package output. `npm run check:docs` is the quick documentation-only check; it does not judge prose accuracy, external services or rendered appearance.

## Select behavior checks

Browser checks consume built client files. Run `npm run build` and `npx playwright install chromium --only-shell`, then choose the affected checks:

| Change | Check |
| --- | --- |
| Question cards | `npm run smoke:question-fixes` |
| Layout, drawers and panels | `npm run smoke:native-layout` |
| Composer focus and keyboard | `npm run smoke:composer-keyboard` |
| Composer controls, typography and wrapping | `npm run smoke:composer-overflow` |
| Dictation lifecycle and focus | `npm run smoke:voice-session` |
| Browser authentication Cookies | `npm run smoke:browser-auth-cookies` |
| API fallback on older WebViews | `npm run smoke:mobile-compat` |
| Async access-panel forms | `npm run smoke:control-state` |
| Module-selection recovery | `npm run smoke:module-recovery` |

These fixtures do not submit a model request or read the normal DSH home. Browser evidence does not establish physical Android keyboard, camera or device-lifecycle behavior.

## Test the packed plugin in DSH

Use an isolated DSH installation rather than replacing the plugin's development dependencies. This PowerShell example uses the current checked version:

```powershell
$dshMobileTestRuntime = Join-Path $env:TEMP ('dsh-mobile-test-runtime-' + [Guid]::NewGuid().ToString('N'))
npm install --prefix $dshMobileTestRuntime --no-save --package-lock=false @deepseek-ai/dsh@0.2.0-rc.2
$env:DSH_BOOT_SMOKE_BIN = Join-Path $dshMobileTestRuntime 'node_modules/@deepseek-ai/dsh/lib/bin.js'
npx playwright install chromium --only-shell
npm run smoke:dsh-boot
npm run smoke:dsh-composer
```

The smoke installs the actual npm tarball into an owned temporary profile before pairing. It does not substitute checkout files for bundled components. CI owns the complete version/platform matrix in [.github/workflows/ci.yml](.github/workflows/ci.yml).

Compatibility changes also run `npm run smoke:dsh-boot -- --legacy-webview`. The `--negative-control-compat` variation must fail with its expected missing-API marker after the compatibility script is blocked; an installation or fixture failure is not a successful negative control.

`npm run capture:screenshots -- --out <directory>` produces credential-masked pairing, conversation, drawer and settings PNGs. `--overwrite` permits replacing existing captures; generated files are not committed automatically.

## Android and optional components

Follow the [Android build instructions](apps/mobile/README.md#build) and keep both app manuals aligned. Preserve application identity, stable signing and stored pairings. Never uninstall or clear a user's app to bypass a signing mismatch. Ask before altering real device data; use a separate test package for destructive test flows.

Review the internal [design reference](design-system/dsh-mobile/MASTER.md) for native screens and plugin-owned controls. Do not change DSH source to implement plugin features without a separately authorized upstream change.

For macOS cloudflared changes, build and run `npm run smoke:cloudflared-component`. It verifies official archives and reinitialization in temporary state, then removes its owned files; it never executes downloaded Mach-O binaries. `-- --archive-dir <directory>` reuses independently verified official archives.

The optional Caddy workflow builds pinned sources and produces review artifacts only. It does not publish binaries or enable production installation. See [managed Caddy](docs/CADDY_MANAGED.en.md#maintainer-build-and-validation).

## Prepare and publish a release

Release preparation is not publication. Keep the candidate marked unreleased and retain working stable APK links until publication is authorized.

1. Align package, lockfile and Android versions; use `npm run check:version`.
2. Review release notes, app manuals, compatibility statements, contributors, third-party notices and package contents. Preserve original author commits when incorporating community PRs.
3. Pass relevant local checks and every applicable CI job for the final candidate, not only the checks required by branch protection. Record device/network coverage without treating local probes as public-route evidence.
4. After publication is authorized, finalize the CHANGELOG date and stable version/download text in both root READMEs and app manuals. `check:release-tag` refuses unfinished candidate documentation.
5. Merge the exact tested candidate, tag that commit and let [.github/workflows/release.yml](.github/workflows/release.yml) build/publish. Verify npm/GitHub package equality, checksums, APK identity, versionCode and signer afterward.

Stable Android releases require `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`; npm publication requires `NPM_TOKEN`. Never copy their values into the repository. The release workflow uses a temporary runner, validates the established single signer and completes Android signing before npm publication. Missing signing configuration fails the release rather than publishing an unusable APK.

## Reports and community conduct

Describe versions, connection type and reproducible steps in ordinary issues. Redact tokens, Cookies, QR pairing values and private paths. Use [private vulnerability reporting](SECURITY.md#reporting-a-vulnerability) for suspected security flaws.

The project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Be respectful and thank reports and code contributions without claiming unverified fixes or tests.
