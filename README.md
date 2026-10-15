# dsh-rolesubagents

English | [日本語](README.ja.md)

Role-based subagents for DeepSeek Harness (DSH). Define roles such as worker, reviewer, and explorer, each with its own model, child instructions, context (fresh or fork), and read-only mode, from the Plugins page. The parent agent picks a role every time it delegates.

## Features

- **Roles**: edit the id, parent-facing description, child instructions, model, read-only switch, and Agent Preset on the settings page. Each role can be switched on or off.
- **Built-in roles**: `general` (a fresh child, like the official `subagent`) and `fork` (inherits the parent's conversation, like the official `subagent_fork`) cannot be deleted, only switched off.
- **Templates**: `worker`, `explorer`, and `reviewer` ship as templates.
- **Read-only**: pins the child's file sandbox to `read-only` and appends `read-only` again if a later `sandbox/mode` selects a wider mode. While that role is active, write-like tools from MCP and other plugins are refused. Requests for wider sandbox access are still rejected automatically, even when the parent runs in Full access or Auto review.
- **Cache-friendly**: role instructions reach the child as runtime context, not as system prompt. A role that keeps the parent's model and preset leaves the child's system prompt and tool definitions identical to the parent's. Fork roles also keep the inherited conversation cached.
- **Fixed per session**: changes apply to new sessions; a running session keeps the role list it started with.

## Requirements

- DSH `>=0.2.1-alpha.3 <0.3.0-0` (child Agent Preset selection and plugin records)
- The settings page appears on the DSH Web (`dsh web`) Plugins page.

## Install

In DSH Web, open **Plugins → Add plugin** and enter:

```text
github:Aero123421/dsh-rolesubagents
```

From a terminal (`web` profile):

```sh
dsh plugin --profile web add github:Aero123421/dsh-rolesubagents
```

Restart DSH if asked.

## Usage

1. Open `dsh-rolesubagents` on the Plugins page, edit roles, and save.
2. Start a new session. The parent model sees a `delegate` tool whose description lists the enabled roles.
3. The parent calls `delegate({ role: "reviewer", description, prompt })`. Without `role` it starts `general` (`role` is required when `general` is off).

Children run on the official subagent runtime: they start in the background, notify the parent when they finish, and accept follow-ups through `send_message`.

### Role fields

| Field | Meaning |
|---|---|
| ID | The name the parent passes; lowercase letters, digits, `-`, `_`, up to 32 characters |
| Description for the parent | What the role is for and how to brief it; shown in the tool description |
| Instructions for the child | Added to the child's runtime context; never shown to the parent |
| Context | Fresh (spawn) or fork |
| Inherited context | Fork roles only. All completed turns (the default) copies the parent's completed turns, including tool results. Task only starts a fresh child and does not copy that history |
| Model | Provider, model, and reasoning effort; empty inherits the parent's route. Not available for fork roles |
| Agent preset | Starts the child with this preset's system prompt and tools; fresh roles only |
| Read-only | Keeps the file sandbox at `read-only` and refuses write-like MCP and plugin tools. Tools are classified by name; see Limitations |

### Prompt caching

- A role with the parent's model and composition shares the parent's cached system prompt and tool definitions.
- A role with another model or an Agent Preset does not share the parent's cache (children of the same role still share one).
- Fork roles cannot change the model or preset, because that would re-read the whole inherited conversation uncached.

## Official subagent tools

This plugin's tool is named `delegate`, so it never collides with the official `subagent` / `subagent_fork`. To show the model only one delegation tool, turn the official tools off:

- **Compositions that register the official tools globally (for example headless)**: add to the profile's `cordis.patch.yml`:

  ```yaml
  - id: tool-subagent
    disabled: true
  - id: tool-subagent-fork
    disabled: true
  ```

- **DSH Web**: the official tools are part of the Standard preset and cannot be switched off from the Plugins page. Either let both coexist, or create a preset without them in Creator mode.

Keep the official `send_message`, `list_agents`, and `interrupt_agent` tools on.

## Limitations

- A read-only role watches `session/event`. When a later `sandbox/mode` is anything other than `read-only`, the plugin appends `read-only` again. The event is published after the wider mode is already committed, so that mode stays in the log and is followed by `read-only`; the plugin cannot veto it. If a nested writer appends a wider mode again during that append, the plugin retries up to 8 times and then logs a warning, leaving the wider mode last. A rejected append is logged the same way. While that latest mode is not `read-only`, `bash`, `pwsh`, and `run_code` are refused.
- While the role is read-only, a guard on that agent runs before the tool body and refuses write-like tools from MCP and other plugins. Classification uses the public name:
  - DSH's MCP bridge registers tools as `mcp__<server>__<tool>` and does not copy `readOnlyHint` or `destructiveHint`, so those hints are not consulted.
  - A name is split into tokens. A write-like token (`write`, `delete`, `update`, `create`, and others) refuses the call even when a read-like token is also present. A read-like token (`read`, `get`, `list`, `search`, and others) allows it. A name that is neither is refused.
  - A write tool whose name looks like a read (for example a deleter named `get_user`) is allowed. A read tool with a write-like or unrecognized name is refused.
  - Known external writes are refused even when the name does not look like one, including `plugin_manager`, goal and schedule changes, `stagehand_*`, and terminal control (`terminal_open`, `terminal_send`, `terminal_close`, `terminal_signal`).
- `bash`, `pwsh`, and `run_code` stay callable only while the latest sandbox mode is `read-only`. `terminal_read` stays callable. A sandbox backend that does not enforce `read-only` can still let an allowed shell change files; that enforcement belongs to DSH. Network access and process visibility are outside this pin. Nested tool calls from `run_code` re-enter the guard; a program that writes without calling a tool is not stopped.
- Slash commands are not tools. A command that appends `sandbox/mode` is overwritten back to `read-only`. This plugin does not re-assert the child's approval or policy. A one-shot `sandbox_permissions` escalation still depends on DSH denying it for a delegated child.
- A fork set to all completed turns copies that whole prefix, including tool results. The warnings on the settings page, in the tool description, in the tool result, in the host log, and in the child's runtime context do not filter or rewrite that history. Task only uses the fresh-child provider, so the parent log is never copied. An invalid fork scope is stored as task only. A fresh role and a task-only fork refuse a provider that sets `inheritsParentContext` to true. The official fork provider has no smaller slice, and events already copied cannot be removed.
- A read-only agent cannot delegate to a role that is not read-only, or to a fork that copies the parent conversation. It can delegate to a read-only fresh role or a task-only fork.
- Out-of-process children (codex, claude-code, acp) are not supported; roles use the spawn and fork providers.
- When a child's conversation is compacted, the role instructions are re-sent as runtime context; the initial task text is replaced by the summary.
- Some Agent Presets suppress optional runtime context (for example `minimal`). The role instructions are still delivered, but the official "delegated subagent" statement is not.

## How it works

- On `agent/created`, the plugin records the session's role list as a `plugin:dsh-rolesubagents/roles` record and registers `delegate` in that Agent's own scope.
- For each child it starts, it reserves the child id, writes a `plugin:dsh-rolesubagents/role` record into the child's log, and, for read-only roles, appends `sandbox/mode: read-only` before the child's first request. If that first pin fails, the child is not started. Afterwards, `session/event` re-appends `read-only` whenever the mode changes, including after resume when the stored mode is no longer `read-only`. The read-only agent also receives a `tools.guard` that refuses write-like calls.
- A fork role set to task only is started on the spawn provider. A fork that inherits history is started on the fork provider, and the host logs that inherited tool results can carry prompt injection.
- One global runtime-context provider reads the role from the Agent's Session records, so the instructions survive compaction and resume. A full-history fork also receives a warning to treat that history as untrusted.

## Development

```sh
pnpm install
pnpm check   # lint, typecheck, test, and committed lib/ matches a fresh build
pnpm build   # lib/index.js (Host) and lib/client.js (Web)
```

`lib/` is committed. After changing sources, run `pnpm build` and commit `lib/` with them.

## License

MIT
