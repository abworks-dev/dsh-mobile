# Contributing

Changes are welcome through focused pull requests. Please describe the user-visible or security behavior, add negative tests for every changed rejection path, and keep Android, browser, and plugin documentation aligned.

Run the local checks before opening a pull request:

```sh
npm ci
npm run verify
```

For question-card, mobile-layout, or dictation changes, build the client and run `npx playwright install chromium --only-shell`, `npm run smoke:question-fixes`, `npm run smoke:native-layout`, and `npm run smoke:voice-session`. These browser checks exercise the built client; the CI startup matrix also installs the npm tarball into isolated DSH runtimes before pairing.

For Android changes, also run the [app build and unit checks](apps/mobile/README.md#build); review the internal [design reference](design-system/dsh-mobile/MASTER.md) for native screens and plugin-owned controls. Keep the English and Chinese app instructions aligned. Never commit signing keys, provisioning profiles, TLS private keys, device registries, credentials, or tokens.

Stable Android releases require the repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. The release workflow decodes the keystore only inside the temporary GitHub runner, verifies the resulting APK signature, and publishes its SHA-256 checksum. A tag fails before npm publication when Android signing is unavailable.

The project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/). Be respectful, keep reports reproducible, and use private vulnerability reporting for security findings.
