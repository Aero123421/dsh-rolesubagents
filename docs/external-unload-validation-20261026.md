# External CLI unload barrier — 2026-10-26

Issue: [#23](https://github.com/Aero123421/dsh-rolesubagents/issues/23).
Base: `main@00b13dc39bca07989fc4e4b336a469652d96324d` (v0.5.0), verified against the remote default branch.
Environment: Linux x86_64, Node 24.19.0, package-pinned pnpm 10.28.0.

## Change and contract

Host effect cleanup captures each tracked external run's disposal and includes those promises in its existing settlement barrier. Each disposal starts independently; rejection or a synchronous throw is logged, while other run disposals and audit/Session storage cleanup continue. The engine retains every spawned run in the tracker until disposal finishes: a settled result does not prove that its managed range is empty. Result delivery is not delayed by range disposal, and repeated disposal calls still share the same promise. Delegation admission, adapter cancellation grace, ports, settings, dependencies and DSH API usage remain unchanged. The checked-in Host bundle is regenerated.

This waits for disposal settlement, not guaranteed success of a failing disposer. Existing engine behavior still owns termination and `waitForExit` error handling. No additional unload timeout is introduced: a pending disposer keeps unload pending.

## Verification

The tests use `fakeWorld`, `fakeSubprocess`, the actual `apply → delegate → startExternalRun → effect cleanup` path and real disposable run files. They start no external coding CLI, model endpoint or authenticated account.

| Check | Before | After |
| --- | --- | --- |
| Existing lint, three TypeScript configs, tests and committed-bundle reproducibility | Pass; 1,511 tests pass, 2 existing skips | Pass; 1,518 tests pass, the same 2 skips |
| Initial unload regressions on the exact base | 5 expected failures | 5 pass |
| Result-settled/range-pending regressions on first candidate `44dea0881a245c431f05704a229e9bb95526ba90` | 2 expected failures | 2 pass |
| Focused unload/engine/delegate/state suites | — | 77 pass |

New coverage delays process exit and managed-range exit independently, verifies files survive until process exit and are removed before unload acknowledgement, and reloads the plugin only after the old lifetime is drained. Both immediate termination and graceful cancellation are covered. Two concurrent runs exercise disposal rejection and synchronous throw independently, including continued storage close. Success, CLI failure, explicit retry, already-started cancellation and fresh per-run files are preserved. Existing engine/delegate coverage also exercises timeout, startup cancellation, background-child sweep and idempotent disposal.

Independent review identified a second snapshot race in the first candidate: `result.finally` removed the run before `dispose` finished waiting for its managed range. Two additional barrier tests first resolve the result and remove run files, then begin unload with disposal either not yet started or already waiting in `waitForExit`. Both failed on `44dea0881a245c431f05704a229e9bb95526ba90` because unload resolved before the range barrier. Both now keep unload pending, reuse one idempotent range sweep, preserve the completed result, and permit a fresh lifetime after release. Engine tests also assert tracker retention after successful/aborted result settlement and removal after disposal. Completed runs remain owned until DSH calls dispose or plugin unload does so; no automatic result-triggered disposal is added.

Commands (from the repository unless an absolute path is shown):

```sh
CI=true COREPACK_HOME=/tmp/issue23-corepack XDG_DATA_HOME=/tmp/issue23-pnpm-data XDG_CACHE_HOME=/tmp/issue23-pnpm-cache corepack pnpm install --frozen-lockfile
TMPDIR=/var/tmp/dsh-issue23-tests COREPACK_HOME=/tmp/issue23-corepack XDG_DATA_HOME=/tmp/issue23-pnpm-data XDG_CACHE_HOME=/tmp/issue23-pnpm-cache corepack pnpm check
node /tmp/dsh-issue23-before-20261026/scripts/test-isolated.mjs --root /tmp/dsh-issue23-before-20261026 tests/external-unload.test.ts
node scripts/test-isolated.mjs tests/external-unload.test.ts tests/external-engine.test.ts tests/external-delegate.test.ts tests/state-lifecycle.test.ts
node scripts/build.mjs
```

The before worktree is detached at the exact base; only the new test is copied into it, with the same installed development dependencies. Its five failures occur at early unload acknowledgement / missing isolation of a synchronous disposal failure. Test-owned processes/files are recovered in `finally`.

Initial environment attempts are retained in the handoff logs: ambient pnpm 11 could not write its default store; pre-existing dependencies lacked the optional Typert development package; `/tmp/.git` caused two unrelated workspace fixture failures. Frozen installation with pinned pnpm and disposable `TMPDIR=/var/tmp/dsh-issue23-tests` resolves these without a source/lockfile change. The isolated test wrapper sets disposable HOME/XDG before plugin startup. Writing the alternate temp root required an approved sandbox escalation because the default filesystem mounted it read-only.

## Boundaries

Actual DSH Loader/Cordis unload/reload, actual CLI processes, OS process-range enforcement and real accounts are **not tested** in this change. Reload checks use fake Host effects/registry and explicit range-exit acknowledgement. Existing skipped optional integration tests remain skipped. No production install/configuration, running DSH restart, credentials, tunnel, merge or release is performed. Separate review of the exact PR head remains required.
