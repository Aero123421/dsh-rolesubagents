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

This is not a second session service, a new configuration framework or a new icon setting. Native projections and navigation remain authoritative. The compact trigger opens only by click or keyboard, never hover. Its counts describe direct children (or siblings in lineage), not the whole descendant tree. Current/attention entries precede collapsed completed/cancelled history; descendants expand explicitly. Native children open their chat or aside; external rows open a nonmodal result inspector, never a nonexistent child chat.

Rows use ordinary lists and buttons, not an ARIA tree with incomplete tree keyboard behavior. Escape, outside dismissal and keyboard navigation are supported without trapping focus. Opaque theme surfaces, bounded scrolling and mobile sizing keep overlays readable. This is a compact English/Japanese presentation, **not pixel or localization parity with every built-in DSH client**; other locales use English.

Status needs evidence: running, completed, stopped/details unknown, failed, timeout, cancelled, loading, stale, missing, unavailable and migration are distinct. A non-running child without completion evidence is not labeled idle or successful. Missing/stale data remains visible as incomplete information, not a zero-success summary.

The external inspector keeps the parent usable and offers copy, readable/raw plain text and parent navigation. Both text views are escaped text, not Markdown/HTML rendering. Copying a truncated preview copies only that preview. Execution details start collapsed; requested model is not confirmation of actual model/effort. No live CLI stream, follow-up messaging, new stop action or historical transcript recovery is added.

## Lookup lifetime

Metadata lookup is optional. Missing/invalid/unavailable RPC results leave navigation usable. Role IDs are deduplicated into sequential batches of at most 100, with a five-second request timeout. Open catalogs refresh without overlapping a request in the same effect. Positive role metadata survives close/reopen; scope changes and connection resets invalidate it. Close, unmount and cancellation abort old work; stale replies cannot refill reset state. There are no per-row timers or permanent negative cache.

External run polling tracks loading, error, stale, last-success time and durability **per parent**. Outcomes publish independently; one parent's failure cannot hide another's success. Last-good records survive a failed refresh and are explicitly stale. Requests cover at most 100 parent scopes with four concurrent fetches, on non-overlapping five-second polling rounds; navigation/reset cancels old scopes. The trigger can keep polling relevant external scopes while closed. This is bounded refresh, not a live event stream.

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

See [historical validation](<role-catalog-validation-20261024.md>) for earlier executed tests and limitations, not certification of the v0.6.0 redesign. The [v0.6.0 release notes](<releases/v0.6.0.md>) record the executed release validation. `pnpm check:probe` includes the actual installed Connection → loopback HTTP → Gateway → role-display Remote and the real client caller: positional IDs, metadata allowlist, request bounds, authentication/Origin fence and disposal fallback.

Installing the package into a profile and restarting its Host are separate operator actions, not automatic consequences of publication. The release notes distinguish isolated component checks from the explicitly authorized existing-GUI deployment check; neither certifies every upstream UI behavior or theme.
