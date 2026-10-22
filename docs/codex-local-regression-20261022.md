# Codex local old/new regression — 2026-10-22

## Result and limits

**Compatibility qualification did not pass.** Two genuinely different official Codex binaries ran the same 11-case suite with DSH 0.2.1-rc.2 on Linux x64, using their default sandbox backend. Both produced **6 passes, 5 failures, 0 skips**. Their observed case statuses are identical, but matching failures are not proof of backward compatibility.

No installed binary, real profile, authentication settings, production adapter, host policy, kernel settings or running DSH instance was changed. Every inference request in the suite is directed at a disposable localhost Responses endpoint with a dummy provider key. The baseline was downloaded and extracted into a unique temporary directory, not installed globally.

## Exact binary identity

| Role | Version | Direct ELF SHA256 |
| --- | --- | --- |
| Baseline | 0.162.0 | `50ed828f357c655a3c82054d346cab8434f24901f14ec19b8267571bdd008b38` |
| Candidate | 0.163.0 | `399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215` |

The baseline came from the [official npm platform package metadata](https://registry.npmjs.org/@openai/codex/0.162.0-linux-x64) and its [tarball](https://registry.npmjs.org/@openai/codex/-/codex-0.162.0-linux-x64.tgz). Its downloaded archive was verified against the registry's published integrity:

```
sha512-qHWp6oKpf456PqjberGN8avs8zChv2oS+UuDiqVFYAuDOhq6vBc1drh8jEsnR7dBX+zcw03PN5VLtePGlMcC3w==
```

Both final runs selected the direct ELF, not a JavaScript launcher. The selected executable is now also supplied in the fixture's CLI settings so direct engine control/timeout runs and probes cannot accidentally fall back to a different installed version.

## What passed on both versions

- Completion through the actual DSH SubagentRuntime; task, role instructions, model and reasoning effort reach the local backend.
- User cancellation and process cleanup.
- **New real two-second wall-clock timeout:** the CLI actually reaches the streaming local backend, the engine reports timeout, and the Codex process exits. Dummy authorization is checked.
- Provider401 classification with safe parent diagnostics.
- Missing forwarded key and upstream500 classification.
- Version/auth/model-list probe without a model request.

These do not validate filesystem confinement.

## Why five permission cases failed

With the default backend, shell tool execution failed before the requested command ran:

```
bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted
```

This prevented the suite from proving read-only rejection, a permitted workspace write, sibling containment, configured-root suppression with its positive control, and read-only parent ceiling enforcement. In particular, a missing output file is not proof that the sandbox enforced read-only if the sandbox could not start. The parent-ceiling case was strengthened to require actual `Read-only file system` tool output, just like the existing read-only case; this exposed the fifth failure instead of falsely counting it as a boundary success.

The evidence establishes a sandbox-startup limitation of this environment. It does not identify the underlying host security mechanism, nor establish a general incompatibility of either Codex version.

## Official legacy option was also attempted

A separate candidate run set `features.use_legacy_landlock = true` **only in the disposable fixture configuration**. This retained the requested read-only/workspace-write policy and did not disable sandboxing. It also produced 6 passes / 5 failures / 0 skips, with a different startup failure:

```
thread 'main' panicked at linux-sandbox/src/linux_run_main.rs:416:9:
filesystem-restricted execution requires bubblewrap to isolate app-server sockets
```

Therefore legacy Landlock is **not** a working fallback here. No permission bypass or production change was added. The backend is recorded separately in raw report variants; these runs must not be merged into one evidence scope.

## Reproduction and retained local evidence

Set `CHECK_CLI_EXECUTABLE_CODEX` to the specific direct ELF and use a new report path for each run:

```sh
DSH_CHECKOUT=/usr/lib/node_modules/@deepseek-ai/dsh \
CHECK_CLI_EXECUTABLE_CODEX=/absolute/path/to/codex \
CHECK_CLI_VERSION_CODEX=0.162.0 \
CHECK_CODEX_SANDBOX_BACKEND=default \
CHECK_CLI_REPORT=artifacts/unique-baseline.json \
pnpm check:cli codex > artifacts/unique-baseline.log 2>&1
```

Repeat with candidate0.163.0. Both commands intentionally exit1 in this environment. Compare only equal DSH/platform/architecture/backend and equal complete case sets; assert versions and executable hashes differ. No failed/skipped/missing cases can become validated evidence.

Retained local artifacts (ignored by Git; parent may publish reviewed summaries separately):

- [Baseline raw report](../artifacts/codex-0162-default-strict-20261022.json) and [log](../artifacts/codex-0162-default-strict-20261022.log)
- [Candidate raw report](../artifacts/codex-0163-default-strict-20261022.json) and [log](../artifacts/codex-0163-default-strict-20261022.log)
- [Legacy candidate raw report](../artifacts/codex-0163-legacy-strict-20261022.json) and [log](../artifacts/codex-0163-legacy-strict-20261022.log)
- [Raw same-case comparison](../artifacts/codex-comparison-default-20261022.json): `qualificationPassed:false`, no observed status changes. This is not the six-group CompatibilityEvidence schema.
- [Baseline download integrity record](../artifacts/codex-0162-download-20261022.json)

The earlier `*-final-*` raw reports predate strengthening the parent-ceiling assertion; the `*-strict-*` records above are authoritative for this final comparison.
