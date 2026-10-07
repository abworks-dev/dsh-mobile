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

`scripts/build-caddy-component.mjs` fixes Go 1.26.6, xcaddy v0.4.7, Caddy v2.11.6, and the Tencent Cloud DNS module v0.4.3. It generates the executable, exact size and SHA-256, version/module records, and licenses for embedded dependencies. `caddy-component.yml` produces review artifacts only: no Release creation, production pin changes, or automatic publication.

The public custom-download endpoint returned v2.11.7 when v2.11.6 was requested; a dynamic latest endpoint cannot serve as a fixed-version artifact. Before enabling production installation, publish reviewed builds at immutable versioned URLs and populate the production verification table. All platforms remain disabled until then. Isolated tests use ephemeral loopback listeners and a test CA that is not installed in the system trust store to verify TLS, pairing authentication, raw API bytes, and WebSockets. They do not establish real DNS-01 issuance or public-route readiness.
