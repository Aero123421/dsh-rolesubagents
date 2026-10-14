# dsh-rolesubagents

English | [日本語](README.ja.md)

Role-based subagents for DeepSeek Harness (DSH). Define roles such as worker, reviewer, and explorer, each with its own model, child instructions, context (fresh or fork), and read-only mode, from the Plugins page. The parent agent picks a role every time it delegates.

## Features

- **Roles**: edit the id, parent-facing description, child instructions, model, read-only switch, and Agent Preset on the settings page. Each role can be switched on or off.
- **Built-in roles**: `general` (a fresh child, like the official `subagent`) and `fork` (inherits the parent's conversation, like the official `subagent_fork`) cannot be deleted, only switched off.
- **Templates**: `worker`, `explorer`, and `reviewer` ship as templates.
- **Read-only**: pins the child's file sandbox to `read-only`. Neither `bash` nor the file tools can write, and requests for wider access are rejected automatically, even when the parent runs in Full access or Auto review.
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
| Context | Fresh (spawn) or fork (inherits the parent's completed turns, not the current turn) |
| Model | Provider, model, and reasoning effort; empty inherits the parent's route. Not available for fork roles |
| Agent preset | Starts the child with this preset's system prompt and tools; fresh roles only |
| Read-only | Pins the child's file sandbox to `read-only` |

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

- Read-only covers what the DSH file sandbox governs (`bash`, file tools, terminal). External writes by MCP or other plugins' tools are not blocked.
- Out-of-process children (codex, claude-code, acp) are not supported; roles use the spawn and fork providers.
- When a child's conversation is compacted, the role instructions are re-sent as runtime context; the initial task text is replaced by the summary.
- Some Agent Presets suppress optional runtime context (for example `minimal`). The role instructions are still delivered, but the official "delegated subagent" statement is not.

## How it works

- On `agent/created`, the plugin records the session's role list as a `plugin:dsh-rolesubagents/roles` record and registers `delegate` in that Agent's own scope.
- For each child it starts, it reserves the child id, writes a `plugin:dsh-rolesubagents/role` record into the child's log, and, for read-only roles, appends `sandbox/mode: read-only`, all before the child's first request. If pinning read-only fails, the child is not started.
- One global runtime-context provider reads the role from the Agent's Session records, so the instructions survive compaction and resume.

## Development

```sh
pnpm install
pnpm check   # lint, typecheck, test, and committed lib/ matches a fresh build
pnpm build   # lib/index.js (Host) and lib/client.js (Web)
```

`lib/` is committed. After changing sources, run `pnpm build` and commit `lib/` with them.

## License

MIT
