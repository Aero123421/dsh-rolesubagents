# External CLI runners: design notes for maintainers

This document describes how a role with a `runner` runs its child on a host-installed coding-agent CLI
(Codex CLI, Claude Code, Antigravity CLI `agy`, OpenCode), and what to touch when adding or updating a CLI.
User-facing behaviour is documented in the README ("External CLI runners").

## Principles

1. **One contract, many CLIs.** Everything CLI-specific lives in two places:
   a data-only *descriptor* in `src/shared/cli/<id>.ts` (shared by the Host and the browser, so the editor and
   the Host cannot disagree) and an *adapter* in `src/host/cli/<id>/` (builds the invocation, parses the output).
2. **Generic engine, thin adapters.** Spawning, stdio plumbing, line framing, files, timeouts, cancellation,
   settlement and diagnostics are written once in `src/host/external/`. Adapters are pure functions plus a small
   synchronous session, unit-testable from recorded transcripts.
3. **Fail closed.** A child never gets more access than its role's preset and the delegating parent allow. When
   in doubt (unknown preset, unknown access) adapters pick the read-only behaviour.
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
each with an `AccessLevel`), `defaultPermission`, `presetForAccess` (one preset per access level, used to lower a
preset to the ceiling and to switch a read-only role), and `instructionsChannel` (documentation only).

Access levels are ordered `read-only < workspace-write < full-access`. Normalization (`runner.ts`) relies on the
descriptor: unknown permission → `defaultPermission`; read-only role with a wider preset →
`presetForAccess['read-only']`; effort not in `efforts` (unless free text) → cleared; `needsProvider` with a missing
half → cleared and the role switched off. Every rule is idempotent.

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
| `envRemovePrefixes` | Inherited names with these prefixes are removed (Claude Code: `CLAUDE_CODE_`), unless forwarded |
| `files` | Files created before spawn and removed after exit (also on failure or cancel). Keys start with `${RUN_DIR}/` or `${HOME}/` |
| `preflight` | Optional cheap command; a non-zero exit or timeout refuses the start with its `category` |
| `cancelGraceMs` | Wait between `session.cancel()` and the engine's terminate |

Placeholders, substituted by the engine only in argv elements that *start* with a placeholder, in env values, and
in file keys (never in file contents or the task):

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
     `presetForAccess[ceiling]` (logged). Never widened.
3. `startExternalDelegation` (`provider.ts`) registers an ephemeral provider
   `rolesubagents:<cli>:<roleId>:<uuid>` with all start capabilities false and `inheritsParentContext: false`,
   calls `ctx.subagents.startActivation({ provider, label, request: { prompt, parent, cwd? }, signal, delivery:
   'parent' })` without `childId`, `maxDepth`, `agentOptions` or `agentPreset`, and unregisters in `finally`
   (the started run continues). The CLI settings are read live at this point; roles are the session's snapshot.
4. The provider's `start(request)` validates `request.cwd` (absolute, an enterable directory), enforces cwd
   containment below full access (`assertCwdAllowed`, symlinks resolved; skipped when the workspace root is
   unknown), and calls `startExternalRun`.
5. DSH owns the run from here: it notifies the parent with the result, aborts `request.signal` on
   `interrupt_agent`, and disposes the run. The plugin also tracks live runs and disposes them on unload.

## Engine lifecycle (`engine.ts`)

```
startExternalRun
  subprocess service? → cwd check → plan + session (nonce)
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
- **Dispose**: idempotent; stops the run, waits for exit and settlement, untracks it.
- Nothing is rolled back: file changes made before a stop stay. A Host restart stops in-flight runs and their
  completion notices are lost.

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
  names, resolves the executable from the *saved* settings, then calls `adapter.probe`. `message` is a fixed word:
  `subprocess-unavailable`, `not-found`, `probe-failed` (adapters may add their own, such as `version-timeout`).
- `probe-service.ts` mounts a Typert Remote service `rolesubagentsCli` with `probe(request, signal)`, called from
  the browser as `ctx.connection.rpc.call('/api', 'rolesubagentsCli/probe', { args: { request } }, signal)`.
  `@deepseek-ai/dsh-typert-protocol` is an optional peer loaded with a dynamic `import()`; when it is missing the
  feature is skipped and logged once, and the editor hides **Test connection** and uses the descriptor's
  `modelSuggestions`. This RPC path is not a documented DSH API. `@Remote('probe')` is applied by hand in the
  constructor, so the method's parameter names are part of the wire contract and the Host bundle must stay
  unminified.

## Per-CLI summary

| CLI | Protocol | Instructions channel | Presets (read-only / workspace-write / full-access) | Pre-flight | Graceful cancel |
|---|---|---|---|---|---|
| Codex | `codex exec --json`, task on stdin | `-c developer_instructions=…` | `read-only` / `workspace-write` / `danger-full-access` (`-s`) | none | no |
| Claude Code | `claude -p --output-format stream-json --verbose`, task on stdin | `--append-system-prompt` | `read-only` (dontAsk + no setting sources + no write tools) / `acceptEdits`, `auto` / `bypassPermissions` | none | no |
| Antigravity | stream-json in and out, one user event on stdin | generated agent body; full-access: task prefix | `read-only` / `edit-files` (generated agent tool allowlists) / `full-access` (default agent + skip permissions) | `--output-format json models` → `auth` | no (SIGTERM is handled) |
| OpenCode | `opencode acp` (ACP JSON-RPC) | `instructions` file in `${RUN_DIR}` | `read-only` / `edit-files` / `full-access` (permission profiles on agent `dsh-<nonce>`) | none | `session/cancel` + EOF |

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
   Completions for OpenCode), prints its port as the first stdout line, scripts behaviour per request, and logs
   requests so a check can assert that instructions, model and effort reached the model.
3. **Real-CLI integration** (`pnpm check:cli [suites…]`, opt-in, not in CI): `scripts/check-cli.mjs` builds a real
   DSH runtime from `DSH_CHECKOUT` (default `/opt/dsh`) with this plugin loaded from `src/`, finds CLIs on `PATH`
   (with `CLI_PATH_DIR` prepended), and runs `scripts/check-cli/<id>.mjs` (`export async function cases(h)`; the
   helpers are documented in the script header). A suite whose CLI is not found is skipped. Cases always use an
   isolated HOME, the fake server and fake keys, never real credentials. Each CLI's suite covers: answer delivered
   to the parent notice, read-only blocks a write, the default preset writes in the workspace, cancellation ends
   as aborted with no leftover process, an auth/upstream error gives a safe diagnostic, and model + effort reach
   the CLI. `pnpm check:cli self` checks the harness with `tests/support/fake-cli/fake-cli.mjs`.

## Adding a new CLI

1. **Id**: add it to `CliId` and `CLI_IDS` in `src/shared/cli/types.ts`.
2. **Descriptor**: `src/shared/cli/<id>.ts` (frozen object `satisfies CliDescriptor`). Every access level must map
   in `presetForAccess` to a preset of that level; ids unique; `defaultPermission` a workspace-write preset. Put the
   reasoning for presets in the file's header comment.
3. **Descriptor registry**: import it and add the entry to `CLI_DESCRIPTORS` in `src/shared/cli/index.ts`.
4. **Adapter**: `src/host/cli/<id>/index.ts` exporting `<name>Adapter: CliAdapter`, plus `parser.ts` (and
   `probe.ts` if large). Header comment: exact invocation, how each preset is enforced, the instructions channel,
   cancellation, and the CLI version it was verified against. Rules:
   - `plan` and the session are pure and synchronous; sessions never throw;
   - pass instructions through the CLI's native instruction channel, never as user text unless unavoidable;
   - unknown preset or access → read-only behaviour;
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
4. Update the tested version in the README (both languages), the adapter header, and the CHANGELOG.

What to watch for:

- **Codex**: the `exec --json` events (`item.completed` with `agent_message`, `turn.completed`, `turn.failed`,
  `error`); the error texts the parser classifies; `-c` keys (`developer_instructions`, `model_reasoning_effort`,
  `shell_environment_policy.ignore_default_excludes`, `analytics.enabled`, `notify`) and the `--disable` feature
  names; the effort list (`ultra` stays excluded because it also turns on automatic delegation); what
  `workspace-write` makes writable; the `codex debug models` JSON shape and `login status` exit codes.
- **Claude Code**: the final `result` line (`subtype`, `is_error`, `result`, `api_error_status`,
  `terminal_reason`, `permission_denials`, `usage`, `total_cost_usd`); permission mode names; whether
  `--setting-sources ""` still disables settings, hooks and `CLAUDE.md`; the root refusal message for
  `bypassPermissions`; the static model list in `CLAUDE_CODE_MODELS` and the effort list.
- **Antigravity**: stream-json event shapes (`text_delta`, `step_index`, `step_type: agent_response`, the
  terminal `result` with `status`, `denied_actions`, `error`); the `AGY_ERROR:` stderr line; tool names in
  `READ_TOOLS` / `EDIT_TOOLS` and the custom-agent frontmatter keys; whether a custom agent still drops the
  default tools and prompt sections (the reason full access uses the default agent); the `models` JSON shape;
  the default write policy (workspace and temp directory) and where runs are recorded.
- **OpenCode**: the ACP protocol version and flow (`initialize`, `session/new`, `session/set_config_option` ids
  `model` / `mode` / `effort`, `session/prompt`, `session/request_permission` options, `session/cancel`); permission
  keys (`edit`, `bash`, `external_directory`, `doom_loop`, `question`, `plan_enter`, `plan_exit`); how
  `OPENCODE_CONFIG_CONTENT` merges; `error.data.errorName` values; the `opencode models --verbose` format; whether
  it still writes `<repo>/.git/opencode`.
