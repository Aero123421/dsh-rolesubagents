# Local external-CLI verification — 2026-10-22

Status: final packaging checks pending. No deployment, running-GUI reload, restart, installed-CLI update, or real authentication setup change was performed for this branch.

## Implementation

- **#9:** probe failures are per attempt and retryable. Client connection, Remote errors, ambiguous endpoint404, Host401/403, transport/protocol failures and CLI authentication are distinguished without exposing raw server errors. Actual installed Connection/HTTP/Gateway integration was exercised; this is not a deployed GUI/profile test or evidence for every DSH release.
- **#10:** exact-scope evidence, explicit unknown/untested/known-incompatible states, version-pinned binary fingerprints, required suites and a distinct-version comparator. A version probe never becomes a compatibility approval. The UI shows recorded runs separately from the current Host scope, which remains unknown when the runtime does not provide the necessary facts. No updater or permission-changing compatibility action exists.
- **#11:** Grok Build streaming-json and Pi RPC native adapters. Native settings/extensions are preserved; unsupported restrictive parent access refuses before spawning rather than pretending tool selection is an OS sandbox. Pi waits for `agent_settled`, handles prompt dispositions, rejects interactive extension dialogs and clears the queue before aborting.
- **#12:** explicit Claude `nativeAcceptEdits` keeps settings, hooks, MCP and native tools, supports an ordinary Python venv without recursive workspace scanning, and never automatically selects `bypassPermissions`. It requires an explicitly full-access parent. Existing restricted presets/defaults retain their protections.

## Environment and controls

Actual DSH **0.2.1-rc.2**, Node **22.23.4**, Linux x64. Real CLIs were exercised against disposable localhost fake-provider servers and dummy credentials. Test-only HOME/XDG/DSH/native configuration paths were created before runtime initialization. This is not OS-level network containment.

An independent review found inherited shell/loader/credential-file selectors could escape the intended fixture identity. The check environment now uses a narrow allowlist, with regression coverage for `BASH_ENV`, `ENV`, `ZDOTDIR`, `LD_PRELOAD`, Python/Node startup settings, AWS credential-file selectors and SSH agent sockets. Version/control flags needed by the tests are explicitly preserved. Real model inference is not claimed.

Known Snap launchers are refused by the harness because they can rewrite HOME. Antigravity tests use its direct official binary; the initial wrapper failures are not represented as an upstream CLI authentication regression. Native configuration preservation cannot guarantee confinement for arbitrary user extensions; that limitation is why native runs require a full-access parent.

## Recorded outcomes

| Check | Result | Qualification |
| --- | --- | --- |
| Actual DSH self harness | 7 pass | Real SubagentRuntime/process lifecycle with test child |
| Claude Code 2.1.306 | 13 pass, 1 skip | Root-only bypass case skipped on non-root; dedicated real timeout remains untested |
| Antigravity 1.4.4 | 16 pass | Direct binary; dummy credentials, current/old tool argument schemas, filesystem boundaries and cancellation |
| OpenCode 1.19.3 | 13 pass | ACP, tools/config boundaries, auth and cancellation; not a complete six-group version qualification |
| Grok Build 1.0.62 / Pi 1.3.0 | 10 pass / 12 pass, no skips | Native-only six-group records; actual missing-key checks, owned-process cleanup and explicitly synthetic protocol fault injection around real streams |
| Codex 0.162.0 / 0.163.0, default backend | Each 6 pass, 5 fail | Both cannot start filesystem-restricted shell execution in this environment |
| Codex 0.163.0, legacy Landlock request | 6 pass, 5 fail | Also requires Bubblewrap for app-server socket isolation; not a working fallback |
| Actual installed HTTP probe integration | Pass | Real Connection/client/Gateway; CLI absence/auth results use a controlled subprocess/adapter seam |
| Actual installed workflow integration | 15 pass | Real orchestration/registry contracts with fake child backend; no paid models |

The latest existing-three-CLI run plus self checks totals **49 pass, 0 fail, 1 skip**, after the allowlist fix. [Raw case statuses and binary fingerprints](cli-evidence/existing-clis-20261022.raw.json) preserve every result. Absolute executable paths are reduced to basenames in published raw records; versions, SHA256 and outcomes are unchanged. Raw mixed-preset records are **not** accepted as scoped `CompatibilityEvidence`.

### Codex is not falsely certified

Distinct official binaries were used, including an integrity-checked temporary extraction of 0.162.0 without replacing installed 0.163.0. The same eleven cases and default backend were compared. Outcomes are identical, but **identical failures are not proof of backward compatibility**.

All five boundary cases fail before the intended shell command with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`. The parent-ceiling test was strengthened to require actual read-only enforcement output rather than treating an absent file after startup failure as proof. No sandbox was bypassed and no kernel/system policy was changed. The optional legacy-backend experiment also failed and is recorded separately.

See [Codex investigation and reproduction](codex-local-regression-20261022.md), [baseline raw record](cli-evidence/codex-0.162.0-default-20261022.raw.json), [candidate raw record](cli-evidence/codex-0.163.0-default-20261022.raw.json), and [legacy experiment](cli-evidence/codex-0.163.0-legacy-20261022.raw.json).

### Claude placeholder investigation

Claude 2.1.306 adds a deferred tool placeholder to the advertised schemas. Tests now validate that exact reserved schema before excluding it from the executable-tool comparison. Real attempts to call it with empty input or smuggled Write/Bash arguments return `No such tool available`; subsequent direct Bash/outside Write calls still fail in both restricted presets. Every turn's allowed tools and filesystem effects are checked. Unknown additional tools still fail the test.

The native edit test creates a real Python venv, edits through the real CLI/local model, checks the venv remains intact and checks that a test-owned user hook executes. A restricted parent rejects the native choice before any backend request.

## Review and remaining limits

The independent read-only review found no demonstrated permission-elevation or missing-terminal success bug. Its two medium findings (environment selectors and same-version comparison) and one low finding (a requested CLI with zero selected cases) were fixed with regression tests. The comparator now rejects self-comparison, and the harness fails per CLI when a filter selects no cases even if another requested suite passed.

No blanket semver compatibility, arbitrary-extension confinement, production sign-in, root-only Claude behavior, unsupported OS sandbox capability, or live-GUI deployment claim is made. Evidence describes executed cases and exact scopes only. See the [evidence contract](cli-compatibility.md) and [runner design](external-cli.md).
