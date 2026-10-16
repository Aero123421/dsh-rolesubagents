# Changelog

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
