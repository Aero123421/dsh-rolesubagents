# External CLI runners: design notes for maintainers

This document describes how a role with a `runner` runs its child on a host-installed coding-agent CLI
(Codex CLI, Claude Code, Antigravity CLI `agy`, OpenCode, Grok Build `grok`, Pi `pi`), and what to touch when adding or updating a CLI.
User-facing behaviour is documented in the README ("External CLI runners").

## Principles

1. **One contract, many CLIs.** Everything CLI-specific lives in two places:
   a data-only *descriptor* in `src/shared/cli/<id>.ts` (shared by the Host and the browser, so the editor and
   the Host cannot disagree) and an *adapter* in `src/host/cli/<id>/` (builds the invocation, parses the output).
2. **Generic engine, thin adapters.** Spawning, stdio plumbing, line framing, files, timeouts, cancellation,
   settlement and diagnostics are written once in `src/host/external/`. Adapters are pure functions plus a small
   synchronous session, unit-testable from recorded transcripts.
3. **Fail closed.** A child never gets more access than its role's preset and the delegating parent allow. When
   in doubt, refuse unsupported access. A CLI without a verified read-only preset must not fabricate one. Native harnesses require a full-access parent because retained hooks/extensions are not confined.
4. **No secrets in config.** The CLIs use their own sign-in, or the user forwards variable *names*
   (`envPassthrough`) whose values are read from the Host process at spawn time.
5. **Version-tolerant parsing.** Unknown events and non-JSON lines are ignored; success is decided only from
   documented terminal events; raw CLI or provider text never reaches the parent model.
6. **Backwards compatible.** A role without `runner` behaves exactly as in 0.1.x.

## Layout

```
src/shared/
  cli/types.ts          CliId, CLI_IDS, AccessLevel, ACCESS_ORDER, PermissionPreset, CliDescriptor
  cli/index.ts          CLI_DESCRIPTORS registry, isCliId, cliDescriptor, permissionPreset, presetAccess
  cli/<id>.ts           one descriptor per CLI
  runner.ts             RoleRunner, CliSettings, normalization of `runner` and `clis`
  roles.ts              RoleDefinition.runner, roleContextText / roleListLine / runnerNote for runner roles
src/host/
  tool.ts               delegate → delegateExternal for runner roles
  index.ts              wiring: live `clis` settings, run tracker, housekeeping, probe service
  external/
    types.ts            the adapter contract (PlanInput, RunPlan, RunSession, RunOutcome, ProbeRunner, CliAdapter)
    registry.ts         CLI_ADAPTERS registry, AdapterLookup
    policy.ts           access ceiling, effective preset, depth check, cwd checks
    workspace.ts        workspace integrity checks before tool-scope runs (git top-level, escaping links, startup code)
    provider.ts         one ephemeral DSH provider per delegation
    engine.ts           startExternalRun, createProbeRunner, toSubagentResult
    env.ts              child environment composition
    lines.ts            LineSplitter (stdout) and ByteTail (stderr)
    diagnostic.ts       fixed-vocabulary diagnostics
    probe.ts            probeCli (the connection test)
    probe-service.ts    the `rolesubagentsCli` Remote service around probeCli
  cli/<id>/index.ts     the adapter (plus parser.ts, and probe.ts where useful)
```

## The contract

### Descriptor (`src/shared/cli/types.ts`)

`CliDescriptor` is pure data: `id`, `displayName`, default `executable` (PATH name), `needsProvider` (OpenCode:
model is provider + model, both required), `modelSuggestions` (static fallback for the editor), `efforts` (allowed
ids, or `[]`), `effortFreeText` (any non-empty effort accepted, OpenCode), `permissions` (presets in display order,
each with an `AccessLevel`, a `confinement`, and optional `nativeHarness`), `defaultPermission`, `presetForAccess` (a partial mapping containing only supported access levels,
used to lower a preset to the ceiling and to switch a read-only role), `instructionsChannel` (documentation only),
`toolScope` and the optional `startupCodeDirs` (see [Workspace checks](#workspace-checks)).

`confinement` says what enforces a preset: `os-sandbox` (Codex: an OS sandbox that also covers shell commands and
resolves symbolic links), `tool-scope` (the CLI's own tool permissions: Claude Code, Antigravity, OpenCode), or
`none` (full access). The editor shows it in the permission field's help. `toolScope` is how far a `tool-scope`
preset's file tools reach: `cwd`, or `git-worktree` (OpenCode: the whole worktree around the directory).

Access levels are ordered `read-only < workspace-write < full-access`. Normalization (`runner.ts`) relies on the
descriptor: unknown permission → `defaultPermission`; read-only role with a wider preset →
`presetForAccess['read-only']` when present, otherwise retain native settings but switch the incompatible role off; effort not in `efforts` (unless free text) → cleared; `needsProvider` with a missing
half → cleared and the role switched off; `model`, `provider` and `effort` must match `RUNNER_NAME_PATTERN` (letters,
digits, `. _ : @ / + - [ ]`, no leading `-`, at most 128 characters), otherwise `invalid-runner-model` /
`invalid-runner-effort` (this keeps OpenCode `{env:…}` / `{file:…}` references and option-like values out). Every rule
is idempotent.

### Adapter (`src/host/external/types.ts`)

```ts
interface CliAdapter {
  readonly descriptor: CliDescriptor
  plan(input: PlanInput, nonce: string): RunPlan            // pure
  createSession(input: PlanInput, nonce: string): RunSession // pure, synchronous state machine
  probe?(exe, run: ProbeRunner, signal, settings): Promise<ProbeResult>  // never calls a model
  housekeeping?(home: string): Promise<void>                 // once per plugin start, errors only logged
}
```

`PlanInput` carries the normalized `runner`, the effective `preset` and its `access` (after the ceiling), the
`instructions` (`roleContextText(role)`: `Your role: <id>.`, the role's instructions, the read-only sentence for
read-only roles, and the one-shot sentence), the `task` (the delegate prompt) and the validated absolute `cwd`.
`nonce` is 12 hex characters from the engine; tests pass a fixed one.

`RunPlan`:

| Field | Meaning |
|---|---|
| `argv` | Arguments without the executable; never shell-interpreted |
| `env` | Overlay; `undefined` removes a variable (unless the user forwards it by name) |
| `envJson` | Variables whose value is JSON built by the engine (OpenCode's `OPENCODE_CONFIG_CONTENT`): string leaves that start with a placeholder are substituted, then the value is serialized with `$`, `{`, `}` inside strings as `\u` escapes. A temp path with backslashes cannot corrupt it, and no data can form a placeholder or an `{env:…}` reference |
| `envRemovePrefixes` | Inherited names with these prefixes are removed (Claude Code: `CLAUDE_CODE_`), unless forwarded |
| `files` | Files created before spawn and removed after exit (also on failure or cancel). Keys start with `${RUN_DIR}/` or `${HOME}/` |
| `preflight` | Optional cheap command; a non-zero exit or timeout refuses the start with its `category` |
| `cancelGraceMs` | Wait between `session.cancel()` and the engine's terminate |

Placeholders, substituted by the engine only in argv elements and `envJson` string leaves that *start* with a
placeholder, in env values, and in file keys (never in file contents or the task):

- `${RUN_DIR}`: a private 0700 temp directory per run, created only when the plan mentions it, removed afterwards;
- `${HOME}`: the child's HOME (the overlay's `HOME`, else the Host's);
- `${SECRET}`: a fresh 32-hex random value per run (OpenCode's local server password).

Adapters must not put free user text into env values. Files are written with mode 0600 and flag `wx` (an existing
file is never overwritten); `..` or empty path segments are refused.

`RunSession`:

| Method | Called |
|---|---|
| `start(io)` | Once, right after spawn. Simple CLIs write the task and `io.end()`; OpenCode writes `initialize` |
| `line(text)` | For each complete stdout line (no line ending). Non-JSON must be tolerated |
| `cancel?()` | Graceful cancel request (OpenCode: `session/cancel` + stdin EOF) |
| `finish(exit)` | Once, after exit and stdout drain; `exit` = `{ code, signal, stderrTail, cancelled, timedOut }` |

Session methods are synchronous and must never throw (the engine still contains a throw and ends the run as
`cli-crashed`). `stderrTail` may be parsed for a terminal error line (agy's `AGY_ERROR`, Claude Code's root refusal)
but is never forwarded.

`RunOutcome` = `{ status: 'completed' | 'failed' | 'max-tokens' | 'refusal', answer?, category?, facts?, usage?,
deniedActions? }`. `facts` are safe tokens only (see [Diagnostics](#diagnostics)).

### Probe

`probe(exe, run, signal, settings)` uses the injected `ProbeRunner` (no stdin, bounded output, timeout, the same
environment a run would get, plus `opts.env`). It returns `ProbeResult` = `{ cli, found, path?, version?,
auth?: 'ok' | 'missing' | 'unknown', models?: { id, name?, efforts? }[], message? }`. It must not call a model or
write the CLI's state.

## Delegation path

`delegate` in `src/host/tool.ts`:

1. `resolveRole` as for DSH roles. If the calling agent's role is read-only, `readOnlyCallDenial` allows only
   read-only target roles (a runner role never copies the parent conversation, so a read-only runner role is fine).
2. `delegateExternal`:
   - a runner role is refused with a clear message when DSH lacks `ctx.subagents.registerProvider`
     (checked in `provider.ts`) or `ctx.subprocess` (checked in `engine.ts`); DSH roles keep working;
   - `assertDepth(parent, ctx.subagents.resolveMaxDepth(undefined))`: DSH does not check external children;
   - `accessCeiling(parent, parentReadOnly, ctx.get('sandboxPolicy'))`: read-only for a read-only parent role,
     else the parent's sandbox mode (`read-only` → read-only, `danger-full-access` → full-access, anything else or
     no service → workspace-write), plus the parent's `workspaceRoot`;
   - `effectivePermission(descriptor, runner, ceiling)`: the role's preset when its level fits, else
     `presetForAccess[ceiling]` for a legacy preset when supported (logged). Missing mappings refuse. An explicit `nativeHarness` preset above the ceiling refuses instead of silently changing harness. Never widened;
   - `assertExplicitCwdCheckable(args.cwd, access, workspaceRoot)`: an explicit `cwd` cannot be checked when the
     workspace root is unknown (no `sandboxPolicy`, a throwing one, or no root), so it is refused unless the run is
     read-only or full access (where containment does not apply). Without `cwd`, DSH's default is kept.
3. `startExternalDelegation` (`provider.ts`) registers an ephemeral provider
   `rolesubagents:<cli>:<roleId>:<uuid>` with all start capabilities false and `inheritsParentContext: false`,
   calls `ctx.subagents.startActivation({ provider, label, request: { prompt, parent, cwd? }, signal, delivery:
   'parent' })` without `childId`, `maxDepth`, `agentOptions` or `agentPreset`, and unregisters in `finally`
   (the started run continues; the disposer's result is awaited in the background and a failure is only logged,
   since a registry may return a promise). The CLI settings are read live at this point; roles are the session's
   snapshot.
4. The provider's `start(request)` validates `request.cwd` (absolute, an enterable directory), enforces cwd
   containment below full access (`assertCwdAllowed`, symlinks resolved; skipped when the workspace root is
   unknown, which only DSH's default directory can reach), and calls `startExternalRun` with the workspace root.
5. DSH owns the run from here: it notifies the parent with the result, aborts `request.signal` on
   `interrupt_agent`, and disposes the run. The plugin also tracks live runs and disposes them on unload.

## Engine lifecycle (`engine.ts`)

```
startExternalRun                       (every await checks the delegation signal and the plugin lifetime)
  subprocess service? → cwd check → workspace checks → plan + session (nonce)
  → placeholders (${SECRET}, ${HOME}, ${RUN_DIR} if mentioned) → env (composeEnv) → argv
  → resolveExecutable (settings path or descriptor name; not found → "<CLI> was not found …")
  → write files → pre-flight → spawn
superviseRun
  session.start(io) → stdout lines → session.line … → exit → drain (≤ 2 s)
  → session.finish → toSubagentResult → files removed → untracked
```

- **Environment** (`env.ts`): DSH's subprocess service merges the overlay over its scrubbed copy of the Host
  environment (names matching `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, and `DSH_*` removed). The overlay is built as
  1. fixed removals (`CLAUDECODE`, `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`);
  2. inherited names with an adapter prefix removed;
  3. the adapter overlay;
  4. forwarded names copied from the Host environment. These override removals but never an explicit adapter value.
- **Spawn**: `ctx.subprocess.spawn({ argv: [resolved, ...argv], cwd, stdio: pipes, graceMs: 3000, env })`. DSH's
  local runtime starts the child detached (own session), so CLIs have no controlling TTY.
- **Pre-flight**: runs through `createProbeRunner` (stdout capped at 1 MiB, stderr at 64 KiB, 1 s TERM→KILL grace);
  a failure throws `formatDiagnostic(name, category, { 'pre-flight': 'timeout' } | {})`, which the parent model
  sees as the tool error.
- **Lines** (`lines.ts`): UTF-8 safe across chunks, `\n` and `\r\n`; a line over 8 MiB is dropped whole (logged
  once) and the splitter resynchronizes. The last 16 KiB of stderr are kept for `finish` and the Host log only.
- **Timeout**: `runnerTimeoutMs(runner)` (default 30 minutes) → `timedOut` → stop ladder → category `timeout`.
- **Plugin lifetime**: `EngineDeps.lifetime` is aborted in the plugin's effect cleanup. It is combined with the
  delegation's signal from the start of `startExternalRun` and checked after every await and right before spawn,
  so a delegation still resolving its executable, writing files or running its pre-flight when the plugin unloads
  never spawns (its files are removed). From spawn on, the run is tracked and the cleanup disposes it.
- **Stop ladder** (same for an aborted signal, `dispose()` and the timeout):
  1. graceful cancel: `session.cancel()` if the session has one;
  2. after `plan.cancelGraceMs`: `handle.terminate()` (SIGTERM), then DSH sends KILL after the 3 s spawn grace.

  A session without `cancel` is terminated at once. Codex, Claude Code and agy use `cancelGraceMs: 0`;
  OpenCode uses 5 s (it normally exits about 0.6 s after `session/cancel`, having stopped its tool processes).
- **Settlement**: `result` never rejects. `toSubagentResult` maps: cancelled → `aborted`; timed out → `error` with
  `timeout`; `completed` with a non-blank answer → `completed` (blank → `error`/`empty-answer`); `max-tokens` →
  `max-tokens` with a diagnostic; `refusal` → `refusal`; otherwise `error` with the category's diagnostic. Partial
  answer text is kept as output. `exit code` is added to the facts. A non-completed, non-aborted run logs a warning
  with the diagnostic head and the stderr tail.
- **Dispose**: idempotent. If the run has not settled: cancelled, stop ladder. Then it waits for the result, sends
  one more `handle.terminate()` and waits for `handle.waitForExit()`, then untracks the run. The extra terminate
  is required: DSH's `waitForExit` resolves only when the whole managed range (systemd scope or process group) is
  empty, and a CLI that exits normally (or within the cancel grace, which clears the terminate timer) may leave a
  daemon or background child behind; without it the disposal — and with it DSH's completion notice, its slot and
  `interrupt_agent` — would hang. Once the range is empty, terminate is cheap. A terminate that throws is logged.
  DSH awaits `run.dispose()` after the result in `finishDisposal`, so this runs for every external run.
- Nothing is rolled back: file changes made before a stop stay. A Host restart stops in-flight runs and their
  completion notices are lost.

## Workspace checks

`workspace.ts`, called by the engine before `plan` (`checkWorkspace`). Refusals are thrown with fixed text, the CLI's
display name and the working directory (the parent sees them as the tool error); a link's path goes to the Host log
only. The checks only read the filesystem (no git binary).

- **Startup code** (below full access, `descriptor.startupCodeDirs`): OpenCode 1.19.3 imports
  `.opencode/plugin(s)/*.{js,ts}` at start even with `OPENCODE_DISABLE_PROJECT_CONFIG=1` and `--pure` (verified), so
  a run is refused when such a directory exists in the run's directory or a parent up to the git top-level (to `/`
  outside git; the home directory itself is skipped: that is the user's own config).
- For a **workspace-write run of a `tool-scope` preset** only:
  - **git top-level above the directory** when `toolScope` is `git-worktree` (OpenCode): a `.git` directory or file
    found walking up from the real path of `cwd`, strictly above it. OpenCode's `edit` permission patterns are
    relative to the worktree and `external_directory` only fires outside the worktree; an anchored `edit` rule
    (`{"*": "deny", "<sub>/*": "allow"}`) does stop `write`/`edit` (verified), but `apply_patch` (offered instead of
    write/edit for `gpt-*` models) checks only a move's *source* path, so a `*** Move to:` reached a sibling
    directory (verified). Hence a refusal rather than an anchored rule. Claude Code and agy are `cwd`-scoped
    (verified: sibling, repository top-level and outside writes are refused).
  - **escaping symbolic links**: a bounded walk of the `cwd` tree (including `.git` and internal directory links, with each real directory visited once; budget
    `SCAN_MAX_ENTRIES` = 100 000 entries and `SCAN_MAX_MS` = 2 s, exceeding it refuses — fail closed) for a link
    whose target (for a dangling link: the path it would create) is outside the real path of the parent's workspace
    root (else of `cwd`). Read-only runs and `os-sandbox` presets are not scanned. Residual risk: hard links are
    not detected, and another process can change the filesystem after the startup scan.

## Diagnostics

`diagnostic.ts` builds the only failure text the parent model sees:

```
Subagent failure (CLI: <displayName>; category: <category>[; <fact>: <value>]…)
<one fixed hint line for the category>
```

Categories (`FailureCategory`): `auth`, `limit`, `rate-limit`, `model`, `max-tokens`, `service`, `transport`,
`permission`, `config`, `cli-missing`, `cli-crashed`, `timeout`, `empty-answer`, `unknown` (no hint). Facts are kept
only when the key matches `/^[a-z][a-z ]{0,31}$/` and the value is a finite number or matches
`/^[A-Za-z0-9_.:-]{1,64}$/` (for example `exit code: 1`, `http status: 401`, `reason: bypass-refused-as-root`).
The text is capped at 4096 UTF-8 bytes. Start errors thrown by the engine are built from fixed text, the display
name and the working directory only.

Adapters map CLI errors to categories with fixed keyword rules and never copy provider messages into facts or
answers.

## Probe service

- `probe.ts` `probeCli(request, deps, signal)`: validates the CLI id, composes the environment with the forwarded
  names, resolves the executable from the *saved* settings, then calls `adapter.probe` with the settings'
  `envPassthrough` reduced to the names actually set (non-empty) in the Host environment (`probeSettings`), so an
  adapter never reports a sign-in from a merely listed variable. `message` is a fixed word:
  `subprocess-unavailable`, `not-found`, `probe-failed` (adapters may add their own, such as `version-timeout`).
- `probe-service.ts` mounts a Typert Remote service `rolesubagentsCli` with `probe(request, signal)`, called from
  the browser as `ctx.connection.rpc.call('/api', 'rolesubagentsCli/probe', { args: { request } }, signal)`.
  `@deepseek-ai/dsh-typert-protocol` is an optional peer loaded with a dynamic `import()`; when it is missing the
  Host mounting is skipped and logged once. The client reports each attempt separately, retains retry controls, and uses descriptor suggestions when discovery is unavailable. Failures never globally disable diagnostics or ordinary role execution. This RPC path is not a documented stable DSH API. `@Remote('probe')` is applied by hand in the
  constructor, so the method's parameter names are part of the wire contract and the Host bundle must stay
  unminified.

### Probe diagnostics and runtime scope

Local connection absence, structured Remote errors, HTTP endpoint 404, Host authentication (401/403), transport failure and malformed carriers are separate client states. CLI executable/authentication results are distinct from RPC failures. HTTP 404 is intentionally ambiguous: both absent Gateway and absent Remote method produce it. No inference, update or permission change follows a probe failure.

`scripts/check-probe-host.mjs` exercises installed browser Connection, Host HTTP bridge/auth, Typert Registry/Gateway and actual decorated plugin Remote in an isolated in-process loopback server. It verifies 404 ambiguity, 401/403, argument errors and recovery on DSH `0.2.1-rc.2`; this is not a deployed `dsh web` profile/GUI test or stable-public-API guarantee. The subprocess seam is a fixture, not an actual CLI/model call. Grok/Pi probes run only `--version`; Pi help/model-list commands initialize extensions and are unsuitable for side-effect-free discovery.

## Per-CLI summary

| CLI | Protocol | Instructions channel | Presets (read-only / workspace-write / full-access) | Pre-flight | Graceful cancel |
|---|---|---|---|---|---|
| Codex | `codex exec --json`, task on stdin | `-c developer_instructions=…` | `read-only` / `workspace-write` (+ `writable_roots=[]`) / `danger-full-access` (`-s`); OS sandbox | none | no |
| Claude Code | `claude -p --output-format stream-json --verbose`, task on stdin | `--append-system-prompt` | `read-only` (dontAsk + `--tools` read tools + no setting sources) / `acceptEdits` ("Edit files (no shell)": `--tools` read tools + Edit/Write/NotebookEdit, no setting sources) / `nativeAcceptEdits`, `auto`, `bypassPermissions` | none | no |
| Antigravity | stream-json in and out, one user event on stdin | generated agent body; full-access: task prefix | `read-only` / `edit-files` (generated agent tool allowlists; edit-files adds `--mode accept-edits`) / `full-access` (default agent + skip permissions) | `--output-format json models` → `auth` | no (SIGTERM is handled) |
| Grok Build | `--output-format streaming-json --prompt-file` | `--rules` | unsupported / unsupported / `native`; native config/auth/extensions retained | none | process termination |
| Pi | `--mode rpc --no-session` | `--append-system-prompt` private file | unsupported / unsupported / `native`; native config/auth/extensions retained | none | `clear_queue` ack → `abort` ack → stdin EOF, then engine fallback |
| OpenCode | `opencode acp` (ACP JSON-RPC) | `instructions` file in `${RUN_DIR}` | `read-only` / `edit-files` / `full-access` (permission profiles on agent `dsh-<nonce>`; below full access `OPENCODE_DISABLE_PROJECT_CONFIG=1`) | none | `session/cancel` + EOF |

What each preset loads from the project: Codex reads `AGENTS.md` and, for a trusted project, `.codex/config.toml`
(`-s` and `writable_roots=[]` still win). Claude Code's `read-only` and `acceptEdits` load no setting sources (no
user/project/local settings, hooks, allow rules, `additionalDirectories`, `CLAUDE.md`; verified: user and project
hooks and allow rules have no effect, while a control run with default sources runs them); `auto`, `bypassPermissions`, and explicit `nativeAcceptEdits` load default settings. Only `nativeAcceptEdits` also omits `--strict-mcp-config` and retains inherited `CLAUDE_CODE_*` variables (fixed adapter overlays still apply). It preserves native tools/MCP/hooks and skips recursive tool-scope preflight. It requires an already full-access parent but passes `--permission-mode acceptEdits`, not automatic bypass. OpenCode below full access loads only the user's global config (no project
`opencode.json` MCP servers, `.opencode` agents/commands/tools, `AGENTS.md`/`CLAUDE.md` — a trade-off: project
instructions are not seen; verified that a project MCP server and tool file do not run), at full access everything;
project plugins are refused (above). Antigravity reads the project's `AGENTS.md`.

Grok and Pi have different capability limits: Grok provides official OS `read-only`/`workspace` sandbox profiles, whereas Pi does not provide a comparable built-in boundary for arbitrary extensions. The Grok adapter currently offers only native execution; it neither selects/verifies those profiles nor forces existing native restrictions off. Official profile integration remains deferred until effective-policy conflicts and healthy filesystem boundaries can be verified, not merely flags passed. See the [source review](grok-sandbox-upstream-review.md) and [real-binary investigation](grok-sandbox-investigation.md). Existing native evidence is not certification of either official sandbox profile.

Pi waits for `agent_settled`, not `agent_end`, because retries/continuations can follow. Prompt acknowledgments are correlated; handled/unknown dispositions terminate explicitly rather than hanging or pretending an answer exists. Interactive extension requests receive cancellation, never automatic approval. Grok's observed `max_tokens_truncation` error/nonzero exit is truncation, not success; preserve its sanitized fixture.

The adapters' header comments hold the exact flags and the evidence for each choice; keep them current.

## Testing layers

1. **Unit tests** (`pnpm test`, in CI):
   - `tests/shared-runner.test.ts`, `tests/shared-roles.test.ts`: normalization of `runner` and `clis` (every
     problem code, idempotence, 0.1.x settings unchanged), descriptor consistency, text helpers.
   - `tests/cli-<id>.test.ts`: `plan()` argv/env/files for every preset × instructions/model/effort variant, the
     session against **real recorded transcripts** in `tests/fixtures/cli/<id>/` (success, tool use, every error,
     cancellation), and probe parsing with a fake `ProbeRunner` over captured outputs.
   - `tests/external-engine.test.ts`: the engine with a fake subprocess service (`tests/external-fakes.ts`): line
     splitting, stdin, files and placeholders, pre-flight, timeout, abort, crash, env composition.
   - `tests/external-delegate.test.ts`: the delegate path with fake subagents and sandbox policy (ephemeral
     provider registered and removed, no forbidden start fields, ceiling, read-only parent, depth, cwd).
   - `tests/external-units.test.ts`: registry consistency, policy, env, diagnostics, line framing.
   - `tests/client-*.test.ts`: editor drafts, save payload with `clis`, page rendering, i18n completeness.
2. **Fake model servers** in `tests/support/fake-models/<id>.mjs` (Node ESM, no dependencies): each speaks the API
   its CLI calls (OpenAI Responses for Codex, Anthropic Messages for Claude Code, Gemini for agy, OpenAI Chat
   Completions for OpenCode, Grok Build and Pi), prints its port as the first stdout line, scripts behaviour per request, and logs
   requests so a check can assert that instructions, model and effort reached the model.
3. **Real-CLI integration** (`pnpm check:cli [suites…]`, opt-in, not in CI): `scripts/check-cli.mjs` builds a real
   DSH runtime from `DSH_CHECKOUT` (default `/opt/dsh`) with this plugin loaded from `src/`, finds CLIs on `PATH`
   (with `CLI_PATH_DIR` prepended), and runs `scripts/check-cli/<id>.mjs` (`export async function cases(h)`; the
   helpers are documented in the script header). Missing explicitly requested suites/binaries fail; optional discovery may skip unavailable CLIs. The harness isolates HOME/XDG/DSH_HOME and scrubs credential/config overrides before loading DSH, so housekeeping cannot use the real home. Cases use disposable native configuration, localhost fake servers and dummy keys. Native Grok/Pi tests prove restricted-parent refusal, not support for a read-only execution mode in these adapters; Grok's separate official sandbox capability is investigated independently. Consult actual outcomes and the [evidence contract](cli-compatibility.md), not just a suite exit code. `pnpm check:cli self` checks the harness with `tests/support/fake-cli/fake-cli.mjs`.
   `CHECK_CLI_CASE=<text>` runs only cases whose name contains the text. Write boundaries must be checked in a
   workspace outside `/tmp` (`h.workspace(files, { outsideTmp: true })`, default `/var/tmp`, override with
   `CHECK_CLI_OUTSIDE_TMP`): Codex and agy always allow writes under the temp dir, which hides a wrong preset. DSH
   removes credential-shaped names such as `GIT_CONFIG_KEY_<n>` from children; an inherited `GIT_CONFIG_COUNT` then
   breaks every git command in the child (OpenCode would not see the worktree), so the OpenCode suite sets
   `GIT_CONFIG_COUNT=0`. The `@deepseek-ai/*` resolve hook (`scripts/host-resolve-hook.mjs`) guards against
   re-entry, since on Node 24 `require.resolve` runs the registered hooks again.

### Reproducible harness controls

```sh
DSH_CHECKOUT=/path/to/dsh CHECK_CLI_EXECUTABLE_PI=/absolute/path/to/pi \
CHECK_CLI_VERSION_PI=1.3.0 CHECK_CLI_REPORT=artifacts/pi-unique-run.json \
pnpm check:cli pi
```

- `CHECK_CLI_EXECUTABLE_<UPPER_ID>` chooses the exact binary (replace hyphens with underscores, e.g. `CLAUDE_CODE`, `GROK_BUILD`); `CLI_PATH_DIR` still prepends PATH.
- `CHECK_CLI_VERSION_<UPPER_ID>` requires an exact detected version. Reports record resolved executable path/SHA256/version, expected version, DSH version, platform/architecture and case outcomes.
- `CHECK_CLI_REPORT` exclusively creates raw JSON; an existing output path fails instead of overwriting evidence. Raw case reports are not automatically complete `CompatibilityEvidence` qualifications.
- `CHECK_CLI_REQUIRE_ALL=1` makes skips fail. Unknown requested CLI IDs and zero-case filters fail too. Missing explicitly requested suites/binaries fail even without that switch.
- Known Snap launch wrappers are refused because they can replace disposable HOME. Choose the direct official CLI binary; never copy real credentials to repair fixture authentication. This guard is not proof that arbitrary custom wrappers preserve isolation.
- Environment scrubbing and localhost model endpoints are not an OS network sandbox. CLI telemetry and native extensions may have independent side effects; never copy production extensions into tests.

Validation has explicit limits: Claude 2.1.306 has 13 passing cases and one root-only skip (non-root runner), without a dedicated real wall-timeout case; Grok 1.0.62 has 10 passing cases, Pi 1.3.0 has 12, direct Antigravity 1.4.4 has 16, OpenCode 1.19.3 has 13. Only the reviewed native Grok/Pi records currently qualify all six groups; totals alone are not compatibility badges. Codex 0.162.0 and 0.163.0 each have 6 passes and 5 filesystem-check failures because the sandbox cannot configure loopback (`RTM_NEWADDR: Operation not permitted`); selecting legacy Landlock also failed. Identical failures do not prove backward compatibility. See the [verification report](external-cli-validation-20261022.md), [Codex comparison](codex-local-regression-20261022.md), and [published native evidence](cli-evidence/README.md). Do not turn failures/skips/missing groups into validation.

## Adding a new CLI

1. **Id**: add it to `CliId` and `CLI_IDS` in `src/shared/cli/types.ts`.
2. **Descriptor**: `src/shared/cli/<id>.ts` (frozen object `satisfies CliDescriptor`). Present `presetForAccess` entries must map to presets of that level; unsupported levels stay absent. IDs must be unique and `defaultPermission` must exist. Native-only Grok/Pi default to `native` (full access), not a fictitious workspace-write preset. Mark native presets `nativeHarness: true` and document limitations.
3. **Descriptor registry**: import it and add the entry to `CLI_DESCRIPTORS` in `src/shared/cli/index.ts`.
4. **Adapter**: `src/host/cli/<id>/index.ts` exporting `<name>Adapter: CliAdapter`, plus `parser.ts` (and
   `probe.ts` if large). Header comment: exact invocation, how each preset is enforced, the instructions channel,
   cancellation, and the CLI version it was verified against. Rules:
   - `plan` and the session are pure and synchronous; sessions never throw;
   - pass instructions through the CLI's native instruction channel, never as user text unless unavoidable;
   - unknown/unsupported preset or access → refuse; native extensions prevent tool allowlists from proving confinement;
   - success only from a documented terminal event with a non-blank answer;
   - map failures to `FailureCategory` with fixed rules; facts are safe tokens only;
   - disable auto-update, telemetry and session persistence where the CLI allows; keep the run from writing the
     user's config;
   - a pre-flight for sign-in when a not-signed-in CLI would otherwise hang or prompt.
5. **Adapter registry**: add the entry to `CLI_ADAPTERS` in `src/host/external/registry.ts`.
6. **i18n** (`src/client/i18n.ts`, English **and** Japanese): `preset.<presetId>` for every new preset id,
   `ed.readOnlyHelp.<id>` (how Read-only is enforced). If the CLI `needsProvider`, review `ed.cliModelOpenCode`,
   which is the text shown for any CLI that needs a provider.
7. **Fixtures**: capture real transcripts into `tests/fixtures/cli/<id>/` (success, multi-message, tool use, every
   error class, cancellation, not signed in, probe outputs). Scrub absolute temp paths and anything secret-looking.
8. **Unit tests**: `tests/cli-<id>.test.ts` as described above.
9. **Fake model server**: `tests/support/fake-models/<id>.mjs`.
10. **Integration cases**: `scripts/check-cli/<id>.mjs` with the cases listed under Testing layers; run
    `pnpm check:cli <id>`.
11. **Docs**: the README.md and README.ja.md tables (per-CLI details, read-only, limits), this document's per-CLI
    summary, the CHANGELOG, and `keywords` in `package.json`.
12. `pnpm lint && pnpm typecheck && pnpm test`, then `pnpm build` and commit `lib/`.

## Updating to a new CLI version

1. Read the CLI's release notes for changes to flags, output events, permission modes, config keys and sign-in.
2. Re-capture the transcripts in `tests/fixtures/cli/<id>/` with the new binary against the fake model server
   (use the argv the unit tests assert for `plan()`), and replace the old files when the format changed. Keep
   fixtures for older formats that the parser should still accept.
3. Run `pnpm test`, then `pnpm check:cli <id>` with the new binary on `PATH` (or in `CLI_PATH_DIR`).
4. Record exact CLI/DSH versions, platform, architecture, preset, protocol and required-suite outcomes following [CLI compatibility](cli-compatibility.md). Preserve failures/skips, distinguish environment failures from reviewed incompatibility, and compare genuinely distinct old/new binaries with expected versions pinned. Update both READMEs, adapter header and CHANGELOG with actual scope, not a blanket tested-version claim.

What to watch for:

- **Codex**: whether `-c sandbox_workspace_write.writable_roots=[]` still clears configured roots (the check-cli case
  has a control run without it); the `exec --json` events (`item.completed` with `agent_message`, `turn.completed`, `turn.failed`,
  `error`); the error texts the parser classifies; `-c` keys (`developer_instructions`, `model_reasoning_effort`,
  `shell_environment_policy.ignore_default_excludes`, `analytics.enabled`, `notify`) and the `--disable` feature
  names; the effort list (`ultra` stays excluded because it also turns on automatic delegation); what
  `workspace-write` makes writable; the `codex debug models` JSON shape and `login status` exit codes.
- **Claude Code**: the `--tools` names (`Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `Edit`, `Write`,
  `NotebookEdit`; `Glob`/`Grep` exist only when named) and that neither restricted preset offers `Bash`; the final `result` line (`subtype`, `is_error`, `result`, `api_error_status`,
  `terminal_reason`, `permission_denials`, `usage`, `total_cost_usd`); permission mode names; whether
  `--setting-sources ""` still disables settings, hooks and `CLAUDE.md`; the root refusal message for
  `bypassPermissions`; the static model list in `CLAUDE_CODE_MODELS` and the effort list.
- **Antigravity**: whether headless agy still needs `--mode accept-edits` to write in the workspace (test outside
  `/tmp`: the temp dir is always writable) and still refuses writes outside the run's directory; stream-json event shapes (`text_delta`, `step_index`, `step_type: agent_response`, the
  terminal `result` with `status`, `denied_actions`, `error`); the `AGY_ERROR:` stderr line; tool names in
  `READ_TOOLS` / `EDIT_TOOLS` and the custom-agent frontmatter keys; whether a custom agent still drops the
  default tools and prompt sections (the reason full access uses the default agent); the `models` JSON shape;
  the default write policy (workspace and temp directory) and where runs are recorded.
- **OpenCode**: whether `OPENCODE_DISABLE_PROJECT_CONFIG` still skips project config and whether project plugins
  still load despite it (`startupCodeDirs`); whether file tools still reach the whole git worktree (`toolScope`); the
  ACP protocol version and flow (`initialize`, `session/new`, `session/set_config_option` ids
  `model` / `mode` / `effort`, `session/prompt`, `session/request_permission` options, `session/cancel`); permission
  keys (`edit`, `bash`, `external_directory`, `doom_loop`, `question`, `plan_enter`, `plan_exit`); how
  `OPENCODE_CONFIG_CONTENT` merges; `error.data.errorName` values; the `opencode models --verbose` format; whether
  it still writes `<repo>/.git/opencode`.

- **Grok Build / Pi**: preserve native config/extensions and refuse unsupported ceilings before startup. Check Grok terminal/truncation events and usage aggregation; Pi prompt acknowledgments, final `message_end`, `agent_settled`, extension-dialog rejection and cancel acknowledgment ordering. Ignoring unknown protocol events does not prove compatibility.
