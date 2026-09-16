# Cloudflare named tunnel (a stable public hostname)

The built-in cloudflared provider runs in one of two modes, chosen in the panel under **Mobile access → Remote → cloudflared → Tunnel type**:

| | Quick tunnel (default) | Named tunnel |
| --- | --- | --- |
| Account | Not needed | Cloudflare account required |
| Address | Random `*.trycloudflare.com` on every start | A fixed hostname under your own domain |
| After a restart | Address changes; pair again | Address is unchanged; paired devices keep working |
| Availability | Officially for testing: rate-limited, no uptime guarantee | Carried by your own Cloudflare account |
| Settings | None | Connector token, public hostname, local forward port |

Cloudflare terminates DNS and TLS for the public hostname. The plugin only runs `cloudflared` locally and hands traffic to its authenticated private gateway, so **the phone still pairs through the app's Remote access flow** — a tunnel does not change how devices pair.

## Prerequisites

1. A domain already on Cloudflare. Its nameservers must point at the pair Cloudflare assigned, changed at your registrar; that usually takes minutes and up to 24 hours.
2. Cloudflare Zero Trust (a team domain) enabled, because the tunnel console lives inside it.
3. The cloudflared component installed in the panel. Named and quick tunnels share the same official client.

## Create the tunnel in the Cloudflare dashboard

1. Open **Zero Trust → Networks → Tunnels** and choose **Create a tunnel** → **Cloudflared**.
2. Name it, for example `dsh-mobile`, and save; the dashboard then shows a connector install command.
3. On the **Public Hostname** tab add one entry:
   - Subdomain `dsh`, and pick your domain, giving `dsh.example.com`
   - Service: **HTTP** → `127.0.0.1:3444`
4. On the **Overview** tab copy the connector token — the long string starting with `eyJ`. It already contains the account, tunnel id and tunnel secret, so **it is a credential**.

> `127.0.0.1:3444` is the panel's "Local forward port". Cloudflare routes the public hostname to exactly that port, so it must match what you enter in the panel and must not change afterwards.

## Fill in the DSH Mobile panel

1. **Mobile access → Remote → cloudflared**.
2. Set the tunnel type to **Named**.
3. Enter:
   - **Public hostname**: `dsh.example.com`
   - **Local forward port**: `3444`, matching the Service port from step 3
   - **Connector token**: the token you copied
4. Choose **Save and connect**.

Once saved, leaving the token field blank keeps the stored token, and the field never echoes a saved token back. **Remove the saved token** also **stops the cloudflared channel** and returns the provider to a quick tunnel. Nothing reconnects on its own: switch the channel back on afterwards.

## Connect the phone to a named tunnel

Moving to a fixed hostname means **an already paired phone must pair again**: a DSH Mobile device credential is only ever sent to the exact origin that first received it, which is the design that stops a swapped-in domain from harvesting it. A credential issued for the old address therefore never authenticates at the new one.

1. On the computer, open **Remote** in the panel and choose **Create remote pairing QR code**. That is what opens the pairing window, which is time-limited; while it is closed nothing can pair.
2. In the app, **open the Remote entry first** (the remote access setup page in the connection center), then scan the code.

> **A named tunnel must be scanned from inside the Remote flow.** The app treats platform suffixes such as `.ts.net`, cpolar and `.trycloudflare.com` as remote without asking. A domain you own is recognised as a remote candidate too, but the Local network flow accepts only non-candidate addresses, so scanning there is rejected as **Invalid QR code** and looks exactly like "cannot connect". Enter the Remote flow first, then scan.
>
> Scanning is optional: the full link (`https://your-domain/mobile-access/pair#instance=…&token=…`) can be copied to the phone and pasted, because the app accepts a complete link in its input field.

The old remote entry in the device list will show **Address may have changed** or unreachable; delete it once the new pairing succeeds.

## Security boundary

- The token is written only into the DSH Mobile private directory (`~/.dsh/mobile-access/remote/cloudflared/tunnel.json`, mode 0600) and is passed to `cloudflared` **only** through the `TUNNEL_TOKEN` environment variable, never on the command line, which any local process can read.
- The token is never returned to a browser or a phone. Panel status carries only whether it is configured, plus the hostname and port.
- Behind the tunnel sits DSH Mobile's own authenticated gateway: the public hostname exposes that gateway, and DSH still requires paired-device credentials.
- The plugin adds no system service, startup item, registry entry or PATH entry. Disabling the channel ends the process.

## Error codes

| Panel message | Code | Meaning and remedy |
| --- | --- | --- |
| Local forward port unavailable | `cloudflared_tunnel_port_unavailable` | The configured port is taken. A named tunnel cannot move to another port, because Cloudflare routes to that exact one: free the port, or pick another and update the Service in Cloudflare to match. |
| Invalid public hostname | `cloudflared_tunnel_hostname_invalid` | Must be a real hostname under a domain on this account. IP literals, wildcards, `.trycloudflare.com` and `.cfargotunnel.com` are refused. |
| Invalid forward port | `cloudflared_tunnel_port_invalid` | The port must be between 1024 and 65535. |
| Reserved forward port | `cloudflared_tunnel_port_reserved` | **3443** cannot be used: it is the DSH Mobile LAN gateway's HTTPS port, held for as long as DSH runs. It is not a transient conflict, so pick 3444 or 3445. |
| Invalid token | `cloudflared_tunnel_token_invalid` | Copy the whole token from the dashboard, with no spaces or newlines. |
| Settings rejected | `cloudflared_tunnel_settings_invalid` | The request carried a field that does not belong to the mode, such as a port in quick mode. |
| Token, hostname and port are all required | `cloudflared_tunnel_config_missing` | First-time named-tunnel setup needs all three. |
| Saved configuration is unreadable | `cloudflared_tunnel_config_invalid` | The stored file is corrupt or malformed. The provider falls back to a quick tunnel; save the settings again. |
| Saved configuration is not a regular file | `cloudflared_tunnel_target_invalid` | `tunnel.json` became a symlink or a non-regular file. Remove it and save the settings again. |
| Could not reserve a local port | `cloudflared_port_reservation_failed` | Reserving the loopback port failed for a reason other than the port being busy. Retry, and check system resources if it persists. |
| Component download failed verification | `cloudflared_download_hash_mismatch` / `cloudflared_download_size_mismatch` | The downloaded binary does not match the pinned size or SHA-256. Install again; repeated failures mean something is rewriting the transfer. |
| Installed component failed verification | `cloudflared_executable_hash_mismatch` | The local cloudflared no longer matches the verified build. Remove it completely and install again. |
| This build cannot run the component | `cloudflared_component_unsupported` | The platform is outside the supported set (currently Windows x64 only). |
| Timed out waiting for the tunnel | `cloudflared_start_timeout` | The connector did not print `Registered tunnel connection` within 60 seconds, usually because it cannot reach a Cloudflare edge. |
| Component not installed | `cloudflared_component_missing` | The official component is absent. Complete the preparation steps above. |
| Component verification failed | `cloudflared_component_invalid` | The local component does not match the verified build. Remove it completely and install again. |
| Could not allocate a port | `cloudflared_port_unavailable` | Quick mode could not allocate the loopback gateway port. Retry. |
| Client failed to launch | `cloudflared_launch_failed` | The cloudflared process did not start. Check the local logs. |
| Connection stopped or exited | `cloudflared_stopped` / `cloudflared_exited` | The channel dropped. Reconnect. |
| Unrecognized output | `cloudflared_invalid_output` / `cloudflared_invalid_origin` | cloudflared output, or the public address it printed, failed validation. Reconnect and copy the diagnostic report. |
| Gateway start failed | `gateway_start_failed` | The authentication gateway behind the tunnel did not start; this is not a port conflict. Check the local logs. |
| Download redirect problem | `cloudflared_download_redirect_missing` / `_invalid` / `_rejected` | The official download page did not redirect to a release asset, or the redirect did not point at a GitHub release asset. Retry later, or install from the official page manually. |

## Troubleshooting

- **Stuck on "connecting"**: a named tunnel prints no banner, so it only becomes ready once the connector registers. Read the cloudflared output in the DSH log; the `CONNECTIVITY PRE-CHECKS` table says whether DNS, UDP/QUIC or TCP is the problem.
- **Public access returns 1033**: Cloudflare believes no connector is healthy for that hostname. Check the tunnel shows Healthy in Zero Trust, and that its ingress port matches the panel.
- **`cloudflared` reports `Unauthorized`, or the tunnel id does not exist**: the token belongs to a different tunnel, for example one that was deleted and recreated. Copy the token again.
- **With a TUN or transparent proxy running (Clash, Mihomo, Clash Verge), the phone sticks on "Loading plugins" and retries forever.** This is a real failure that was measured, and it is easy to misread as a pairing or plugin problem:
  - `cloudflared`'s connection to `region*.v2.argotunnel.com` has no dedicated rule, so it falls through to the catch-all `Match`/`MATCH` rule and is sent into a proxy node. The core's own API shows it plainly:
    ```
    cloudflared.exe -> region2.v2.argotunnel.com
      rule=Match   chains=["<some airport node>","漏网之鱼"]   up/down = 103 MB / 2.1 MB
    ```
  - Downstream throughput then collapses to **8–100 KB/s**. The phone's DSH boot pulls a **4.5 MB** (compressed) boot bundle in one shot, the loader gives up, and the app shows "load, fail, retry".
  - The same file took **0.2 s** on the LAN gateway, and **9.9 s / 454 KB/s** through the tunnel once routing was fixed — two orders of magnitude apart.
  - Fix: route cloudflared and its edge domains directly. In Clash Verge's **global merge profile** (`profiles/Merge.yaml`, which subscription updates do not overwrite):
    ```yaml
    prepend-rules:
      - PROCESS-NAME,cloudflared.exe,DIRECT
      - DOMAIN-SUFFIX,argotunnel.com,DIRECT
      - DOMAIN-SUFFIX,trycloudflare.com,DIRECT
    ```
    Then make cloudflared **reconnect**: hot-reloading the core does not migrate long-lived connections (use the panel's reconnect action, or toggle the provider off and on).
  - To confirm it is this and not the phone: fetch the boot bundle from the computer with the same session and watch the rate. If the computer is just as slow, the phone and pairing are innocent.
- **The domain still resolves to the old address**: after the nameserver change Cloudflare must move the zone from Pending to Active, and records in a pending zone are not served publicly.
