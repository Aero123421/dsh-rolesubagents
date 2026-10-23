# Recorded native CLI runs — 2026-10-22

These are genuine **real CLI + localhost fake-model** runs, not version observations or live-provider tests. The runtime was DSH **0.2.1-rc.2**, Linux x64; the permission preset was **native** (full-access parent required). Recorded protocols: Grok Build `streaming-json`, Pi `rpc`.

| CLI | Exact version | Passing cases | Fail / skip |
| --- | --- | --- | --- |
| Grok Build | 1.0.62 | 10 | 0 / 0 |
| Pi | 1.3.0 | 12 | 0 / 0 |

Each suite includes one **explicitly synthetic fault-injection** case around the real CLI's stdout stream. Malformed/unknown lines were inserted by the test wrapper, not emitted by the native CLI. The actual backend request and final native answer remain required.

## Records and provenance

- [Archived raw report](native-20261022-final.raw.json): actual observed versions/pins, binary entry-file SHA256, timestamp and individual outcomes. Resolved executable paths were reduced to basename; other evidence is unchanged, and this normalization is recorded in the report.
- [Console log](native-20261022-final.txt): timeout diagnostics belong to successful timeout assertions, not hidden failed tests. Personal executable/report paths are normalized.
- [Grok evidence](grok-build-1.0.62-native-final.json) and [Pi evidence](pi-1.3.0-native-final.json): reviewed groups imported into the application manifest.
- [Grok provenance](grok-build-1.0.62-native-final.json.provenance.json) and [Pi provenance](pi-1.3.0-native-final.json.provenance.json): archived-report hashes, executable identities, reproduction command and limitations.
- [Recorder](../../scripts/record-cli-evidence.mjs): maps **exact reviewed case names**. Missing cases become `skip`; unknown cases are retained and force a skipped review marker. Duplicates, inconsistent totals, missing fingerprints and version-pin mismatches are rejected. Output uses exclusive creation, not overwriting.
- [Recorder tests](../../tests/record-cli-evidence.test.ts): conversion failure modes and reproduction of both manifest records from the archived report.

Intermediate runs remain local artifacts: the first 18-case run lacked explicit missing-key/cleanup/fault-injection checks and was not sufficient for full qualification. The 20-case run added missing-key and PID checks. The first fault-injection run exposed a **test wrapper** bug (spreading a PiSession class instance lost its prototype methods); that failed run was retained locally, the wrapper was corrected to delegate methods explicitly, and the final 22-case rerun passed. No adapter defect was concealed by changing an expected result.

## Meaning of required groups

| Group | Actual assertions |
| --- | --- |
| startup-completion | Real binary starts through delegation; task, instructions and configured model reach the fake provider; final answer reaches parent. |
| cancel | Interrupt while actual provider stream is active produces stopped notice. A harness-owned PID identity is first observed, then no matching owned descendant remains. |
| timeout | Real provider stream reaches CLI; engine's 2-second timeout yields timeout diagnostic. Owned process identities are observed before timeout and absent afterward. |
| protocol | Real tool loop, truncation/error and parallel runs settle; Pi additionally exercises handled extension disposition/dialogs. Synthetic malformed/unknown records inserted before real stdout records are tolerated without becoming the answer. |
| permission-boundary | Restricted parent is refused before native delegation; Pi checks its extension marker is absent and dialogs are not approved. **Not OS confinement.** |
| configuration-auth | Temporary native model/provider config loads; requests use the exact dummy key; provider401 maps to auth; missing-key startup maps to auth/config before any provider request. Pi's native extension demonstrably loads. |

Fixtures live in [Grok suite](../../scripts/check-cli/grok-build.mjs), [Pi suite](../../scripts/check-cli/pi.mjs), and [native fake backend](../../tests/support/fake-models/native-chat.mjs). The [ownership scanner](../../tests/support/process-ownership.mjs) reads ancestry/PID birth first and only checks environments of harness descendants; it does not intentionally inspect unrelated processes. No real sign-in, global configuration, installed CLI or running DSH was changed. Tests used the tightened allowlist environment and disposable homes.

## Limits — never broaden the badge

- `native` requires a full-access parent. Restricted-parent refusal is tested; read-only/workspace-write execution, arbitrary extension isolation and OS network confinement are **not** claimed.
- Missing-key startup, dummy keys and simulated provider401 are tested, not live login, every provider or paid inference.
- The process scanner checks observed harness descendants carrying the test's unique native-config environment marker, with PID birth protection. It is not a universal proof against malicious processes deliberately erasing markers or daemonizing before observation.
- Unknown/malformed-line tests are transparent **synthetic injection around real execution**. Broader parser/race cases are separate unit tests, not falsely attributed to the CLI.
- The executable hash covers the entry file; Pi's dynamically imported dependencies and arbitrary extensions are not included in that hash.
- Version equality alone does not establish the current host's full scope. UI can show these recorded runs while current-host assessment remains **unknown**.
- Adapter revision is not a schema scope axis. Review/regenerate records when adapter, engine, permissions or harness behavior changes; do not silently retain stale green evidence.

## Reproduce

Use Node >=22.19, an existing DSH installation, direct CLI binaries and fresh output filenames:

```sh
DSH_CHECKOUT=/path/to/dsh \
CHECK_CLI_EXECUTABLE_GROK_BUILD=/path/to/grok \
CHECK_CLI_EXECUTABLE_PI=/path/to/pi \
CHECK_CLI_VERSION_GROK_BUILD=1.0.62 CHECK_CLI_VERSION_PI=1.3.0 \
CHECK_CLI_REPORT=artifacts/native-new-run.json \
pnpm check:cli grok-build pi

node scripts/record-cli-evidence.mjs artifacts/native-new-run.json grok-build 1.0.62 \
  artifacts/grok-new-evidence.json 'THE EXACT COMMAND EXECUTED ABOVE'
node scripts/record-cli-evidence.mjs artifacts/native-new-run.json pi 1.3.0 \
  artifacts/pi-new-evidence.json 'THE EXACT COMMAND EXECUTED ABOVE'
```

A filtered run cannot qualify by omitting mandatory cases. New or renamed cases require mapping review. These two records are different CLIs, not an old/new version pair. Other raw reports in this directory cover mixed presets or environment failures; they are not automatically included in the compatibility manifest.
