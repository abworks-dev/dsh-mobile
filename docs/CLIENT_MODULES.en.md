# Mobile page modules

[中文](CLIENT_MODULES.md) · [Back to README](../README.en.md#060-update)

> DSH Mobile 0.6.0 provides module management in General settings. Update the plugin and app together.

Choose which client components the dedicated mobile page loads. This does not uninstall computer plugins, stop their services, or restrict device permissions. A paired device remains a trusted DSH operator.

## Computer defaults and this device

- On the **computer: Settings → General → Mobile page modules → Manage**, set defaults for this computer's mobile access. Enable a LAN or remote access entry first so the current DSH module catalog can be read.
- On the **phone: Settings → General → Mobile page modules → Manage**, override only the currently authenticated paired device. This cannot change another phone or the computer default.

Selection precedence is: device override → computer default → the profile's `excludedClientModules` configuration. Without custom selections, no modules are excluded. LAN and remote entries share the computer default. Device overrides belong to pairing identities; independent LAN and remote pairings on the same phone do not automatically share an override.

**Restore defaults** on a phone removes its override and uses the computer default. On the computer, it removes the computer override and uses plugin configuration. Other device overrides are retained.

## Choose and apply

1. Wait for the catalog to load. A failed read leaves saving disabled; close and reopen to retry.
2. Checked means loaded; unchecked means omitted next time. Required boot modules cannot be unchecked, and other rows show declared dependencies.
3. Select **Save for next open**. Saving rejects a retained module that depends on an excluded module and identifies the conflict: keep the dependency, or also exclude its dependent if it is not needed. Unknown module IDs are rejected too.
4. After a successful save, the current page, conversation, and draft are not reloaded automatically. Manually reopen or refresh the DSH page to apply the selection; saving through this control does not require a DSH restart.

Computer pages and `?frontend=stock` pages are unaffected. DSH or community-plugin updates can change the catalog and dependencies. When a saved selection prevents the mobile page from starting, the page offers “Load all modules for this device and retry”; it changes this device’s selection only when you click, without changing computer defaults, other devices or pairing authorization. Settings APIs still reject invalid selections and enforce required-module and dependency checks. Module sizes depend on the installation, so no fixed traffic reduction is promised.

## Data and authorization

Selections are atomically stored in the computer's private DSH Mobile data directory, without copying conversation drafts. The catalog returns only module IDs, required markers, dependencies, and selections—not upstream download URLs, host file paths, or pairing credentials. A phone reads its own selection through the authenticated Gateway; changes also require same-origin and CSRF checks.

Revoking a pairing removes that identity's module override. To stop a phone from operating the computer, revoke the device on the computer rather than disabling one client component.

Direct edits to the profile's advanced configuration still require a DSH restart. See [Third-party plugin compatibility](../README.en.md#third-party-plugin-compatibility) for examples and limits.
