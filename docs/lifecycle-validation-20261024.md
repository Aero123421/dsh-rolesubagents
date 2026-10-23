# Lifecycle follow-up to PR5 — 2026-10-24

## Scope and KISS decisions

This is a selective successor to [PR5](https://github.com/Aero123421/dsh-rolesubagents/pull/5), based on v0.3.0 rather than a wholesale merge of the old branch. It preserves the existing management CAS, raw-literal safety checks, Session-keyed refresh shield, rollback, delegation admission epoch and independent owner lifetime.

| Old PR5 area | Disposition |
| --- | --- |
| Storage-readiness race / absent-role cache / first-turn persistence | Fixed: native `agent/created` is awaited; restore and persistence complete before its serial listener returns. |
| Resumed read-only preparation / partial tool installation / Session append reentry | Fixed: pin before install, clean up and fail closed on preparation errors, coalesce repins in a microtask after publication. |
| Completed write retention / historical rewrites / concurrent flush / close | Fixed with a pending Set, per-flush snapshots, `allSettled`, acknowledged failures and idempotent close. No permanent failure latch: rollback can be confirmed after a candidate write fails. |
| Explicit model defaults / provider replacement and history contracts | Fixed; preserve existing cancellation and owner-lifetime checks. |
| Cross-realm workflow defaults / native malformed-options semantics | Fixed with a small descriptor adapter; native validation still owns invalid values. Arrays, own `undefined` routing fields, symbols, hidden properties, accessors and throwing reads are covered. This does not promise transparent handling of arbitrary stateful Proxies. |
| Same-revision UI changes | Already handled by v0.3.0; retained rather than replacing the controller. |
| Temporary namespace loss / accepted-but-stale mirror / repair-only save | Fixed. Keep inputs, distinguish acceptance from confirmation, block automatic retry, require the existing safety RPC, and preserve opaque role metadata. Explicit discard is still available. |
| Delayed registration and awaited unload | Existing protections retained; disposed callbacks are fenced. |
| Additional manual model/preset catalog controls | Deferred UI enhancement, not folded into this correctness patch. |
| rc.2 dependency and Node engine floor changes | Not adopted. Existing package floors remain unchanged; broader version qualification is a separate decision. |

The old PR is not automatically closed. Its dependency/UI enhancements must be explicitly adopted or declined before treating its entire scope as resolved. PR13 remains a separate feature follow-up.

## Verification

Local environment: Linux, Node 22.23.4, installed DSH 0.2.1-rc.2. Normal tests use the disposable-HOME wrapper. Native checks isolate HOME and credential selectors before SDK/plugin import, use local fixture adapters, and do not call a paid/live model or a real external coding CLI.

- Full lint, three TypeScript configurations and **44 suites / 1,391 unit/component/regression tests passed**.
- Rebuilt checked-in bundles; `check:lib` compares them with a fresh build against the committed tree (an uncommitted rebuild intentionally fails that check).
- `pnpm check:host`: actual installed workflow runtime, defaults and native invalid-option parity through both parallel and pipeline.
- `pnpm check:delegation`: actual `dsh headless` launcher, native Agent creation and child providers, completed-history vs current-turn inheritance, role instructions, identical system/tool prefix, explicit default effort, read-only tool refusal, non-reentrant Session repinning, compaction, same-child warm follow-up and a cold process reopen after saved role settings change.
- `pnpm check:management`: actual Loader/settings/ConfigEditor/ToolRuntime integration, including existing management safety, revision and disposal behavior.
- `pnpm check:probe`: actual HTTP Connection/Gateway/Remote metadata path, including write-safety attestation.
- Independent read-only review found two repair-only mirror intersections and an array/prototype workflow edge. All were corrected with regression tests rather than new state-management abstractions.

## Limits

This is not an installation or verification of the running Web GUI. No production profile, credentials, running server or installed DSH package was changed or restarted. Unit/UI tests are not an integrated browser screenshot claim. Native fixtures do not certify real inference, external CLI behavior, every DSH version, OS sandbox confinement or crash/power-loss durability. Store flush means acknowledgement of writes covered by that flush, not a filesystem `fsync` guarantee. Read-only tool guards and repinning are defense in depth, not a new OS sandbox.
