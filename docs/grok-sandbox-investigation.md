# Installed Grok 1.0.62 sandbox experiment — 2026-10-23

## Conclusion

**Do not enable guaranteed read-only/workspace presets from CLI flags alone on the evidence collected here.** This experiment leaves the production descriptor, adapter and parent-permission checks unchanged.

1. Both requested official profiles fail before inference on this machine: `--sandbox read-only` and `--sandbox workspace` exit **1**, with exact stderr `bwrap: setting up uid map: Permission denied`.
2. More importantly, a disposable user requirements file containing `[sandbox] profile = "off"` or `"devbox"` overrides the CLI's requested `read-only` profile. The installed binary then exits **0**, actually executes the `write` tool and creates the exact requested contents in an ordinary sibling directory outside CWD, temp and GROK_HOME.
3. Therefore an absent file following sandbox startup failure is **not** a demonstrated denied write. A successful final answer with requested flags is also **not** proof that those flags are the effective policy.

Source-level context is documented separately in [upstream review](grok-sandbox-upstream-review.md). Public source revisions are not asserted to correspond to this installed binary.

## Identity and execution

- Actual binary: `grok 1.0.62 (1474f9cbdd91)`, Linux x64.
- SHA256: `2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa`.
- Final run began `2026-10-23T05:40:07.539Z`; the authoritative exact timestamp is in the [raw report](cli-evidence/grok-sandbox-20261023.raw.json).
- Direct subprocess experiment, **not DSH integration**. No DSH runtime version is claimed.
- Invocation: `node scripts/check-cli/grok-sandbox.mjs`; optional `GROK_SANDBOX_EXECUTABLE` selects a direct binary. The runner requires the observed version to equal 1.0.62.
- The script derives the ordinary native argv from the existing adapter, substitutes a private task file, and adds `--permission-mode dontAsk`, plus the requested `--sandbox` profile. It never adds `--always-approve`, `--yolo`, or automatic parent elevation.

The runner exclusively creates a unique evidence root below local ignored `artifacts/`. Each scenario gets separate project/outside/HOME/GROK_HOME directories and an actual Python venv created with `python3 -m venv --without-pip`. These project/outside directories are **not** under `/tmp` or `/var/tmp`, since the installed sandbox documentation lists both as writable exceptions. The runner rejects checkouts/fixtures beneath `/tmp`, `/var/tmp` or the environment's configured temporary roots, rather than treating those writable exceptions as ordinary outside directories. Fake-server startup rejection explicitly stops and waits for its fixture child. This is not an arbitrary-descendant cleanup audit. Test-owned native configuration includes explicit allow rules for ordinary Read/Write, disabled remote configuration/telemetry features, a custom localhost Chat Completions provider and a dummy key. Every model request used the exact dummy key. Native configuration and requirements are never copied from real profiles.

Raw model requests, exact stdout/stderr/exit and targets are retained locally in `artifacts/grok-sandbox-HUUUO4/`. Test fixture directories were removed only after verifying their minted absolute identities. The published [raw report](cli-evidence/grok-sandbox-20261023.raw.json) and [protocol records](cli-evidence/grok-sandbox-20261023.protocol.ndjson) replace personal absolute experiment/binary paths with placeholders; statuses, markers and protocol events are unchanged. Only dummy credentials were used. The raw report records the source artifact SHA256.

## Actual final scenarios

| Scenario | Exit | Model calls | Observed result |
| --- | ---: | ---: | --- |
| Native read control | 0 | 3 | Actual `read_file` completed; tool result contains `SANDBOX_READ_MARKER` |
| Native inside-write control | 0 | 3 | Actual `write` completed; exact `SANDBOX_WRITE_MARKER\n` file exists |
| read-only: read | 1 | 0 | Sandbox startup fails; read not exercised |
| read-only: inside write | 1 | 0 | Sandbox startup fails; **not** counted as successful denial |
| read-only: outside write | 1 | 0 | Sandbox startup fails; **not** counted as successful denial |
| workspace: read | 1 | 0 | Sandbox startup fails; read not exercised |
| workspace: inside write | 1 | 0 | Sandbox startup fails; permitted inside-write behavior unverified |
| workspace: outside write | 1 | 0 | Sandbox startup fails; outside denial unverified |
| CLI read-only + requirements off | 0 | 3 | Actual sibling outside-write succeeds; requested CLI restriction is not effective |
| CLI read-only + requirements devbox | 0 | 3 | Actual sibling outside-write succeeds; requested CLI restriction is not effective |
| CLI read-only + undefined profile | 1 | 0 | Undefined profile cannot establish protections; not an off-fallback demonstration |

All scenarios included ordinary venvs, which remained intact. Normal restricted startup never reached hooks/MCP or inference; consequently **hooks and local MCP under a healthy applied restricted profile were not validated**. No arbitrary MCP/remote-service read-only guarantee is inferred from local FS profiles.

## Important experiment corrections

An initial run requested `write_file` and `{path}` from older tool names. The actual 1.0.62 advertised schema uses `write {file_path,content}` and `read_file {target_file}`. The first run was not write-boundary evidence. The final run uses the observed schemas, checks both native controls actually performed their operation and retains complete tool completion events. Exit0 alone is never used as proof that a tool ran.

## Recommendation

Keep the existing unrestricted/native preset and refusal from restrictive parents. Grok's official profiles deserve separate support rather than being conflated with Pi's lack of native confinement, but support must remain unavailable until its **effective** profile can be authoritatively verified despite managed requirements, application failure is fail-closed for the selected scope, and actual healthy read/inside-write/outside-denial cases pass on supported OS/version combinations. Do not override or rewrite managed policy merely to make a CLI flag win. No independent sandbox implementation or VM is proposed by this experiment.

The script's successful process exit means the investigation ran, native controls were valid, and the reviewed managed-policy counterexamples performed actual writes; it does **not** certify either sandbox. The archived qualification booleans are explicitly false. Per-case observations distinguish startup failure from an ineffective requested restriction.

## Follow-up validation

The follow-up keeps the production descriptor, adapter and parent-admission policy unchanged. English/Japanese UI and README distinguish Grok's unintegrated official profiles from Pi's missing native permission boundary. Three additional adapter tests preserve rejection of unverified profile IDs, and an archived-evidence consistency test ensures this investigation is not imported as restrictive compatibility qualification. Lint, all TypeScript configurations and **1040 tests** pass. Restricted-profile implementation remains **deferred**, not completed by these tests.
