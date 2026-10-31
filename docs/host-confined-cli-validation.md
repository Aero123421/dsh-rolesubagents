# Ordinary-parent Grok/Pi execution — real host-policy checks

Final run: **2026-10-23T06:33:16.693Z**, actual DSH **0.2.1-rc.2**, Linux x64. **18 cases passed, 0 failed, 0 skipped**: nine each for Grok Build 1.0.62 and Pi 1.3.0. These outcomes establish the described checks under DSH's existing **path-based workspace-write policy**. They are **not** a claim of hard-link-safe inode isolation, network isolation, or complete compatibility qualification.

## What became usable

The tests start the configured CLI role from an ordinary `workspace-write` parent, selecting the distinct `workspace-write` runner preset rather than `native`. No parent is promoted to full access. The actual installed DSH sandbox service wraps the real CLI/bootstrap process; native tools, native command execution and explicitly configured extension code execute inside that same file-effect boundary.

On this host, observations returned by the real service identify **`landlock-run`, enforcement `partial`**. Every observed policy call used `mode: workspace-write` and the actual fixture workspace as its writable root. These facts are recorded per case in the [provenance](cli-evidence/host-confined-20261023.provenance.json), not inferred from a CLI argument or an environment variable. The parent notice was checked for the partial-enforcement warning. The host policy permits its backend-defined `/tmp` exception, so project/outside targets in these cases are separate ordinary directories under `/var/tmp`, not `/tmp`.

The tests use real native binaries with disposable HOME/source configuration, temporary private state, dummy credentials and localhost fake providers. The private-state preparation and CLI code run after confinement. A Python venv is created in the project; it remains intact and does not trigger a whole-workspace recursive link preflight.

## Exact execution inventory

| Case | Grok | Pi | What was actually asserted |
| --- | --- | --- | --- |
| Healthy read and inside edit, venv/source state | pass | pass | Native read returns the fixture marker; native write produces exact inside bytes; venv remains intact; original model/settings/auth file hashes and source directory entries are unchanged |
| Ordinary outside overwrite | pass | pass | Genuine tool result reports permission denial and the existing outside sentinel bytes remain unchanged |
| Escaping symlink | pass | pass | A link inside the workspace resolves outside; actual native tool reports denial and outside bytes remain unchanged |
| Hard-link observation | observed limitation | observed limitation | See below: this is not counted as proving inode isolation |
| Additional native behavior | managed-off bounded | extension bounded | Grok's copied managed `sandbox.profile=off` cannot disable the outer DSH policy; Pi's configured extension executes, records an inside proof, and its outside write is denied |
| Missing sandbox service | pass | pass | Refused without model requests; Pi extension startup marker is absent |
| Native shell | pass | pass | Actual advertised shell tool executes Python; inside output succeeds, outside write raises `PermissionError`, and outside bytes remain unchanged |
| Cancellation | pass | pass | Real fake-provider stream starts, owned process identity is observed, interrupt settles, then owned CLI/process identities disappear |
| Wall timeout | pass | pass | Real stream starts; actual 2-second engine limit returns timeout; owned process identities disappear |

Grok's limited-mode explicit native allow rules permit normal Write/Edit/Bash without converting to always-approve/bypass; the outer DSH process policy remains mandatory. Merely setting `acceptEdits` was insufficient for 1.0.62's `write` tool in the initial fixture: it requested approval and canceled the turn. That failed exploratory result is retained locally; the final behavior actually edits and runs bounded shell commands noninteractively.

## Authentication and source-state handling

For Pi, the fixture model definition deliberately contains **no inline API key**. Its source `auth.json` contains a static dummy `api_key` entry and an unused dummy OAuth entry. Real model requests authenticate using the exact dummy static key. The configured native extension examines the private credential map's **provider names/types only** and confirms that only the static-key provider was copied and no OAuth entry is present. No real credentials are loaded by these tests. Browser/OAuth refresh behavior is therefore **not supported or validated by this path**; it is not silently claimed to preserve a logged-in browser session.

The extension is explicitly configured through an absolute path in copied settings. This proves that configured native extension code is confined; it is not a claim that every relative resource path, global extension auto-discovery mechanism, package installer, hook layout or native authentication workflow is preserved. Source configuration/auth bytes and directory entries remain unchanged across every successful fixture.

## Hard links: keep the failed stronger assertion visible

The initial strict Pi assertion required an outside inode to remain unchanged when it already had a hard link inside the writable workspace. It **failed**: the actual outside bytes became `ESCAPED_HARDLINK`. See the preserved [strict failure raw record](cli-evidence/host-confined-pi-hardlink-strict-failure-20261023.raw.json) and [failure log](cli-evidence/host-confined-pi-hardlink-strict-failure-20261023.txt). That failure was not changed into a claim of denied writes.

The final case is deliberately named **“observes host hardlink alias semantics without claiming inode isolation”**:

- Grok's native file tool replaces its workspace link atomically. The workspace path gets the new contents while the outside inode's bytes remain unchanged. This is native tool behavior, **not evidence that the kernel denies all hard-link mutations**.
- Pi's native file tool writes the existing inode, and the outside link sees the same new bytes. The test records this inherited alias behavior and requires the mandatory parent warning about hard links/path-based semantics. It does **not** pass an “outside inode immutable” test.

The final observation accepts either an actual denied operation, an atomic replacement preserving the outside inode, or the exact requested shared-inode mutation with the warning. It rejects unrelated bytes or a silent claim of inode safety. This is the same host-policy vocabulary as ordinary DSH execution, not a stronger plugin-created sandbox. Network access, process visibility and readable credentials are also outside that vocabulary. A partial result is not relabeled full.

## Final native and limited-mode regression

A subsequent same-session full Grok/Pi run, after anchoring grants to the known parent root, passed **40 cases with no failures/skips** (18 host-policy cases plus 22 existing native cases). Both actual versions were pinned, and the parent/root paths in the fixtures are identical. See the [mixed-preset raw regression report](cli-evidence/native-and-host-final-20261023.raw.json), recorded at `2026-10-23T06:43:56.222Z`. This confirms the existing explicit native routes were not silently replaced by the new default. The report remains raw mixed-preset evidence, not a new blanket compatibility certificate.

## Independent provider and built-bootstrap smoke check

`pnpm check:sandbox` independently exercises the installed DSH provider without any model call, then runs the private-state bootstrap from both source and an esbuild-produced Node22 ESM bundle. Both preserve the original dummy source auth bytes, omit OAuth from the private map, remove the boot envelope before the child, permit inside writes and reject direct outside writes. The same direct DSH provider also permits existing hard-link shared-inode mutation, independently confirming that the recorded Pi limitation is inherited rather than a special unconfined CLI fallback. See the [smoke-check observations](cli-evidence/host-sandbox-bootstrap-20261023.txt). This checks current compiled-function serialization, not an assurance for arbitrary future bundler transforms.

When a parent root is known, the engine anchors the policy to that established root (and rechecks child containment); it does not grant a writable model-selected child path that could be retargeted independently. In the recorded fixtures the parent and child project roots are identical, so the exact observed root remains unchanged.

## Repository regression checks

Lint, all three TypeScript configurations and **1077 tests across 34 files** pass after the default/policy/UI changes. Dedicated tests cover exact wrapping, missing/invalid sandbox responses, interruption during wrapping, runner-failure classification, loader-variable/PATH hardening, source-state preparation deferred until inside confinement, safe bootstrap failure guidance, stable parent-root selection, preserved explicit native behavior and the new UI default. The Host/client bundles build successfully. Deployment and a live GUI reload are not part of these checks.

## Reproduce and inspect

From this repository, with the exact installed binaries available:

```sh
DSH_CHECKOUT=/path/to/dsh \
CHECK_CLI_CASE=host-confined \
CHECK_CLI_VERSION_GROK_BUILD=1.0.62 \
CHECK_CLI_VERSION_PI=1.3.0 \
CHECK_CLI_REPORT=artifacts/NEW-unique-host-policy-report.json \
pnpm check:cli grok-build pi
```

Executable path overrides remain available through `CHECK_CLI_EXECUTABLE_GROK_BUILD` / `CHECK_CLI_EXECUTABLE_PI`. Report paths are exclusive-create. Do not copy production profiles to repair a fixture or replace installed CLIs.

- [Final raw case report and executable fingerprints](cli-evidence/host-confined-20261023.raw.json)
- [Final log with actual confinement metadata and alias observations](cli-evidence/host-confined-20261023.txt)
- [Source hashes, redaction and per-case backend facts](cli-evidence/host-confined-20261023.provenance.json)

The Grok executable SHA256 is `2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa`. Pi's entry-file SHA256 is `e79626f2dd6f94aa45d30f3fa63cd84319a6eefcd150b353cfaf274366926774`; that identifies the entry file, not every dynamically loaded package/extension. Published raw records reduce executable paths to basenames and logs replace the checkout path. Original report/log SHA256 values remain in provenance.

These are raw multi-case host-policy observations, **not `CompatibilityEvidence` records imported into a tested workspace preset manifest**. Existing native reports describe a different preset. No macOS/Windows, every Landlock ABI, root/OAuth mode, arbitrary extension behavior, remote service mutation prevention or complete file-effect coverage is certified here.

No running DSH deployment/restart, installed CLI update, real authentication setup change, system-policy change or paid inference was performed for this verification.
