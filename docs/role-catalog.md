# Role badges in the subagent catalog

## Identity and privacy

The badge shows the role recorded **when delegation starts**, not the current role settings, task title, parent role, or model route. Editing a role or calling `manage_roles.apply_current` does not reinterpret existing children. A badge is descriptive metadata, not an authority or a permission grant.

- DSH children use their actual child Session ID and saved role record.
- Newly started external CLI runs use DSH's returned **activation ID**, not the CLI's native thread/conversation ID. Recording is best effort after successful activation: a closed/failed store cannot turn a started child into a reported delegation failure. No extra flush delays the activation handoff.
- Existing DSH records can be read after cold storage readiness. Explicit legacy records are read only from already-loaded Sessions; lookup does not open or scan old histories.
- Older external runs and ordinary subagents with no role record remain unbadged. No role is guessed. Memory-only/failed persistence can lose metadata on restart.

The optional authenticated read-only RPC is `rolesubagentsRoleDisplay/query`, with `{ args: { childIds: [...] } }`. It accepts at most 100 IDs per call, each 1–256 ASCII characters (first alphanumeric, then alphanumeric/underscore/dot/colon/hyphen). Its positional answer retains duplicates and returns `null` for unknown IDs. The only exposed fields are `roleId`, `displayName` (currently the role ID) and optional built-in identity. Instructions, descriptions, models, environment and other role configuration are never returned. The client renders role names as text.

## Compatibility and KISS boundary

DSH 0.2.1-rc.2 exposes **no public row-adornment slot or reusable exported catalog component**. For a badge within each row, this plugin must own a compact catalog implementation; a tiny wrapper around native rows is not available. This maintenance cost is explicit, not hidden behind DOM observers, hashed-class selectors, React internals or installed-package patches.

A single adapter registers only through the public declarations:

- `conversation.session.header.actions`: list/session slot, cell ID `subagent-catalog`, order 10, priority -10.
- `conversation.session.header.lineage`: single/session slot, priority -10.

Registration requires public `SlotRegistry.spec()` kind/scope checks plus session-projection, workspace-navigation and sidebar-navigation services. Missing declarations are waited for via native scoped injection; unavailable/incompatible services or specs leave the built-in catalog. The registrations and stylesheet belong to the plugin's Cordis lifetime; unload restores the remaining built-in contribution. Kind/scope checks are **not proof of arbitrary future owner-prop compatibility**. The dependency floor is unchanged; this optional UI is qualified against the inspected rc.2 contracts, not every version in the package range.

This is not a second session service, a new configuration framework or a new icon setting. Native projections, navigation and metrics remain authoritative. The plugin provides root and child lineage menus, direct-parent child navigation and aside opening, descendant expansion, status/token/time display, loading/error/retry/migration states, keyboard focus and dismissal. External rows remain non-navigable. It is a compact English/Japanese presentation, **not pixel or localization parity with every built-in DSH client**; other locales use English, as the settings page does.

## Lookup lifetime

Metadata lookup is optional. Missing/invalid/unavailable RPC results leave normal rows and navigation usable without badges. Visible/expanded IDs are deduplicated into sequential batches of at most 100. Each batch has a five-second timeout; open menus poll for later metadata without overlapping a request in the same effect. Reset, close, unmount and caller cancellation abort old work; stale replies cannot refill reset state. There are no per-row timers and no permanent negative cache.

The batch size bounds **one request**, not the total catalog size or number of batches. A very large catalog can take multiple requests. This is not a global RPC rate-limit guarantee. Host queries wait for stored roles, obey native request/service/plugin cancellation and refuse reads after disposal.

## Artwork

All icons are local fixed SVG paths, use `currentColor`, have no external assets or animation, and are hidden from assistive technology; the visible role name carries meaning. Unknown custom IDs use a neutral icon. Exact aliases select artwork only and never rename the role.

| Role | Exact artwork aliases |
| --- | --- |
| `general`, `fork`, `lightworker`, `explorer`, `reviewer`, `architect` | — |
| `worker` | `coder`, `developer`, `implementer` |
| `tester` | `qa`, `testing` |
| `debugger` | `debug` |
| `planner` | `planning` |
| `researcher` | `research` |
| `writer` | `docs`, `documentation` |
| `security` | `auditor`, `security-auditor` |
| `designer` | `design` |
| `analyst` | `analysis` |
| `devops` | `sre` |
| `optimizer` | `performance` |
| `translator` | `localization` |

These are 18 artwork presets and 17 exact aliases, not additional predefined roles.

## Verification and deployment

See [validation](<role-catalog-validation-20261024.md>) for executed tests and limitations. `pnpm check:probe` includes the actual installed Connection → loopback HTTP → Gateway → role-display Remote and the real client caller: positional IDs, metadata allowlist, request bounds, authentication/Origin fence and disposal fallback.

No installation into the active DSH profile or restart of the running DSH is part of this change. Component/browser fixture checks do not mean the running Web GUI has been changed, or that full integrated DSH navigation and all upstream UI behavior have been browser-certified.
