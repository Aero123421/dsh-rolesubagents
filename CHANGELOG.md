# Changelog

## Unreleased

- Show recorded role ids with local preset SVG icons in a plugin-owned Web subagent catalog. Custom roles receive a neutral icon; unknown roles are not inferred from task labels.
- Add a bounded, read-only role-display RPC that exposes only role identity. Record roles for newly started external CLI activations as well as DSH children.
- Keep deployment separate from development: this update does not automatically install or restart DSH.

## 0.2.1

- The sticky save bar stays at the bottom of the settings page, and the last row is no longer hidden behind it. DSH Web scrolls this page in an ancestor (`overflow: auto`) that also has a bottom padding, so `position: sticky; bottom: 0` sits on that padding edge: the last lines slide under the bar and into the padding. The page sets `scroll-padding-bottom` on that scroller to the bar's height plus the scroller's padding, and scrolls a connection-test result into view (`scrollIntoView({ block: 'nearest' })`) only after the user runs that test.
- 日本語の表示には dsh-japanese が必要です（[dsh-japanese](https://github.com/Aero123421/dsh-japanese)）。This plugin does not call `addLanguage`. It keeps its own dictionary and follows DSH's active locale: `ja` shows Japanese; `zh` (`zh-CN`) and every other locale show English, never a raw message key. Stored-setting repair notes use the same dictionary.
- Real Codex CLI, Claude Code, Antigravity CLI, and OpenCode were not run again for this patch.

## 0.2.0

- Run a role's child on a coding-agent CLI installed on the DSH host: Codex CLI, Claude Code, Antigravity CLI (`agy`), or OpenCode. The parent keeps the same `delegate` tool; a CLI child runs once, notifies the parent with its final answer, and is stopped with `interrupt_agent`. Tested with codex-cli 0.163.0, Claude Code 2.1.303, agy 1.4.2, and OpenCode 1.19.3.
- Role editor: a **Runs on** choice per role, with the CLI's provider (OpenCode), model, reasoning effort, permission preset, and timeout (English and Japanese). A new **External CLIs** section sets each CLI's executable path and the names of host environment variables to forward; no secret is stored.
- **Test connection** for each CLI shows whether it is found, its version, its sign-in state where the CLI can report it cheaply, and its models (used as suggestions). It never calls a model, and is hidden when the Host does not offer the RPC path it uses.
- Fail-closed policy for CLI children: the preset is lowered to what the parent may do (read-only parent role or parent sandbox mode), never widened; below full access the working directory must stay inside the parent's workspace; the delegation depth limit is checked before starting. Failures reach the parent as a fixed-wording diagnostic; the CLI's own error text stays in the host log.
- Confinement of the non-full-access presets, verified against the real CLIs:
  - Claude Code **Read-only** and **Edit files (no shell)** (`acceptEdits`, renamed in the editor) get no Bash: `--tools` limits them to the read tools (plus Edit, Write, NotebookEdit), and no setting sources are loaded, so user or project allow rules, extra directories, hooks, and `CLAUDE.md` cannot widen or affect them. **Auto** counts as full access (its classifier can approve any unsandboxed command).
  - Codex **Workspace write** passes `sandbox_workspace_write.writable_roots=[]`, so extra writable roots from a Codex config do not apply.
  - Antigravity **Edit files** runs with `--mode accept-edits`; without it, headless agy refused writes everywhere except the temp directory.
  - OpenCode below full access does not load the project's configuration (`OPENCODE_DISABLE_PROJECT_CONFIG=1`: no project MCP servers, tool files, agents, or `AGENTS.md`). A run is refused when the project has `.opencode/plugin(s)` code, which OpenCode still runs at start.
  - Presets enforced by the CLI's own tool permissions (Claude Code, Antigravity, OpenCode) are refused for workspace-write runs whose directory contains a symbolic link that leads outside the workspace, and, for OpenCode, whose directory lies below a git repository's top-level (OpenCode's file tools reach the whole repository). The editor shows what enforces each preset.
- The workspace scan includes `.git` and follows internal directory links once per real path, so links hidden in Git metadata or reached through a sibling directory cannot bypass the startup check. Unreadable directories fail closed.
- Runner models, providers, and efforts are limited to letters, digits, and `. _ : @ / + - [ ]` (no leading `-`), so they cannot carry OpenCode `{env:…}` / `{file:…}` references or look like options.
- An explicit `cwd` is refused below full access when the parent's workspace root is unknown (except for read-only runs).
- Stopping a run also stops background processes the CLI left behind, so a leftover process no longer delays the completion notice or `interrupt_agent`. A plugin unload while a run is still starting no longer leaves it running.
- **Test connection** counts a forwarded variable only when it is set on the host (a listed but unset `CODEX_API_KEY` no longer reads as signed in).
- New settings problems (for example an OpenCode role without provider and model, which is switched off) are reported and repaired like the existing ones. Settings from 0.1.x load unchanged, and DSH roles behave as before.
- When a selectable role runs on a CLI, the `delegate` tool description gains one sentence explaining that such roles run once, do not accept `send_message`, are not listed by `list_agents`, and can be stopped with `interrupt_agent`. Their role line is marked `(runs once in <CLI>[, read-only]; cannot receive send_message)`.
- Fix: an unload before the storage domain opened could crash DSH.
- Development: `pnpm check:cli` runs opt-in integration checks against a real DSH runtime and the real CLIs, using local fake model servers (`CHECK_CLI_CASE` selects cases by name). The integration scripts' module-resolution hook no longer recurses on Node 24.

## 0.1.3

- Add a separate workflow default provider/model setting to the Plugins page, with English/Japanese UI, model catalog selection, validation, save/clear, and per-session persistence.
- Workflow `agent()` calls without an explicit route use the configured pair; explicit `provider` and/or `model` retain native workflow override behavior. With no setting, parent inheritance is unchanged.
- Apply only model defaults: no role instructions, preset, reasoning effort, or read-only setting is added. Preserve the official workflow tool's execution and background lifecycle, and refresh scoped adapters when presets change.

## 0.1.2

- Fix: the Host plugin never took effect in a real DSH profile. Per-Session role state was written with `appendPluginRecord` from `@deepseek-ai/dsh-session`, whose private brand check rejects Host Sessions when the plugin resolves that package to its own installed copy (`Receiver must be an instance of class Session`), so `delegate` was never registered. Role snapshots and child roles now live in the `rolesubagents` storage domain; records already written to Session logs are still read back.

## 0.1.1

- Read-only roles re-pin `sandbox/mode` to `read-only` when a later change selects a wider mode.
- Read-only agents refuse write-like MCP and plugin tools by public name. The README lists what that guard cannot see.
- Fork roles warn that inherited tool results can carry prompt injection, and can pass only the task instead of the parent conversation. An invalid fork scope is stored as task only. Fresh and task-only roles refuse a provider that copies the parent conversation.
- Read-only agents refuse `bash`, `pwsh`, and `run_code` unless the latest sandbox mode is `read-only`.

## 0.1.0

- Role-based `delegate` tool with per-session role lists, built-in `general` and `fork` roles, and `worker`, `explorer`, `reviewer` templates.
- Per-role model, child instructions (runtime context), fresh or fork context, read-only sandbox pin, and Agent Preset.
- Role editor on the DSH Web Plugins page (English and Japanese).
