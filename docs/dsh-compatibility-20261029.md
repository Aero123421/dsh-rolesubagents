# DSH compatibility validation — 2026-10-29

Baseline: `Aero123421/dsh-rolesubagents` main **9db2d2df542d27403fdeb30fd34715582e225a2e**, including [PR26 / v0.6.0](https://github.com/Aero123421/dsh-rolesubagents/pull/26). The supplied workspace initially contained older main `3e13214`; all changes and final checks use the new baseline. No repository or ancestor `AGENTS.md` or applicable `.agents/skills` files were found.

## Official versions and provenance

The [official npm package](https://registry.npmjs.org/@deepseek-ai%2Fdsh) identifies [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (`apps/cli`) as its repository. At verification time, **no stable SemVer version was published**. npm's `latest` tag points to an RC and must not be called a stable release.

| Channel | Exact DSH version | Official source tag commit |
| --- | --- | --- |
| npm `latest` | `0.2.1-rc.2` | `687f282e8625c6b8d11ff58211a90524be2e4317` |
| npm `next` | `0.2.1-rc.4` | `504a01a9578abc2c6f1fb896b1dc322c9fe24f66` |
| npm `alpha`; current source `master` | `0.2.2-alpha.2` | `f3803c96974ad4a94195fb97e5c637e9c2a3afe3` |

Sources: official release tags [rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2), [rc.4](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.4), [alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-alpha.2). npm records have no `gitHead`; the tag SHAs identify reviewed source, not a proven reproducible mapping from source to npm artifacts. Exact official npm tarball URLs and SHA-512 integrity values are retained in the installation lockfiles and verification provenance.

Three separate installations were created under `/workspace/dsh-runtimes/<version>`, using only the official npm package, exact versions and `npm install --ignore-scripts --no-audit --no-fund`. No login or real account was used. Runtime: Linux x64, Node **24.19.0**. Alpha requires Node `>=24.9.0`; Node 22 was not requalified in this run.

The old peer range `>=0.2.1-alpha.3 <0.3.0-0` admits rc.2/rc.4 but **excludes** `0.2.2-alpha.2` under normal SemVer prerelease rules. The three DSH peer ranges now explicitly include only that checked additional alpha. Development SDK pins are unchanged.

## Changes

- Preserve the Host's conditional workflow registration. Alpha stores its `when` condition on the registration, outside the returned definition. Previously copying that definition into the agent scope made it unconditional; a real alpha registry reproduced false admission becoming true. The plugin now uses the public `tools.executable` lookup when present, with no fallback when it returns undefined. A conditional workflow remains native, without this plugin's workflow model default. Older Hosts retain their existing lookup. See the [upstream tool registry contract](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/core/tools/src/index.ts).
- Preserve complete prerelease/build version tokens in Claude Code, Grok Build and Pi diagnostics; do not shorten an unknown token into a falsely stable version.
- Recheck probe cancellation after asynchronous executable resolution and adapter completion. Cancelled requests cannot continue into adapter work or publish/cache a late successful result.
- Adapt the actual-runtime harnesses to [official explicit executors and batch dispatch](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/docs/upgrade-guide/v0.2.1-rc.2/tool-executor-plugins/guide.md), required session projections, `function-body` PTC program format and pre-step `agent.model.select`. The small shared test helper mounts the installed native executor; it does not replace dispatch or guards with mocks.
- Observe persisted role writes through the public post-durability `domain/changed` event, rather than trying to replace a method on one scoped service proxy. Match the v0.6.0 start receipt while retaining the assertion that startup is not completion. Temporary-workspace tests no longer assume the executor has no ancestor `.git` marker.
- Rebuild committed Host artifacts. No new lifecycle manager, authentication path, CLI installer or automatic updater was added.

The rc.2/rc.4 external manager implementations are identical. Alpha's external startup, cancellation, disposal and subprocess contracts remain compatible. PR26's unload disposal barrier and read-only startup fix already cover their intended cases and were not duplicated.

## Final verification

All checks below ran after the final production source and Host bundle changes.

The integration coordinator separately reported an independent npm-latest `0.2.1-rc.2` smoke with all 11 plugins loaded together, covering startup, shutdown/re-enable and reconnection. This was run in another executor, not rerun by this repository worker. Peer warnings remain in the separated-prefix installation: they reflect dependency-resolution differences between installation prefixes while the Host versions are within the declared ranges; the warnings were not silently treated as resolved. This does not qualify every combination of plugin features.

| DSH | Workflow | Native delegation/recovery | Role management | Connection/Gateway | External runtime self checks |
| --- | --- | --- | --- | --- | --- |
| `0.2.1-rc.2` | 18 passed | passed | 23 passed | passed | 7 passed, 0 skipped |
| `0.2.1-rc.4` | 18 passed | passed | 23 passed | passed | 7 passed, 0 skipped |
| `0.2.2-alpha.2` | 19 passed | passed | 23 passed | passed | 7 passed, 0 skipped |

The additional alpha workflow check resolves real step admission with its condition false, true, then false again, verifying that the native conditional definition remains unchanged. Native delegation covers one-shot route/effort validation, pre-spawn refusals, read-only dispatch/re-pinning, unchanged persisted parent snapshots, compaction, warm follow-up and cold restoration of the same child. External self checks exercise completion delivery, safe failure text, interrupt, leftover-process cleanup, plugin unload, depth/workspace refusal and Remote mounting.

- Unit suite: **1,598 passed, 2 skipped**, 54 files. The skips are opt-in installed-runtime controls, not failed checks relabeled as passes; the separate 15-suite runtime matrix ran successfully.
- Lint, Host/client/test TypeScript checks, frozen lockfile validation and `git diff --check`: passed using the repository's pnpm **10.28.0**.
- Two consecutive final builds produced byte-identical SHA-256 hashes for all four `lib/` files. Host JS: `a150b2b74d4e085ba86190159d3e3959711751de89d5eb90ee8380ce6cb605d5`.
- Regression-first evidence: nine CLI/probe cases and two workflow cases failed before their fixes and passed afterward.

Reproduce with each exact installed checkout:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
DSH_CHECKOUT=/path/to/installed/dsh node scripts/check-workflow-host.mjs
DSH_CHECKOUT=/path/to/installed/dsh node scripts/check-delegation-host.mjs
DSH_CHECKOUT=/path/to/installed/dsh node scripts/check-role-management-host.mjs
DSH_CHECKOUT=/path/to/installed/dsh node scripts/check-probe-host.mjs
DSH_CHECKOUT=/path/to/installed/dsh CHECK_CLI_REQUIRE_ALL=1 node scripts/check-cli.mjs self
```

Run-specific evidence is retained at `/workspace/dsh-verification-evidence`: `final/status.txt` contains all 15 zero exit codes; `final/*.log` and CLI JSON reports contain detailed results; `provenance.jsonl`, `official-npm-metadata.json`, `npm-*.json` and installation lockfiles preserve official package provenance. Unit/typecheck/lint and repeated-build logs/hashes are alongside them. Initial failures remain recorded separately from the final runs.

## Scope and remaining work

**Real:** the official installed DSH launcher/runtime, scoped tool registries/native executors, SubagentRuntime, subprocess lifecycle, storage, Loader/settings writer, and loopback Connection/HTTP/Gateway. The probe test includes the actual rebuilt Host artifact.

**Fixtures:** scripted local model adapter/metadata, parent/child backends where explicitly documented by each harness, fake CLI subprocess and recorded version/protocol responses. No paid inference, live model backend, external coding CLI account or actual new CLI binary was exercised. Version parsing success is not CLI compatibility certification; existing historical CLI evidence remains separate. Browser/UI rendering and OS permission-boundary requalification were not performed.

Alpha's additional writable-root grants are not forwarded by existing confined CLI policy: it continues to grant the parent workspace root only. This narrows access; it does not silently widen permissions. Conditional workflows retain native activation and omit only the optional model default. The private probe RPC remains an upstream compatibility dependency despite passing these exact versions.

[PR25](https://github.com/Aero123421/dsh-rolesubagents/pull/25), head `a32a583cde032bb56d49205e2c048196fd5179b6`, **is not superseded by PR26**. Its dependency updates and unconfirmed-save draft protection are still absent on current main. Fresh `pnpm audit` reports four advisories: two moderate Vitest mocker advisories, high Zod, and high Happy DOM. See [Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), [Happy DOM](https://github.com/advisories/GHSA-834v-8h66-3h79), [Vitest one](https://github.com/advisories/GHSA-qxg6-89mg-rqv8), [Vitest two](https://github.com/advisories/GHSA-xp26-3454-mjgp). The unconfirmed-save footer still offers its destructive reload action. Those existing PR changes were deliberately not duplicated here; PR25 needs a rebase and validation against v0.6.0 before a merge decision.

Parallel research/fixes used GPT-6.1-sol; operation verification used GPT-6.1-terra at high reasoning. The agent API has no service-tier parameter, so the requested fast tier could not be selected or verified. Validation used no account login, credential retrieval, persistent permission grant, merge, release or deployment. Draft PR publication is a separately authorized follow-up; it does not release this plugin. No approval denial or uncertain mutation remains outstanding.
