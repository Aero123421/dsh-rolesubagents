# Changelog

## 0.2.0

- Run a role's child on a coding-agent CLI installed on the DSH host: Codex CLI, Claude Code, Antigravity CLI (`agy`), or OpenCode. The parent keeps the same `delegate` tool; a CLI child runs once, notifies the parent with its final answer, and is stopped with `interrupt_agent`. Tested with codex-cli 0.163.0, Claude Code 2.1.303, agy 1.4.2, and OpenCode 1.19.3.
- Role editor: a **Runs on** choice per role, with the CLI's provider (OpenCode), model, reasoning effort, permission preset, and timeout (English and Japanese). A new **External CLIs** section sets each CLI's executable path and the names of host environment variables to forward; no secret is stored.
- **Test connection** for each CLI shows whether it is found, its version, its sign-in state where the CLI can report it cheaply, and its models (used as suggestions). It never calls a model, and is hidden when the Host does not offer the RPC path it uses.
- Fail-closed policy for CLI children: the preset is lowered to what the parent may do (read-only parent role or parent sandbox mode), never widened; below full access the working directory must stay inside the parent's workspace; the delegation depth limit is checked before starting. Failures reach the parent as a fixed-wording diagnostic; the CLI's own error text stays in the host log.
- New settings problems (for example an OpenCode role without provider and model, which is switched off) are reported and repaired like the existing ones. Settings from 0.1.x load unchanged, and DSH roles behave as before.
- When a selectable role runs on a CLI, the `delegate` tool description gains one sentence explaining that such roles run once, do not accept `send_message`, are not listed by `list_agents`, and can be stopped with `interrupt_agent`. Their role line is marked `(runs once in <CLI>[, read-only]; cannot receive send_message)`.
- Fix: an unload before the storage domain opened could crash DSH.
- Development: `pnpm check:cli` runs opt-in integration checks against a real DSH runtime and the real CLIs, using local fake model servers.

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
