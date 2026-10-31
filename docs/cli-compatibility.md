# Exact-scope CLI compatibility evidence

This foundation is informational, not a permission grant, installation/update manager, or a claim that a CLI is universally safe. It does not change an adapter's permission policy. A newer version, a matching semver range, a successful `--version`, and a successful update are **not** verification.

## Wiring API

`src/shared/cli-compatibility.ts` is pure and independent of the CLI registry, so new adapters can use it without editing the core CLI type union.

```ts
interface CompatibilityScope {
  cli: string
  cliVersion: string
  dshVersion: string
  platform: string
  arch: string
  preset: string
  protocol: string
}
resolveCliCompatibility(scope?: Partial<CompatibilityScope>, evidence?: readonly CompatibilityEvidence[])
// -> { state, reason, evidenceIds }
```

All seven fields must match exactly, including platform/architecture, selected preset and protocol. Use adapter-owned protocol identifiers, consistently across the probe/UI and harness (for example `exec-json`); do not substitute a wildcard or infer them from a CLI version. `cliVersion` should be the version extracted from the actual executable, not the expected value copied from a command-line argument. Keep the raw observation in a separate diagnostic if useful. Missing fields, empty strings, `unknown` and `*` are incomplete scopes.

| State | Meaning |
| --- | --- |
| `unknown` | The current scope is incomplete; even a known CLI version is insufficient. |
| `untested` | A complete scope has no exact, valid, fully passing report. Missing/failing/skipped suites do not qualify. |
| `tested` | An exact report passes every required suite, every recorded extra suite, and every recorded case. Applies only to these conditions/checks. |
| `known-incompatible` | An exact report has an explicit maintainer incompatibility classification referencing failed required suites. Ordinary environmental failures do not automatically mean the CLI version is incompatible. |

Explicit incompatibility takes precedence if both passing and incompatible evidence exist for the same scope, regardless of ordering. Reconcile/remove superseded incompatibility records through review; timestamps do not silently erase them.

`src/client/CliCompatibility.tsx` is wired into successful connection-test cards, in a collapsible verification section. It has English/Japanese labels, displays all scope fields, and distinguishes the detected version from historical documentation. It makes no RPC calls and starts no tests. The current probe supplies only `{ cli, cliVersion }`, which intentionally shows `unknown`, not green: it cannot authoritatively supply every runtime/preset scope field. Matching-version recorded runs are displayed separately with their exact environments and a warning that this does not establish a match to the current Host.

## Current manifest and historical evidence

`CLI_COMPATIBILITY_EVIDENCE` contains the [reviewed native Grok/Pi records](cli-evidence/README.md), generated from 22 real-CLI/local-fake-model cases on 2026-10-22. Their six required groups include missing-key diagnosis, owned-process cleanup, and explicitly synthetic unknown/malformed-line injection around real protocol streams. These are native-only records, not OS sandbox certificates. No result is fabricated from version observations. `HISTORICAL_CLI_BASELINES` records only the versions documented in v0.2.0 at commit `28d1f62818c42a9c6cb64af361c93157e2926827`:

| CLI | Historically documented version | Documented protocol family |
| --- | --- | --- |
| Codex | 0.163.0 | `exec --json` |
| Claude Code | 2.1.303 | stream-json |
| Antigravity | 1.4.2 | stream-json |
| OpenCode | 1.19.3 | ACP |

Sources: the README, v0.2.0 changelog, and `docs/external-cli.md`, including the testing layers and per-CLI summary. Those documents describe real-CLI tests but do not supply a complete dated report for each exact DSH/platform/architecture/preset/protocol scope. The historical manifest therefore stores `testedAt`, `dshVersion`, `platform`, `arch`, and `preset` as `null`; it is not accepted as full verification evidence. A release date is not a test date. Other observed versions without complete scoped evidence remain observations; historical documentation is not upgraded by the new Grok/Pi records.

## JSON evidence contract: version 1

One JSON document describes **one exact scope** and one completed harness run. These fields are required:

- `schemaVersion`: exactly `1`.
- `id`: stable nonempty report identifier.
- `scope`: all seven nonempty strings above.
- `recordedAt`: actual run timestamp in ISO 8601 including `Z` or an offset. Do not invent historical dates.
- `source`: `{ "kind": "real-cli-local-fake-model", "command": "the actual reproduction command" }`.
- `suites`: array of `{ "id": string, "status": "pass" | "fail" | "skip", "cases": [{ "id": string, "status": "pass" | "fail" | "skip" }] }`.
- Optional `incompatibility`: `{ "reason": string, "suiteIds": string[] }`. Each unique referenced id must name a failed required suite. This is an explicit reviewed conclusion, not generated from any nonzero exit.

Suite ids must be unique within a report; case ids must be unique within a suite. Extra suite ids are allowed. Summary status is computed: any failed case => `fail`; otherwise empty cases or any skipped case => `skip`; otherwise `pass`. A conflicting summary invalidates the report. Any extra suite that fails/skips prevents the whole report passing. Reports are trusted test records, not signed attestations: validation checks structure/consistency, not whether a human honestly executed the command. Do not accept arbitrary user-provided JSON as an authorization decision.

Required suite groups (exported as `REQUIRED_COMPATIBILITY_SUITES`):

| Id | Minimum intent; preserve exact existing case names inside `cases` |
| --- | --- |
| `startup-completion` | Real binary starts through adapter, task/instructions/model parameters reach the fake server, final answer reaches parent. |
| `cancel` | Interrupt settles as aborted, including subprocess cleanup. |
| `timeout` | Timeout ends the real CLI/process range without leaving a task running. |
| `protocol` | Actual stream/RPC records parse correctly; terminal result/error and unknown events are handled. |
| `permission-boundary` | The **selected preset's** actual boundary or documented lack of confinement is exercised. Read-only needs denied writes; workspace-write needs both permitted inside and refused outside writes under the claimed mechanism. Full access is not a claim of confinement. If the mechanism cannot be verified, skip/fail, never fabricate a pass. |
| `configuration-auth` | Fake credentials and isolated temporary configuration are used; config loading/forwarding and missing-auth diagnostics are checked without touching real sign-ins. |

Do not label a group passing merely because one unrelated check passed. Each harness owner must define and document its expected case inventory; the comparison validates supplied outcomes and mandatory groups, not an unknowable omitted case list. A filtered run must emit omitted required groups/cases as `skip` (or omit the group, which also prevents passing). Missing binaries, unavailable OS sandbox facilities, unsupported features and auth prerequisites are skips/failures, not successes.

## Recording and comparing new/old versions

1. Keep version-specific binary paths; do not force-update a user's installed CLI.
2. Read the actual CLI version, DSH version, `process.platform` and `process.arch`; record the exact preset/protocol selected by the test.
3. Use isolated temporary HOME/config/workspace, local fake provider servers and fake keys only. No VM, real credentials or paid model calls are required. Run destructive file tests only in test-owned workspaces. Boundaries involving temp directories must follow the existing harness guidance (some CLIs grant broader temp access).
4. Execute all required groups through the real CLI; retain case statuses, including failures/skips. Emit one report per scope. Do not aggregate separate presets into one `preset: "all"` green result.
5. Validate with `validateCompatibilityEvidence(report)` before saving. Preserve real timestamps and reproduction commands, but redact secrets and host-private paths. Command strings should use safe path placeholders with reproduction instructions rather than credentials.
6. Compare two runs:

```sh
node scripts/compare-cli-evidence.mjs baseline.json candidate.json \
  --baseline-version 0.163.0 --candidate-version EXACT_NEW_VERSION
```

Node >=22.19 is required (native stripping of the imported TypeScript types). JSON output contains `passed`, `errors`, and valid-report assessments. Exit `0` means both reports passed their recorded required/extra checks, the actual versions matched the two expected versions, and every scope field except `cliVersion` was identical. Exit `1` means comparison/evidence failed. Exit `2` means usage, file or JSON parsing failed. This script does not execute CLIs, fetch releases, install software, mutate reports, or write to DSH.

`compareCliEvidence(baseline, candidate, { baselineVersion, candidateVersion })` exposes the same pure comparison for harness tests. Different DSH versions, operating systems, architectures, presets, protocols or CLI names are rejected as incomparable; produce separate comparison runs for those changes. The two CLI versions must be distinct and match the explicitly expected values; comparing a report to itself cannot certify an old/new regression. A passing comparison is regression evidence for the checks run, **not** proof that every behavior or security property is unchanged.

After reviewing a genuine report, a maintainer can import its exact `CompatibilityEvidence` into the manifest. Re-run evidence whenever the adapter/flags/config behavior changes, even when the CLI version stays the same. Adapter revision is not currently a scope axis: until versioned adapter provenance is added, treat manifest maintenance as part of every adapter change and do not retain stale green reports.
