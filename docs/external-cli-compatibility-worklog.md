# External CLI compatibility work log (issues #9–#12)

Implementation and local verification completed on `feat/external-cli-compatibility`, separate from role-badge PR #13. See the [verification report](external-cli-validation-20261022.md) for current outcomes and limitations; this is not a deployment or blanket compatibility certification.

## Execution boundary

The user replaced the original VM request with local testing. No active DSH restart/deployment, real authentication setup change or installed-CLI update was performed. Test-owned HOME/XDG/DSH/native configuration, workspaces, local fake providers and dummy keys were used. A distinct official old Codex binary was extracted into temporary storage for comparison, not installed globally.

## Implemented

- #9: retryable per-attempt probe diagnostics, including honest ambiguous404; actual installed HTTP Connection/Gateway/Remote tests.
- #10: exact-scope compatibility evidence, immutable recorder, explicit case inventories, version-pinned fingerprints, distinct-version comparison and UI records separated from current-host claims.
- #11: thin native Grok/Pi adapters, lifecycle/error/cancel handling, preserved native configuration, and refusal of unsupported restrictive parent access.
- #12: explicit Claude native accept-edits mode with ordinary venv support and no recursive preflight, without automatic permission elevation/bypass; legacy restrictions preserved.

## Investigation history

1. Before real-runtime tests, found that inherited HOME could let plugin housekeeping target the user's directory. Added disposable identity before runtime imports/startup.
2. Initial four-CLI regression: **31 pass / 17 fail / 1 skip**. Preserved failure logs rather than treating version observations as validation.
3. Antigravity: the Snap launch wrapper rewrote HOME and bypassed fixture configuration. The direct official binary worked; harness now refuses known HOME-changing wrappers. A genuine 1.4.4 `run_command` schema change was fixed in the fake backend, with filesystem assertions retained and dummy-key authentication enforced.
4. Claude: the new reserved `DeferredToolPlaceholder` is not an executable tool. Real attempted empty and smuggled Write/Bash calls were rejected; all subsequent restricted tool lists/filesystem controls remain enforced. Global environment scans were replaced with owned descendant/PID-identity checks.
5. Codex: initial tests also revealed a false-positive parent-ceiling assertion that accepted missing files after sandbox startup failed. The assertion now requires actual read-only denial. Both official 0.162.0/0.163.0 consequently show **6 pass / 5 fail** in this environment. Legacy Landlock also requires unavailable Bubblewrap socket isolation. No fallback bypass or system-policy change was made; backward compatibility is not certified.
6. Independent review found shell/loader/credential-file selectors surviving the initial environment blacklist, same-version comparisons being accepted, and a zero-selected-case CLI being hidden by another passing suite. All three were fixed with regression tests: narrow allowlist, distinct versions and per-CLI selection checks.
7. Native Grok/Pi evidence was deliberately kept incomplete until missing-key startup, owned-process cancellation/timeout cleanup and explicit protocol fault injection were added and rerun. Final native tests: **10 + 12 pass**, with genuine archived records and precise limitations.

## Final checks

- Lint and all three TypeScript configurations pass.
- **1035 tests pass** across 31 files.
- Repository Host/client bundles build successfully; building does not install/restart the active GUI.
- Existing three CLIs plus self under the strengthened allowlist: **49 pass / 0 fail / 1 skip**.
- Actual installed HTTP probe checks pass; installed workflow/registry integration: **15 pass**.
- Packaging/committed-bundle consistency is recorded in the verification report after the final check.

The later `manage_roles` tool request was discussed as a separate design only; it is not silently included in this change.
