# Managed Caddy

[中文](CADDY_MANAGED.md)

> Managed mode and its isolated tests are integrated, but no pinned component has been published. Installation and connection remain disabled. Existing external HTTPS proxy mode is unaffected.

## Requirements

Managed Caddy manages an HTTPS proxy and certificates; it is not a NAT traversal service. You need a domain with Tencent Cloud DNSPod DNS, a reachable public inbound port, and router forwarding to the DSH computer. DNS-01 cannot bypass CGNAT, campus isolation, or an unavailable inbound route. Use Cloudflare Tunnel, cpolar, or FRP on an existing VPS for those networks.

```text
Android App / browser → public HTTPS hostname (Caddy terminates TLS)
                      → dedicated HTTP Gateway on 127.0.0.1
                      → current DSH WebServer
```

## Relationship to an external proxy

These are upstream modes of the same own-proxy provider. External mode remains the default: you manage Lucky, Nginx, or Caddy, and the plugin provides the HTTP backend. Managed mode owns a separate Caddy child and loopback Gateway, stopping the previous mode before starting the next. External proxy settings and paired-device records are retained, never overwritten by managed settings.

Configure the public HTTPS origin, DNS-01 credentials and local HTTPS port separately. The public URL can use port 443 while the router forwards to local port 8443; the local port is what Caddy actually binds. This mode reserves 3080, 3443 and 3444, so they cannot be selected; check that any other selected port is unused. Use a least-privilege DNS credential restricted to the required zone, not an account-wide cloud master key.

## Installation, startup, and readiness

Once pinned assets are published, installation requires explicit download confirmation. The plugin verifies exact length, SHA-256, Caddy core version, and DNS module version; unavailable or invalid assets are not executed. Installed is not ready: after parsing the local configuration, the proxy starts, and readiness requires verified public HTTPS and discovery identifying the current DSH instance.

Initial DNS-01 issuance waits for DNS propagation and certificate issuance. Keep the computer online and avoid repeated restarts that can trigger issuer limits. Managed mode creates no system service, PATH entry, startup item, or system trust-store certificate. Caddy's admin API and configuration autosave are disabled.

## Privacy and cleanup

Settings and DNS credentials are atomically stored in the plugin's private directory. The Caddyfile contains environment placeholders, never the credentials. The child receives only necessary DNS credentials and runtime environment, not unrelated API secrets, proxy overrides, or admin-address overrides. Raw DNS module logs are not retained. Certificates, private keys, configuration caches, and runtime files also stay in the private directory.

Stopping access or changing provider waits for Caddy and Gateway termination, retaining settings. Confirming removal deletes the managed binary, DNS credentials, certificate keys, logs, and caches without deleting other providers, LAN settings, or paired-device data. Existing manually installed proxies are not owned or uninstalled by the plugin.

## Maintainer build and validation

The [builder](<../scripts/build-caddy-component.mjs>) fixes Go 1.26.6, xcaddy v0.4.7, Caddy v2.11.6 and Tencent Cloud DNS v0.4.3. The [input lock](<../scripts/caddy-component-lock.json>) freezes source revisions and compiled dependency versions/checksums. Each build uses fresh private compiler AND module caches, normal Go checksum verification, source-origin checks and retained-module verification. Unknown dependencies, replacements, wrong native settings or compiler versions fail closed before executing the generated Caddy.

Use the exact Go compiler (optionally through `GO_BINARY`); output directories must be new and absolute:

```sh
node scripts/build-caddy-component.mjs --output-dir /absolute/new/first
node scripts/build-caddy-component.mjs --output-dir /absolute/new/second
node scripts/compare-caddy-builds.mjs --first /absolute/new/first --second /absolute/new/second --target linux-x64
```

Windows uses native absolute paths and `--target win32-x64`. Reproducibility means identical executable bytes/size/SHA-256, not identical OS images or every rendered metadata/license file. The [workflow](<../.github/workflows/caddy-component.yml>) natively builds twice on Windows/Linux x64, validates complete evidence and tests the actually installed binary with an independent manifest. Tests cover real default inspection/promotion, no-redownload restart, corrupt-download rollback, TLS/pairing/API/WSS, durable device credentials and stopped-process owned cleanup while neighboring/pairing data survives. Other targets remain unreviewed.

PR and normal dispatch runs are read-only review-artifact builds. Only an explicit manual opt-in on an existing `caddy-component-2.11.6-tencentcloud-0.4.3-review.N` tag in the authorized `abworks-dev/dsh-mobile` fork can publish a **TEST prerelease**, after both native jobs pass:

```sh
gh workflow run caddy-component.yml --repo abworks-dev/dsh-mobile --ref caddy-component-2.11.6-tencentcloud-0.4.3-review.1 -f publish_review_prerelease=true
```

Component tags never start with `v`, avoiding the plugin release trigger. The separate write-permission job refuses occupied releases, creates a non-latest draft prerelease without asset clobbering, verifies an authenticated download of every draft asset against prepared bytes, then publishes. Assets include platform-distinct raw executables, manifests, build/module/version/license records, double-build proof, source-commit/run identity and SHA256SUMS. The [verifier](<../scripts/verify-caddy-release.mjs>) checks **every published asset** through GitHub metadata and the actual installer's HTTPS/validated-redirect downloader before emitting a review-only catalog. A failed post-publication check leaves the labelled prerelease public, fails the job and emits no catalog; it does not silently delete or roll back a release. Artifact retention is 14 days; release assets are separate.

The public custom-download endpoint returned v2.11.7 when v2.11.6 was requested; dynamic latest downloads are not a trust source. Versioned GitHub URLs can still be replaced by repository owners: exact reviewed byte/hash pins, not URL spelling or a remotely supplied checksum alone, define the content boundary. A fork catalog is only a review candidate; it never automatically populates the [production table](<../src/caddy-component.ts>). Official production installation stays disabled until maintainers publish and review their own distribution.

Isolated tests use ephemeral loopback listeners and a private internal CA with `skip_install_trust`; no system trust, production DNS or existing proxy is changed. They **do not establish public DNS-01/ACME issuance or public-route readiness**. Those need a separately authorized dedicated test hostname, least-privilege DNS credentials and actual reachable ingress.
