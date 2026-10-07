# Managed Caddy upstream

[中文指南](CADDY_MANAGED.md)

> Shipped since **0.5.7**.

## When to use this

You own a domain and want phone access to DSH from the public internet without manually installing a reverse proxy, obtaining certificates, or writing configuration. Enable **Mobile access → Remote → Self-hosted → Own reverse proxy → Managed Caddy** on the computer, and the plugin will:

1. download a pinned Caddy build (with the Tencent Cloud DNS plugin for DNS-01 certificate issuance) into the plugin private directory;
2. generate and manage its Caddyfile;
3. run Caddy as a child process that starts and stops with the remote provider.

```text
Phone → https://phone.example.com:8443 (managed Caddy terminates TLS; DNS-01 issues and renews certificates)
      → http://127.0.0.1:3444 (this plugin's private authenticated HTTP backend)
      → current DSH WebServer
```

## Relationship to the "own reverse proxy" mode

The same private HTTP backend (3444), two ways to terminate public TLS:

- **I already run my own reverse proxy**: you manage Lucky/Nginx/Caddy and certificates; the plugin provides only the backend (the original mode, see [Own HTTPS reverse proxy](SELF_HOSTED_ORIGIN.en.md)).
- **Managed Caddy**: the plugin manages everything; you only need a domain and DNS API credentials.

Both share the same backend and paired devices; switching modes does not affect pairing.

## The four settings

| Field | Notes |
| --- | --- |
| Public domain | Full HTTPS address, e.g. `https://phone.example.com:8443`. The port must match your router's forward. |
| DNS provider | First release supports Tencent Cloud DNSPod (DNS-01; no public 80/443 needed). |
| Tencent Cloud SecretId / SecretKey | API credentials for DNS-01; stored only in the plugin private directory, never written into the Caddyfile or logs. |
| Public HTTPS port | Caddy's listen port, default 8443; must not be 3443 (LAN gateway), 3444 (the backend), or 3080 (DSH). |

The router must forward the public HTTPS port to this machine's port.

## Component source

Caddy is an official custom build (core + Tencent Cloud DNS plugin), pinned by version and verified by SHA256 before installation into the plugin private directory. **No system service, PATH entry, or startup item is added**; Caddy exits when remote access stops. Certificates live inside the plugin private directory.

## First start and certificates

The first start issues certificates via DNS-01, which usually takes under a minute. The panel reports the local backend as soon as it listens; the public HTTPS address becomes reachable once issuance completes, and Caddy renews automatically afterwards.

## Migrating from a manual install

If you previously installed Caddy manually (for example as a Windows service):

1. stop and remove the old service/process (`sc stop caddy`, `sc delete caddy`);
2. install the managed component and fill in the domain and credentials in the panel;
3. certificates are reissued once (the old certificate directory is not migrated);
4. after verifying the phone connects, remove the old Caddy directory.

## Stop and cleanup

| Action | Result |
| --- | --- |
| Switching providers | Stops Caddy and the backend; settings and paired devices are kept. |
| Remove managed Caddy and settings (confirm) | Stops and deletes the component, Caddyfile, credentials, and certificate data; pairing and LAN are unaffected. |

## Same backend security boundary

Managed Caddy only replaces who terminates TLS; the backend security model is unchanged: device pairing, exact Host/Origin validation, CSRF, Secure Cookie, and WebSocket path policies all remain. The public side is HTTPS-only; the HTTP backend (3444) listens on loopback and must never be exposed.