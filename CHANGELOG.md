# Changelog

## 0.1.1

- Read-only roles re-pin `sandbox/mode` to `read-only` when a later change selects a wider mode.
- Read-only agents refuse write-like MCP and plugin tools by public name. The README lists what that guard cannot see.
- Fork roles warn that inherited tool results can carry prompt injection, and can pass only the task instead of the parent conversation.

## 0.1.0

- Role-based `delegate` tool with per-session role lists, built-in `general` and `fork` roles, and `worker`, `explorer`, `reviewer` templates.
- Per-role model, child instructions (runtime context), fresh or fork context, read-only sandbox pin, and Agent Preset.
- Role editor on the DSH Web Plugins page (English and Japanese).
