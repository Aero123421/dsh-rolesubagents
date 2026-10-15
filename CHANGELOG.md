# Changelog

## 0.1.1

- Read-only roles re-pin `sandbox/mode` to `read-only` when a later change selects a wider mode. A failed re-pin refuses every tool, and a failed pin on startup or resume aborts that startup.
- Read-only agents allow only a fixed list of inherited host tools, and only while the live mode is `read-only`. `query` or `fetch` in a name is not enough. `send_message` and `interrupt_agent` reach only a read-only destination. The README lists what that guard cannot see.
- A child started by `delegate` receives its role whichever `agent/created` source arrives. Official subagents, teams, and other plugins' children are not pinned. While activation is in flight, a same-parent child that is not yet bound is refused every tool, and its sandbox is left unchanged. When the call returns, the reservation and the returned id are bound and a read-only role is pinned only then. A child that matches neither is released and is not stopped. DSH does not identify which plugin started the child, so a same-parent official subagent cannot call tools during that one call; after the call it can write again. A returned id that matches neither an agent nor a session stops that activation. A reservation stays until `agent/created` consumes it, activation fails, the child or parent is disposed, or the plugin unloads. A failed pin is cleared when the agent is disposed or the plugin unloads.
- `send_message` and `interrupt_agent` require every destination field to name a live read-only session. Destination keys are separate from message text, notes, and trace metadata. An unknown id in a destination field is refused. A session the sessions service still lists is accepted. `delegate` must be the registration this plugin installed. A guard that cannot read its own session log refuses the call.
- Fork roles warn that inherited tool results can carry prompt injection. Task only refuses a provider that copies the parent conversation, including a `prepareContinuable` seed that contains parent speech (turns, messages, tool exchanges, compaction summaries). Other event types are not parent history. The child is stopped when that speech is found after start. An invalid fork scope switches that role off.
- `bash`, `pwsh`, `run_code`, `web_fetch`, and `terminal_read` stay allowlisted only while the sandbox mode is `read-only`.

## 0.1.0

- Role-based `delegate` tool with per-session role lists, built-in `general` and `fork` roles, and `worker`, `explorer`, `reviewer` templates.
- Per-role model, child instructions (runtime context), fresh or fork context, read-only sandbox pin, and Agent Preset.
- Role editor on the DSH Web Plugins page (English and Japanese).
