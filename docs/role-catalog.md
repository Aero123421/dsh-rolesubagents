# Role badges in the subagent catalog

## Implementation boundaries

This change is developed and tested in the plugin repository only. Do not install it into an active DSH profile or restart the running DSH as part of verification.

The installed DSH catalog renders its rows directly; it has no row-adornment slot. The plugin therefore supplies its own catalog via the existing header slots:

- `conversation.session.header.actions`, cell id `subagent-catalog` (root view).
- `conversation.session.header.lineage` (child view).

These registrations must be scoped to the plugin lifetime and leave the original contributions available when the plugin unloads. Unsupported clients must retain the built-in catalog. No DOM observers, hashed-class selectors, React internals, label rewriting, or installed-package patches are used.

## Role identity

The badge reads the role recorded at delegation time, not the current role settings, task label, or conversation title. The Host exposes the optional read-only `rolesubagentsRoleDisplay/query` RPC. Request payload: `{ args: { childIds: string[] } }`. The gateway wraps the result in `{ ok: true, value }`; `value` is an array aligned with the requested ids. Entries contain `roleId`, `displayName` (currently the same id), and optionally `builtin`, or are `null` when unknown.

The API validates and bounds requests (100 ids per batch) and never returns instructions, descriptions, model routes, environment variables, or other configuration. The client tolerates unavailable RPCs and missing records without hiding ordinary catalog rows.

Existing DSH children with stored role records can receive badges. Newly delegated external CLI runs also record their role by activation id; older external runs without records cannot be reconstructed reliably and remain unbadged. Standard subagents not started by the role tool are not assigned an inferred role.

## Artwork

Fixed local SVG presets cover 18 roles. Selection uses an exact role id or a listed alias (not substring matching). The visible name remains the original role id. Unknown custom names use a neutral SVG. This adds artwork, not new role definitions or an icon-picker setting.

| Role id | Artwork | Exact aliases |
| --- | --- | --- |
| `general` | Layers | — |
| `fork` | Branch | — |
| `worker` | Tools | `coder`, `developer`, `implementer` |
| `lightworker` | Lightning | — |
| `explorer` | Magnifier | — |
| `reviewer` | Shield with check | — |
| `tester` | Test flask | `qa`, `testing` |
| `debugger` | Bug | `debug` |
| `architect` | Hierarchy | — |
| `planner` | Checklist | `planning` |
| `researcher` | Open book | `research` |
| `writer` | Document and pen | `docs`, `documentation` |
| `security` | Shield with lock | `auditor`, `security-auditor` |
| `designer` | Layout | `design` |
| `analyst` | Bar chart | `analysis` |
| `devops` | Servers | `sre` |
| `optimizer` | Speedometer | `performance` |
| `translator` | Translation | `localization` |

The visible role id supplies the accessible meaning; the decorative SVG is hidden from assistive technology. Names are rendered as text, never interpolated into SVG markup. Icons use `currentColor`, have no external assets, and do not animate.

## Verification requirements

Before release, verify both header placements, root and nested children, session/sidebar navigation, status, token totals, active duration, external non-navigable rows, loading/errors/retry, keyboard/outside-click handling, role lookup races, reconnect, unload, and missing-service fallback. Unit tests and local builds do not imply that the running Web GUI has been updated or visually verified.
