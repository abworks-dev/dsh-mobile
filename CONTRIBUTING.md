# Contributing

Changes are welcome through focused pull requests. Please describe the user-visible or security behavior, add negative tests for every changed rejection path, and keep Android, browser, and plugin documentation aligned.

Run the local checks before opening a pull request:

```sh
npm ci
npm run verify
```

For question-card, mobile-layout, dictation, or composer changes, build the client and run `npx playwright install chromium --only-shell` followed by the affected `smoke:question-fixes`, `smoke:native-layout`, `smoke:voice-session`, or `smoke:composer-keyboard` command. Authentication Cookie changes also need `npm run smoke:browser-auth-cookies`, which uses a real HTTPS gateway and Chromium Cookie handling. The CI startup matrix installs the npm tarball into an isolated DSH profile before pairing; it does not substitute checkout files for shipped components.

Composer extension and typography changes also run `npm run smoke:composer-overflow` for standard-slot buttons, large text, local preference ownership, and disposal. Compatibility changes run `npm run smoke:mobile-compat`, then the packed `smoke:dsh-boot -- --legacy-webview` case with missing browser APIs. The `--negative-control-compat` case must fail with its expected missing-API marker when the compatibility script is blocked; an installation or fixture failure is not a successful negative control.

With `DSH_BOOT_SMOKE_BIN` pointing at an isolated DSH installation, run `npm run smoke:dsh-composer` for the actual packed-profile editor. `npm run capture:screenshots` generates pairing, conversation, drawer, and settings PNGs from that profile; use `-- --out <directory>` to choose an output location and `--overwrite` only when replacing existing capture files is intended. Pairing values are masked, and generated screenshots are not committed automatically. The shared fixture never reads the normal DSH home or sends a model request.

For macOS cloudflared changes, run `npm run smoke:cloudflared-component` after building. It installs the pinned official archives into private temporary state, checks the published executable and reinitialization, and removes only its owned component files. Downloaded Mach-O files are never executed. To reuse independently verified official archives, pass `-- --archive-dir <directory>`.

For Android changes, also run the [app build and unit checks](apps/mobile/README.md#build); review the internal [design reference](design-system/dsh-mobile/MASTER.md) for native screens and plugin-owned controls. Keep the English and Chinese app instructions aligned. Never commit signing keys, provisioning profiles, TLS private keys, device registries, credentials, or tokens.

Stable Android releases require the repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. The release workflow decodes the keystore only inside the temporary GitHub runner, verifies the resulting APK signature, and publishes its SHA-256 checksum. A tag fails before npm publication when Android signing is unavailable.

The project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Be respectful, keep reports reproducible, and use private vulnerability reporting for security findings.
