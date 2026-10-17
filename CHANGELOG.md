# Changelog

## Unreleased

- Target DSH `0.2.1-rc.2` in development dependencies and the explicit `engines.dsh` compatibility range; retain the native subagent and workflow runtimes.
- Wait for persisted role state and its writes before releasing an Agent's first turn. Preserve read-only guards on cold resume, roll back incomplete registration, and await storage teardown without reinstalling tools after unload.
- Fix read-only re-pinning on native DSH Sessions by deferring sandbox appends until synchronous event publication finishes. Coalesce queued changes and deny shell calls at the tool guard while the mode is writable.
- Stop rewriting every saved session on domain open and release settled write promises instead of retaining them until shutdown.
- Reject cancelled delegations and providers replaced during model resolution. Fail clearly when a full-history role has a fresh provider or an explicit model cannot be validated. An explicit model's default reasoning effort no longer inherits the parent's effort accidentally.
- Preserve unsaved settings across temporary namespace loss, detect changed Host values even when restart reuses a revision, and keep submitted edits when an accepted ConfigForm write has not yet reached the mirror. Allow repair-only saves and stop disposed controllers from sending requests.
- Add manual provider/model entry alongside catalog selection, independent model and preset refresh/retry, stable inputs during late responses, Japanese repair details, and more flexible narrow-screen layout.
- Preserve native workflow validation and model defaults for cross-realm JSON options, explicit invalid route fields, accessors, and symbols. Fix recursive installed-host module resolution on current Node releases.

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
