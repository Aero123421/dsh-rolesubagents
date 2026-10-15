# Changelog

## 0.1.1

- Read-only roles re-pin `sandbox/mode` to `read-only` when a later change selects a wider mode. A failed re-pin refuses every tool, and a failed pin on startup or resume aborts that startup.
- Read-only agents allow only a fixed list of inherited host tools, and only while the live mode is `read-only`. `query` or `fetch` in a name is not enough. `send_message` and `interrupt_agent` reach only a read-only destination. The README lists what that guard cannot see.
- A child started by `delegate` receives its role whichever `agent/created` source arrives. Official subagents, teams, and other plugins' children are not pinned. While activation is in flight, a same-parent child that is not yet bound is refused every tool, and its sandbox is left unchanged. When the call returns, the reservation and the returned id are bound and a read-only role is pinned only then. A child that matches neither is released and is not stopped. DSH does not identify which plugin started the child, so a same-parent official subagent cannot call tools during that one call; after the call it can write again. A returned id that matches neither an agent nor a session stops that activation. A reservation stays until `agent/created` consumes it, activation fails, the child or parent is disposed, or the plugin unloads. A failed pin is cleared when the agent is disposed or the plugin unloads.
- `send_message` and `interrupt_agent` scan every argument key except message text, notes, prompts, and trace fields. A known id found there, including under `metadata`, `id`, `agents`, or `subagent_id`, has to be a live read-only session. An unknown id is refused only in a destination key. A session the sessions service still lists is accepted. `delegate` must be the registration this plugin installed. A guard that cannot read its own session log refuses the call.
- Fork roles warn that inherited tool results can carry prompt injection. Task only allows events a fresh child writes itself. Parent content from DSH 0.2.1-alpha.3, including inbox splices, team messages, and feedback notes, is refused, and so is an unrecognized event type. The child is stopped when that history is found after start. An invalid fork scope switches that role off.
- `bash`, `pwsh`, `run_code`, `web_fetch`, and `terminal_read` stay allowlisted only while the sandbox mode is `read-only`.

## 0.1.0

- Role-based `delegate` tool with per-session role lists, built-in `general` and `fork` roles, and `worker`, `explorer`, `reviewer` templates.
- Per-role model, child instructions (runtime context), fresh or fork context, read-only sandbox pin, and Agent Preset.
- Role editor on the DSH Web Plugins page (English and Japanese).
