# Changelog

## 0.1.1

- Read-only roles re-pin `sandbox/mode` to `read-only` when a later change selects a wider mode. A failed re-pin refuses every tool, and a failed pin on startup or resume aborts that startup.
- Read-only agents allow only a fixed list of inherited host tools, and only while the live mode is `read-only`. `query` or `fetch` in a name is not enough. `send_message` and `interrupt_agent` reach only a read-only destination. The README lists what that guard cannot see.
- A child started by `delegate` receives its role whichever `agent/created` source arrives. A delegated child with no role is pinned read-only.
- Fork roles warn that inherited tool results can carry prompt injection. Task only refuses a provider that copies the parent conversation. An invalid fork scope switches that role off.

## 0.1.0

- Role-based `delegate` tool with per-session role lists, built-in `general` and `fork` roles, and `worker`, `explorer`, `reviewer` templates.
- Per-role model, child instructions (runtime context), fresh or fork context, read-only sandbox pin, and Agent Preset.
- Role editor on the DSH Web Plugins page (English and Japanese).
