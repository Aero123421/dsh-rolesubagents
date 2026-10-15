# dsh-rolesubagents

English | [日本語](README.ja.md)

Role-based subagents for DeepSeek Harness (DSH). Define roles such as worker, reviewer, and explorer, each with its own model, child instructions, context (fresh or fork), and read-only mode, from the Plugins page. The parent agent picks a role every time it delegates.

## Features

- **Roles**: edit the id, parent-facing description, child instructions, model, read-only switch, and Agent Preset on the settings page. Each role can be switched on or off.
- **Built-in roles**: `general` (a fresh child, like the official `subagent`) and `fork` (inherits the parent's conversation, like the official `subagent_fork`) cannot be deleted, only switched off.
- **Templates**: `worker`, `explorer`, and `reviewer` ship as templates.
- **Read-only**: pins the child's file sandbox to `read-only` and appends `read-only` again if a later `sandbox/mode` selects a wider mode. While that role is active, only a fixed list of inherited read-only tools can run, and only while the mode is still `read-only`. If the pin cannot be restored, every tool is refused. Requests for wider sandbox access are still rejected automatically, even when the parent runs in Full access or Auto review.
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

Children run on the official subagent runtime: they start in the background, notify the parent when they finish, and accept follow-ups through `send_message`. A read-only agent may send that message, or interrupt, only to a read-only destination.

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
| Read-only | Keeps the file sandbox at `read-only` and allows only known inherited read-only tools while that mode holds. See Limitations |

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

Keep the official `send_message`, `list_agents`, and `interrupt_agent` tools on. While an agent is read-only, `send_message` and `interrupt_agent` are allowed only when the destination is a read-only agent. A missing, unknown, or writable destination is refused, including a parent that can write.

## Limitations

- A read-only role watches `session/event`. When a later `sandbox/mode` is anything other than `read-only`, the plugin appends `read-only` again. The event is published after the wider mode is already committed, so that mode stays in the log; the plugin cannot veto the event. DSH also rejects an append made from inside that notification, so the re-pin runs as soon as the notification returns. Until `read-only` is the latest mode, the guard refuses every tool, including `bash` and `run_code`. If a nested writer appends a wider mode again during that append, the plugin retries up to 8 times. If the mode is still not `read-only`, or the append is rejected, the plugin logs a warning and refuses every tool on that session from then on, even if a later event says `read-only`. A failed pin while the agent is starting, including resume, aborts that startup.
- While the role is read-only, a guard on that agent runs before the tool body. A call is allowed only when all of the following hold:
  - The latest sandbox mode is `read-only`, and no re-pin for that session has failed.
  - The tool object is the one inherited from the host or an ancestor agent. A same-named tool registered in a nearer scope is refused. `run_code` has no registration (it is reserved) and is allowed only while the checks above hold. A different plugin that replaces the single global tool of an allowlisted name cannot be told apart from the host tool.
  - The name is on a fixed allowlist (`bash`, `pwsh`, `read`, `read_image`, `glob`, `grep`, `lsp`, `web_search`, `web_fetch`, the MCP resource reads, a few session and job queries, `ask_user_question`, `skill`, `terminal_list`, `terminal_read`, `run_code`, and the other names in `ALLOWED_TOOLS`). `query` and `fetch` are not permission to invent a name, so `postgres_query`, `mcp__db__query`, and `http_fetch` are refused. A name that also contains a write-like token (`merge`, `destroy`, `write`, and others) is refused.
  - `send_message` and `interrupt_agent` are allowed only when `agent_id` is a read-only agent this plugin can see. Any other destination is refused.
  - `delegate` is allowed only to a read-only role that does not copy the parent conversation.
  - DSH's MCP bridge registers tools as `mcp__<server>__<tool>` and does not copy `readOnlyHint` or `destructiveHint`, so those hints are not consulted.
- `bash`, `pwsh`, `terminal_read`, and `run_code` are callable only while the mode is actually `read-only` and the pin has not failed. Whether a shell command can change files still depends on the sandbox backend. Network access, process visibility, and a backend that does not enforce `read-only` are outside this pin. Nested tool calls from `run_code` re-enter the guard; a program that writes without calling a tool is not stopped.
- Slash commands are not tools. A command that appends `sandbox/mode` is overwritten back to `read-only` when the re-pin succeeds. This plugin does not re-assert the child's approval or policy. A one-shot `sandbox_permissions` escalation still depends on DSH denying it for a delegated child.
- A fork set to all completed turns copies that whole prefix, including tool results. The warnings on the settings page, in the tool description, in the tool result, in the host log, and in the child's runtime context do not filter or rewrite that history. Task only refuses a provider that does not set `inheritsParentContext` to false, and aborts the child if a parent turn is already in the child log. The official fork provider has no smaller slice, and events already copied cannot be removed. An invalid fork scope switches that role off and treats it as task only, so it does not inherit history.
- A delegated child whose role this plugin cannot determine is pinned read-only and receives the same guard. The role recorded for a child this plugin started is applied whichever `agent/created` source arrives, including a source other than `startup` and a notification that arrives after activation returns.
- A read-only agent cannot delegate to a role that is not read-only, or to a fork that copies the parent conversation. It can delegate to a read-only fresh role or a task-only fork.
- Out-of-process children (codex, claude-code, acp) are not supported; roles use the spawn and fork providers.
- When a child's conversation is compacted, the role instructions are re-sent as runtime context; the initial task text is replaced by the summary.
- Some Agent Presets suppress optional runtime context (for example `minimal`). The role instructions are still delivered, but the official "delegated subagent" statement is not.

## How it works

- On `agent/created`, the plugin records the session's role list as a `plugin:dsh-rolesubagents/roles` record and registers `delegate` in that Agent's own scope.
- For each child it starts, it reserves the child id and keeps that reservation until `agent/created` names the same id, whatever the event's source is and even when the event arrives after activation returns. It then writes a `plugin:dsh-rolesubagents/role` record into the child's log and, for read-only roles, appends `sandbox/mode: read-only` before the child's first request. If that pin fails, the child is not started. Afterwards, `session/event` re-appends `read-only` once that notification returns, including after resume when the stored mode is no longer `read-only`. A failed re-pin refuses every tool. The guard re-reads the live mode on every call, so the interval before the re-pin lands is closed too. A delegated child with no reservation and no role record is pinned read-only.
- A fork role set to task only is started only when the provider declares that it does not copy the parent conversation, and the child is aborted if a parent turn is already in its log. A fork that inherits history is started on the fork provider, and the host logs that inherited tool results can carry prompt injection. An invalid scope switches the role off.
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
