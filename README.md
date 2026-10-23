# dsh-rolesubagents

English | [日本語](README.ja.md)

Role-based subagents for DeepSeek Harness (DSH). Define roles such as worker, reviewer, and explorer, each with its own model, child instructions, context (fresh or fork), and read-only mode, from the Plugins page. The parent agent picks a role every time it delegates.

A role can also run its child on a coding-agent CLI installed on the DSH host instead of inside DSH: **Codex CLI**, **Claude Code**, **Antigravity CLI** (`agy`), **OpenCode**, **Grok Build** (`grok`), or **Pi** (`pi`). The parent uses the same `delegate` tool either way.

## Features

- **Roles**: edit the id, parent-facing description, child instructions, model, read-only switch, and Agent Preset on the settings page. Each role can be switched on or off.
- **Built-in roles**: `general` (a fresh child, like the official `subagent`) and `fork` (inherits the parent's conversation, like the official `subagent_fork`) cannot be deleted, only switched off.
- **Templates**: `worker`, `explorer`, and `reviewer` ship as templates.
- **Read-only**: pins the child's file sandbox to `read-only` and appends `read-only` again if a later `sandbox/mode` selects a wider mode. While that role is active, write-like tools from MCP and other plugins are refused. Requests for wider sandbox access are still rejected automatically, even when the parent runs in Full access or Auto review.
- **Cache-friendly**: role instructions reach the child as runtime context, not as system prompt. Matching models/compositions retain their usual cache behavior. Parent-only management tools and explicit role-catalog refreshes can change the tool prefix; see [Prompt caching](#prompt-caching).
- **External CLI runners**: set a role's **Runs on** to Codex, Claude Code, Antigravity, OpenCode, Grok Build, or Pi and its child runs once as that CLI on the host, with the CLI's own model, reasoning effort, and permission preset. The preset never exceeds what the parent session may do. See [External CLI runners](#external-cli-runners).
- **Optional AI role administration**: enable **Allow AI role management** (OFF by default) to let eligible parent sessions inspect models/capabilities and preview/apply role changes through `manage_roles`. This grants role-configuration administration for this Host/profile, not child execution or CLI installation/authentication control. Children do not inherit it. See [AI role management](#ai-role-management).
- **Snapshots with explicit refresh**: UI saves affect new root conversations; existing sessions, and children/forks inheriting their catalog, retain their snapshot. An authorized parent's explicit `manage_roles` `apply_current` updates only its own future delegation catalog, never existing children or other sessions. **External CLIs** settings (executable path, forwarded variables) are still read at each delegation.

## Requirements

- DSH `>=0.2.1-alpha.3 <0.3.0-0` (child Agent Preset selection and the storage-domain service)
- The settings page appears on the DSH Web (`dsh web`) Plugins page.
- 日本語の表示には dsh-japanese が必要です（[dsh-japanese](https://github.com/Aero123421/dsh-japanese)）。This plugin does not register the `ja` language. With that pack installed and Japanese selected, the page uses its own Japanese dictionary. Without the pack, and when DSH is set to 中文 (`zh-CN`), the page stays in English and does not show raw message keys.
- CLI roles also need the CLI installed on the DSH host (see [External CLI runners](#external-cli-runners)) and a Host that offers plugins its subprocess service and subagent provider registration. Without them, CLI roles are refused with a message and DSH roles keep working.
- Optional AI role management additionally needs the Host's canonical `settings.describe` / revision-fenced `settings.mutate` service and the standard unique `rolesubagents` settings entry. Missing/ambiguous/rebound service ownership refuses management without breaking ordinary delegation; this is not a promise that every version in the base DSH range offers the optional feature.

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
2. Start a new root conversation. The parent model sees a `delegate` tool whose description lists the enabled roles. A fork/child of an existing conversation can inherit its older role snapshot.
3. The parent calls `delegate({ role: "reviewer", description, prompt })`. Without `role` it starts `general` (`role` is required when `general` is off).

Children run on the official subagent runtime: they start in the background, notify the parent when they finish, and accept follow-ups through `send_message`. A child of a CLI role also starts in the background and notifies the parent, but it runs once and does not accept `send_message`.

### AI role management

The separate **Allow AI role management** switch is **OFF by default** and saves immediately, independently of the role Save button and master Subagents switch. It grants eligible parent sessions administration of this Host/profile's role definitions; ordinary workspace-write parents can manage workspace-limited roles. Children do not inherit this tool, and an existing captured tool must still pass live caller/permission checks. A human-created fork is not classified as a child merely because it has a parent-session link.

`manage_roles` offers `list`, `get`, `capabilities`, `models`, `preview`, `apply`, and `apply_current`. Create/update/delete are bounded changes inside a preview; inspect the diff and apply its returned plan ID. Saves use the same revision-fenced Host writer as the settings page, never direct profile-file edits. A conflict requires a fresh read/preview, not an automatic overwrite. The tool cannot change its own permission, the master switch, CLI executables/environment/authentication, workflow model, or provider routes. CLI permission increases above the caller's ceiling and arbitrary Agent Preset selection are refused.

Saving and using a role are separate: **create preview → apply → list again → apply_current → next model/tool step → delegate**. Do not run apply/refresh and delegate in parallel or expect a previously bound workflow program to gain new role IDs. Existing children, admitted delegations and other conversations remain unchanged. Saving global settings, refreshing the current catalog, persisting its Session snapshot and recording audit metadata are separate outcomes.

Whole-catalog saves support **literal JSON role settings only**. The UI requires the Host's read-only `rolesubagentsManagement/writeSafety` check at the same revision—even when AI management is OFF. Executable `!!js`/`__jsExpr` role bindings (including inherited/opaque fields) are refused instead of replacing them with resolved values; edit such profiles natively. Management writes also require a resolvable caller sandbox policy. OFF remains available during a pending UI safety check; already-admitted Host profile writes cannot be retroactively canceled.

Model candidates carry provenance, timestamps and partial/unknown status; listing them does not verify authentication or availability. Management does not launch CLI processes, inference, login, installation or updates. See [the operation contract, examples and limits](<docs/role-management.md>).

### Role fields

| Field | Meaning |
|---|---|
| ID | The name the parent passes; lowercase letters, digits, `-`, `_`, up to 32 characters |
| Runs on | DSH (built-in child, the default) or one of the external CLIs. A CLI replaces Context, Inherited context, Model, and Agent preset with its own fields; see [External CLI runners](#external-cli-runners). Built-in roles always run on DSH |
| Description for the parent | What the role is for and how to brief it; shown in the tool description |
| Instructions for the child | Added to the child's runtime context, not the `delegate` role list; authorized `manage_roles get` can inspect the saved instructions |
| Context | Fresh (spawn) or fork |
| Inherited context | Fork roles only. All completed turns (the default) copies the parent's completed turns, including tool results. Task only starts a fresh child and does not copy that history |
| Model | Provider, model, and reasoning effort; empty inherits the parent's route. Not available for fork roles |
| Agent preset | Starts the child with this preset's system prompt and tools; fresh roles only |
| Read-only | Keeps the file sandbox at `read-only` and refuses write-like MCP and plugin tools. Tools are classified by name; see Limitations |

### Workflow default model

The Plugins page has a separate **Workflow model** provider/model setting. It changes only the default LLM route for children started by the official `workflow` tool's `agent()` helper; it does not select a role or add role instructions, an Agent Preset, reasoning effort, or read-only restrictions.

| Workflow `agent()` route | Workflow model setting | Result |
|---|---|---|
| Explicit `provider` and/or `model` | Set or empty | Native workflow override handling; the configured default is not injected |
| Neither field specified | Set | Configured provider and model |
| Neither field specified | Empty | Native parent model inheritance |

For example, `await agent("Investigate the tests")` uses the configured workflow model, while `await agent("Review", { provider: "other", model: "other-model" })` overrides it. Specifying only one route field also bypasses the configured pair, retaining DSH's normal inheritance for the other field. Clear the provider selection to remove the default. The master Subagents switch disables this default as well. Changes apply to new root conversations; existing sessions and their inherited children/forks retain their recorded setting, including after resume. `apply_current` refreshes roles only and does not change this workflow model.

The original workflow tool still owns execution, schemas, limits, cancellation, foreground results, and background jobs. A preset without `workflow` does not gain the tool. This integration adapts the script's lexical `agent()` helper; direct calls to the workflow engine or access through `globalThis.agent` are not adapted. It is a convenience default, not a model-enforcement policy. Script wrapping can shift diagnostic line numbers. Standard preset and global/headless workflow tools are supported. If another plugin registers `workflow` directly in the same agent-local layer, DSH forbids replacing that registration: the plugin logs a warning and leaves that tool unchanged. External tool changes invalidate adapters lazily; each agent refreshes before its next prompt or workflow execution, and captured adapters refuse to execute a removed/restricted workflow.

### Prompt caching

- A role with the parent's model and composition normally shares the parent's cached system prompt and tool definitions when the visible tools match.
- Enabling parent-only `manage_roles` deliberately makes the parent/child tool sets differ. Explicit `apply_current` also replaces the caller's `delegate` definition; identical tool-prefix/cache reuse is not promised across these changes.
- A role with another model or an Agent Preset does not share the parent's cache (children of the same role still share one).
- Fork roles cannot change the model or preset, because that would re-read the whole inherited conversation uncached.

## External CLI runners

A role whose **Runs on** is a CLI runs its child once as a separate program on the DSH host. The parent still calls `delegate`; the tool description marks such roles as `(runs once in <CLI>[, read-only]; cannot receive send_message)`, and the result reads `started <CLI> subagent <id>`. When the CLI finishes, the parent receives the usual completion notice carrying the CLI's final answer.

### Requirements

- Install the CLI on the DSH host and authenticate as the same OS user that runs DSH (or forward its API-key variable, see [External CLIs](#external-clis-settings)). Grok/Pi workspace-write supports forwarded API keys or configured static keys, not browser/OAuth sign-ins; those require explicit `native` under a full-access parent.
- Grok/Pi workspace-write additionally requires the Host’s existing `ctx.sandbox.confine` service. DSH `0.2.1-rc.2` standard profile provides it; older/unavailable or failed providers cause a clear refusal before any unconfined CLI launch. Linux is tested; other operating systems are not certified.
- Compatibility is evidence-scoped, not a semver promise. Historical documentation names Codex `0.163.0`, Claude Code `2.1.303`, Antigravity `1.4.2`, and OpenCode `1.19.3`, but does not record a complete dated environment/preset/suite matrix. A version probe alone is not validation. See [compatibility evidence and comparison](docs/cli-compatibility.md) for the exact conditions required for a tested result; unknown/missing/failed/skipped checks must not be treated as success.

### Setting up a role

1. Open the role on the Plugins page and choose a CLI under **Runs on**.
2. Fill in the CLI fields that appear in place of Context, Inherited context, Model, and Agent preset:

   | Field | Meaning |
   |---|---|
   | Provider | OpenCode only. Required together with Model |
   | Model | The CLI's own model ID. Empty uses the CLI's configured default (not allowed for OpenCode). Suggestions come from **Test connection** or a built-in list; any ID the CLI accepts works if it uses only letters, digits, and `. _ : @ / + - [ ]` (not starting with `-`; the same applies to Provider and Reasoning effort) |
   | Reasoning effort | **Model default** or one of the CLI's effort levels. For OpenCode, a variant name of the model (free text) |
   | Permission | One of the CLI's permission presets (below). A delegated run never stops to ask for approval, so this decides what it may do |
   | Timeout (minutes) | The run is stopped after this long; 1–1440, empty for 30 |

3. **Read-only** permits only a verified read-only preset (see [Read-only](#read-only-on-a-cli)). Grok Build and Pi have no supported read-only preset: this combination is rejected in the editor and a stored incompatible role is switched off during normalization.
4. Save, then start a new root conversation (or explicitly refresh the eligible current parent through `manage_roles apply_current`).

For Grok/Pi in an ordinary workspace-write session, select **Workspace write** (the new default). A saved explicit `native` selection stays native and is refused under a restricted parent; change it explicitly rather than expecting silent lowering.

Switching a role to a CLI drops its fork context, DSH model, and Agent preset; switching back to DSH drops the CLI fields.

### Per-CLI details

Every run gets the task text through the CLI's input, and the role's instructions (with `Your role: <id>.` and a note that the run is one-shot) through the channel listed below. Inherited variables that make a CLI think it runs inside another agent (`CLAUDECODE`, `CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`) are removed.

#### Codex CLI (`codex`)

| | |
|---|---|
| How it is driven | `codex exec --json --ephemeral --skip-git-repo-check --color never --disable plugins --disable multi_agent -c analytics.enabled=false -c notify=[] -c shell_environment_policy.ignore_default_excludes=false -c sandbox_workspace_write.writable_roots=[] -C <cwd> -s <preset> [-m <model>] [-c model_reasoning_effort=…] [-c developer_instructions=…] -`, task on stdin. No session file is kept |
| Presets | **Read-only** → `-s read-only`; **Workspace write** (default) → `-s workspace-write`; **Full access (no sandbox)** → `-s danger-full-access`. Enforced by Codex's sandbox, shell commands included. `-s` is always passed and extra writable roots from a Codex config are cleared, so neither your config nor a project's `.codex/config.toml` can widen it |
| Instructions | `developer_instructions` (a developer message next to Codex's own prompt) |
| Credentials | `codex login` on the host, or forward `CODEX_API_KEY` (Codex's built-in provider ignores a plain `OPENAI_API_KEY`), or a custom provider from your Codex config with its key variable forwarded. Codex's shell tools do not see variables whose names contain `KEY`, `SECRET`, or `TOKEN` |
| Model and effort | Your Codex config (model, providers) still applies when Model is empty. Efforts: none, minimal, low, medium, high, xhigh, max |
| Connection test | Version, sign-in from `codex login status` (a forwarded `CODEX_API_KEY` counts as signed in; when other variables are forwarded, for example a custom provider's key, a "not signed in" answer is shown as unknown because `login status` only knows the built-in OpenAI login), and models from `codex debug models` |

#### Claude Code (`claude`)

| | |
|---|---|
| How it is driven | `claude -p --output-format stream-json --verbose --no-session-persistence [--model <model>] [--effort <effort>] <preset flags> [--append-system-prompt <instructions>]`, task on stdin. No session is saved. Legacy presets additionally pass `--strict-mcp-config`; the explicit native preset does not |
| Presets | **Read-only** → `--permission-mode dontAsk --setting-sources "" --tools Read,Glob,Grep,WebFetch,WebSearch --disallowedTools Write,Edit,NotebookEdit`; **Edit files (no shell)** (default, `acceptEdits`) → `--permission-mode acceptEdits --setting-sources "" --tools Read,Glob,Grep,WebFetch,WebSearch,Edit,Write,NotebookEdit`; **Native accept-edits** (`nativeAcceptEdits`, full-access parent required) → `--permission-mode acceptEdits`, with native tools, settings, MCP and hooks intact; **Auto (classifier)** (full access) → `--permission-mode auto` (the classifier makes extra model calls and can approve any command); **Bypass permissions** (full access) → `--permission-mode bypassPermissions`. Read-only and Edit files have no shell and load no settings files (see [Read-only](#read-only-on-a-cli) and [Workspace confinement](#workspace-confinement)) |
| Instructions | `--append-system-prompt` (appended to Claude Code's system prompt) |
| Environment | Sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` and `DISABLE_AUTOUPDATER=1`; removes `CLAUDECODE`. Legacy presets also remove inherited `CLAUDE_CODE_*` variables unless forwarded by name; `nativeAcceptEdits` keeps them (the adapter's own fixed environment values still apply) |
| Credentials | Claude Code's own sign-in on the host. `ANTHROPIC_API_KEY` is never passed automatically (in print mode it would override a subscription sign-in); forward it by name if you want key authentication. Read-only and Edit files do not load settings files, so an `apiKeyHelper`, model, or `env` set there applies only to the full-access presets |
| Model and effort | A model alias or full model ID; empty uses Claude Code's default. Efforts: low, medium, high, xhigh, max |
| Connection test | Version and a built-in model list. Sign-in state shows as unknown (Claude Code has no side-effect-free check); the first run reports a sign-in problem |

**Native editing and Python venvs:** choose `nativeAcceptEdits` explicitly when native Claude settings/tools are intended. It skips the recursive workspace-link preflight, so an ordinary `.venv` with interpreter symlinks need not be deleted. This is not a confined workspace-write mode: native hooks/extensions can act as the Host user, so the parent must already be full access. It uses `acceptEdits`, never an automatic switch to `bypassPermissions`; the existing restricted default remains unchanged.

#### Antigravity CLI (`agy`)

| | |
|---|---|
| How it is driven | `agy --input-format stream-json --output-format stream-json --disable-slash-commands [--model <model>] [--effort <effort>] [--agent dsh-rolesubagents-<nonce> [--mode accept-edits]] [--dangerously-skip-permissions] --log-file <private temp dir>/agy.log`, one stream-json user message on stdin, `AGY_CLI_DISABLE_AUTO_UPDATE=true`. Before the run, `agy --output-format json models` checks the sign-in (about 0.5 s instead of waiting for a sign-in code) |
| Presets | **Read-only** → a generated agent with only `view_file`, `grep_search`, `list_dir`, `find_by_name`; **Edit files (no shell)** (default) → the same plus `write_to_file` and `replace_file_content`, with `--mode accept-edits` (without it headless agy refuses writes outside the temp directory); writes outside the run's directory stay refused; **Full access** → agy's default agent with `--dangerously-skip-permissions` |
| Instructions | Read-only and Edit files: the body (system prompt) of the generated agent `~/.gemini/config/agents/dsh-rolesubagents-<nonce>.md`, which is removed after the run (leftovers older than 24 hours are removed at plugin start). Full access: prefixed to the task under `# Role instructions` / `# Task`, because a custom agent would lose agy's default tools and prompt |
| Credentials | agy's own Google sign-in, or forward `GEMINI_API_KEY` together with `"modelProvider": "gemini"` in agy's `settings.json` |
| Model and effort | Efforts: low, medium, high, xhigh, max. Each model supports only some of them; agy rejects an unsupported combination at start (reported as a configuration failure) |
| Connection test | Version, sign-in state, and the model list (effort-suffixed models are grouped into a model plus its efforts) |

#### OpenCode (`opencode`)

| | |
|---|---|
| How it is driven | `opencode acp --cwd <cwd> --print-logs --log-level WARN`, driven over the Agent Client Protocol (JSON-RPC on stdin/stdout). The run's settings come from `OPENCODE_CONFIG_CONTENT`, merged over your OpenCode config without writing any file (below full access the project's own `opencode.json`, `.opencode` agents, commands and tools, and `AGENTS.md` are not loaded: `OPENCODE_DISABLE_PROJECT_CONFIG=1`): the model, a uniquely named agent `dsh-<nonce>` carrying the preset, and auto-update, sharing, snapshots, and title generation off. `OPENCODE_DB=:memory:` (no session is saved), and the local server OpenCode opens gets a random password |
| Presets | **Read-only** → every tool denied except read (not `.env` files), grep, glob, list, lsp, todowrite; **Edit files (no shell)** (default) → the same plus file edits, with shell, directories outside the workspace, and questions denied. OpenCode's file tools reach the whole git repository around the run's directory, so Edit files is refused below a repository's top-level (see [Workspace confinement](#workspace-confinement)); **Full access** → everything allowed except directories outside the workspace, questions, and plan-mode switches (`.env` files stay unreadable) |
| Instructions | An extra `instructions` file in a private temp directory (part of the system prompt, after `AGENTS.md`) |
| Credentials | OpenCode's own provider sign-in (`opencode auth login`), or forward the provider's key variable (for example `OPENAI_API_KEY`) |
| Model and effort | **Provider and Model are both required**; a role without them is switched off instead of falling back to OpenCode's own default model. Effort is a variant name of the model (for example `high`). Permission prompts are always answered with "reject"; a turn that ends without an answer after a rejection is reported as a permission failure |
| Connection test | Version and the model list with each model's variants. Sign-in state shows as unknown |

#### Grok Build (`grok`)

| | |
|---|---|
| How it is driven | `grok --output-format streaming-json --cwd <cwd> --prompt-file <private task file> [--model <model>] [--reasoning-effort <effort>] [--rules <instructions>]`; task file removed after the run |
| Presets | **Workspace write** (default, `workspace-write`): mandatory DSH Host file sandbox, with private state (below); adds `--permission-mode acceptEdits --allow Write --allow Edit --allow Bash` because headless Grok otherwise cancels tool writes. These flags are not the security boundary. **Native harness** (`native`): native tools/settings/auth/extensions unchanged; requires a full-access parent. Read-only is unsupported |
| Instructions | `--rules`, appended to the native instructions |
| Model and credentials | Optionally select a model/effort. Workspace write uses a private settings snapshot and static/forwarded API keys; browser sign-ins require native. Native keeps Grok configuration/authentication. `GROK_DISABLE_AUTOUPDATER=1` prevents adapter-triggered updater activity |
| Connection test | Version only. Authentication and model catalog remain unknown |

Grok **does provide** official OS sandbox profiles (`--sandbox read-only` / `--sandbox workspace`). The new workspace-write path instead wraps Grok independently with DSH's existing sandbox; it does not rely on Grok native `--sandbox` flags. The [upstream review](docs/grok-sandbox-upstream-review.md) and [real-binary investigation](docs/grok-sandbox-investigation.md) remain historical evidence: Bubblewrap was unavailable here and managed `off` overrode a requested native profile. Explicit `native` still neither selects/verifies those profiles nor forces them off.

#### Pi (`pi`)

| | |
|---|---|
| How it is driven | `pi --mode rpc --no-session [--model <provider/model>] [--thinking <effort>] [--append-system-prompt <private instructions file>]`; task sent as an RPC prompt on stdin |
| Presets | **Workspace write** (default, `workspace-write`): mandatory DSH Host file sandbox and private state (below), with the same RPC protocol. **Native harness** (`native`): keeps native configuration/authentication/tools/extensions; requires a full-access parent. Read-only is unsupported |
| Completion and cancellation | Waits for `agent_settled`, not merely `agent_end`, and returns the final assistant message. Cancellation requests `clear_queue`, waits for its acknowledgment, requests `abort`, then closes stdin after acknowledgment (with engine termination fallback). Interactive extension requests are canceled, never automatically approved |
| Model and credentials | Optionally select `provider/model` and thinking level. Workspace write snapshots settings/models and only static `api_key` auth entries; forwarded API keys also work. Browser/OAuth sign-ins require native. No persistent session is requested; `PI_SKIP_VERSION_CHECK=1` is set |
| Connection test | Version only. Pi 1.3.0's help/model-list commands can initialize extensions, so they are not used as supposedly side-effect-free discovery |

**Grok/Pi private state:** a private Node bootstrap runs **inside** the DSH sandbox and prepares model/settings snapshots and Pi's static `api_key`-only auth under a private `${RUN_DIR}` in `/tmp`. Source configs/auth remain unchanged; browser/OAuth stores are not copied or rotated. Global resource trees are not recursively copied and relative resources have a changed base, so this is not full native configuration parity. Project or explicitly configured executable resources that load run within the same OS file boundary. Native retains its original configuration, hooks and extensions without this wrapper; their own side effects remain possible.

### Access ceiling

The plugin decides the preset before startup. Most adapters use the CLI's own permissions; Grok/Pi workspace-write additionally wraps the process with DSH's existing file sandbox:

- The ceiling is **read-only** when the calling agent's role is read-only. Otherwise it follows the parent session's sandbox mode: `read-only` → read-only, `danger-full-access` → full access, anything else (including approval modes such as Auto review, or no sandbox service) → workspace write.
- A legacy preset above the ceiling is lowered only when a verified preset exists for that level (and logged). Missing mappings refuse the run. An explicit native preset above the ceiling is refused, not silently changed to a different restricted harness. The parent is never promoted and the plugin does not automatically enable permission bypass.
- Below full access, the child's working directory must be inside the parent's workspace root; a `cwd` outside it is refused. When the parent's workspace root is unknown (no sandbox service), an explicit `cwd` is refused unless the run is read-only; without `cwd` the child uses the parent's directory as usual.
- A read-only agent can delegate only to read-only roles, CLI roles included.
- DSH does not count external children toward its depth limit, so the plugin refuses the delegation itself when the next depth would exceed DSH's limit. The CLI's own sub-agents are not counted.

### Workspace confinement

Below full access, what a CLI may change is enforced as follows:

| Preset | Enforced by |
|---|---|
| Grok Build / Pi **Workspace write** | DSH’s existing `ctx.sandbox.confine` OS file policy, including CLI/bootstrap and preflights; see scope and caveats below |
| Codex **Read-only**, **Workspace write** | Codex's operating-system sandbox, which also covers shell commands and resolves symbolic links |
| Claude Code **Read-only**, **Edit files (no shell)**; Antigravity **Read-only**, **Edit files**; OpenCode **Read-only**, **Edit files** | The CLI's own tool permissions: which tools exist (no shell) and which paths its file tools may write. There is no operating-system sandbox |

For the tool-permission kind, the plugin checks the working directory before a workspace-write run and **refuses the delegation** (with a short reason the parent sees) when:

- the directory tree contains a symbolic link that leads outside the parent's workspace (or outside the directory when the workspace is unknown); the CLI's file tools would follow it. The check includes `.git` and follows internal directory links once per real path. Unreadable directories are refused. A directory too large to check (over 100,000 entries or 2 seconds) is refused too;
- OpenCode only: the directory lies below the top-level of a git repository. OpenCode's file tools reach the whole repository, not just the directory (verified: a write to a sibling directory succeeds, and `apply_patch` can move a file anywhere in the repository), so delegate with the repository's top-level as `cwd`.

Claude Code and Antigravity keep their file tools inside the run's directory (verified: writes to a sibling directory, the repository's top-level, or elsewhere are refused). The scan is a startup check; it does not prevent another process changing links during a run. Hard links are not detected: a file hard-linked into the workspace is changed in place. For a deliberately unconfined edit, explicitly select a native/full-access preset under a full-access parent; a full-access parent alone does not change the role's restricted preset. A read-only role remains an alternative when no edits are needed.

Below full access OpenCode also refuses a project that has `.opencode/plugin` or `.opencode/plugins` code: OpenCode 1.19.3 runs it at start even with the project configuration disabled.

### Grok/Pi Host file policy and limits

Workspace write uses **the same path-based file policy as parent DSH Bash**, not a new VM or custom sandbox. CWD and `/tmp` are writable; global reads, network access and process visibility are not restricted. Inside regular-file writes work; direct and symlink-following outside regular-file writes are denied. No recursive whole-workspace preflight is performed, so ordinary Python venvs are supported.

**Existing hard-link inode aliases can share writes outside the writable root** (observed with real Pi). This is not hardlink-safe or absolute outside-effect isolation. Every host-confined result includes the hard-link/network/process caveat. On the tested Linux kernel, Landlock ABI 4 gives **partial** enforcement (notably lacking device ioctl handling); a fixed additional warning is shown in results and logged. Partial enforcement is not relabeled full enforcement. Missing/failed confinement refuses launch, never falls back to native. See [host-confined validation](docs/host-confined-cli-validation.md) for actual evidence and limitations; historical native qualifications do not qualify this new preset.

### Read-only on a CLI

| CLI | What Read-only does |
|---|---|
| Codex | Runs in Codex's `read-only` sandbox |
| Claude Code | Only the read tools (`Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`), no shell, in `dontAsk` mode: anything that would need approval is refused. No setting sources are loaded (user, project, and local settings, allow rules, hooks, `CLAUDE.md`), so they cannot widen it; this also skips a model, environment, or `apiKeyHelper` set in those settings |
| Antigravity | Only the read tools (view files, search, list folders); no shell |
| Grok Build / Pi | Unsupported for both presets. A read-only role is rejected/disabled rather than started with broader access |
| OpenCode | Every tool denied except reading, searching, and listing files; `.env` files stay unreadable. The project's OpenCode configuration and `AGENTS.md` are not loaded; a project with `.opencode/plugin(s)` code is refused |

### External CLIs settings

The **External CLIs** section of the Plugins page has one card per CLI, shared by every role on it:

- **Executable**: an absolute path, or a command name looked up on the host's `PATH`. Empty uses `codex`, `claude`, `agy`, `opencode`, `grok`, or `pi`.
- **Forwarded environment variables**: variable names only (commas or spaces). Values are read from the DSH host process environment when the CLI starts and are never stored. Up to 32 names. **Test connection** counts only those that are set on the host.
- **Test connection**: checks the saved settings: whether the executable is found, its version, sign-in state where the CLI can report it cheaply, and the models it lists (used as suggestions in the role editor). It never calls a model. Failures remain retryable and do not disable other CLI cards or ordinary role execution. Diagnostics distinguish missing client connection, structured Remote failures, ambiguous HTTP 404, Host authentication, and transport/malformed responses from CLI not-found/authentication results. HTTP 404 alone cannot tell whether the Gateway or Remote endpoint is missing. The RPC path is not a documented stable DSH API; the real HTTP bridge/Gateway integration was checked only on DSH `0.2.1-rc.2`. Grok/Pi probes read only the version: authentication and model discovery remain unknown, not falsely verified.

These settings apply to the next delegation, also in running sessions.

### Limits

- **One-shot**: a CLI child cannot receive `send_message` (DSH rejects it) and `list_agents` does not list it. Stop it with `interrupt_agent`; DSH Web shows it as an external task row without a stop button.
- **Always fresh**: no fork of the parent conversation and no Agent Preset.
- **No rollback**: files changed before a cancel or timeout stay changed.
- **Host restart**: a run in progress when DSH stops is stopped, and its completion notice is lost.
- **Timeout** per role (default 30 minutes). A stop first asks the CLI to cancel where it supports that (OpenCode and Pi), then terminates the process; DSH kills it after a short grace. Background processes the CLI leaves behind are stopped too when the run ends.
- **The CLI's own side effects** still happen:
  - Antigravity records each run in its own history (about 0.4 MB under `~/.gemini`), so a delegated run becomes the target of `agy --continue` in that directory. agy also always contacts Google's feature-flag and telemetry hosts.
  - OpenCode may create `<repo>/.git/opencode` in your repository. It retries rate-limit and server errors for about a minute before failing.
  - Claude Code refuses **Bypass permissions** when DSH runs as root (reported as a configuration failure with `bypass-refused-as-root`).
  - Antigravity's **Edit files** also allows writes under the OS temp directory (agy's own policy); writes elsewhere outside the run's directory are denied and reported as a permission failure.
  - Codex's **Workspace write** also allows writes under `/tmp` and `$TMPDIR`, keeps `.git` (and `.codex`, `.agents`) read-only, so a worker cannot commit, and turns network access off.
  - What each preset loads from the project: Codex reads the project's `AGENTS.md` and, for a project you trusted in Codex, its `.codex/config.toml` (the sandbox flags above still win). Claude Code's Read-only and Edit files load no settings files and no `CLAUDE.md`; its full-access presets load user, project, and local settings, including hooks. OpenCode below full access loads only your global OpenCode configuration (no project `opencode.json`, `.opencode` files, or `AGENTS.md`); at full access it loads the project's too. Antigravity reads the project's `AGENTS.md`.
- A failed run reaches the parent as a short diagnostic in fixed wording, such as `Subagent failure (CLI: Codex; category: auth; exit code: 1)` with one hint line. The CLI's own error text goes only to the host log.

### Security notes

- Nothing secret is stored in the plugin settings: the CLIs use their own sign-in, and forwarded variables are names only.
- DSH removes variables whose names contain `KEY`, `TOKEN`, `SECRET`, or `PASSWORD` (and `DSH_*`) from every child process. A CLI gets such a variable only when you forward it by name.
- A forwarded variable is visible to the CLI and usually to the tools it runs (shell commands, MCP servers). Forward only what that CLI needs.
- Other variables of the DSH process, such as proxy settings and `*_BASE_URL`, are inherited as usual.

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
- DSH's official out-of-process providers (codex, claude-code, acp) are not used. DSH roles use the spawn and fork providers; CLI roles run through this plugin's own runners (see [External CLI runners](#external-cli-runners), which has its own limits).
- When a child's conversation is compacted, the role instructions are re-sent as runtime context; the initial task text is replaced by the summary.
- Some Agent Presets suppress optional runtime context (for example `minimal`). The role instructions are still delivered, but the official "delegated subagent" statement is not.

## How it works

- On `agent/created`, the plugin records the session's role list in its `rolesubagents` storage domain and registers `delegate` in that Agent's own scope.
- For each child it starts, it reserves the child id, records the child's role in the storage domain, and, for read-only roles, appends `sandbox/mode: read-only` before the child's first request. If that first pin fails, the child is not started. Afterwards, `session/event` re-appends `read-only` whenever the mode changes, including after resume when the stored mode is no longer `read-only`. The read-only agent also receives a `tools.guard` that refuses write-like calls.
- A fork role set to task only is started on the spawn provider. A fork that inherits history is started on the fork provider, and the host logs that inherited tool results can carry prompt injection.
- One global runtime-context provider reads the role from the storage domain, so the instructions survive compaction and resume. Role state used to be written as Session-log plugin records; those are still read back, but new state is only written to the storage domain (an exported Session moved without its storage keeps its log, not its role). A full-history fork also receives a warning to treat that history as untrusted.
- A CLI role takes a separate path. `delegate` checks the depth limit and the access ceiling, then registers one temporary provider for that delegation (`rolesubagents:<cli>:<role>:<uuid>`) and starts the child through DSH's subagent service with delivery to the parent; the registration is removed right after the start. The provider's `start` spawns the CLI through the Host's `ctx.subprocess` service, speaks that CLI's session protocol (a task on stdin and JSON lines on stdout for Codex, Claude Code, and Antigravity; Agent Client Protocol JSON-RPC for OpenCode), and turns its final event into DSH's result. DSH then owns the run: it delivers the completion notice and stops it on `interrupt_agent`. [docs/external-cli.md](docs/external-cli.md) describes the design for maintainers.

## Development

```sh
pnpm install
pnpm check   # lint, typecheck, test, and committed lib/ matches a fresh build
pnpm build   # lib/index.js (Host) and lib/client.js (Web)
pnpm check:host # optional real installed-DSH workflow integration checks
pnpm check:cli  # optional real-CLI integration checks (see below)
```

`pnpm check:cli [self|codex|claude-code|agy|opencode|grok-build|pi …]` runs the external runners against a real DSH runtime and real CLIs. It is opt-in, not part of `pnpm check`, and needs DSH (`DSH_CHECKOUT`, default `/opt/dsh`) plus CLI binaries. The harness uses disposable HOME/XDG/DSH_HOME before runtime initialization, local fake model endpoints and dummy keys; it does not copy real credentials. This is not an OS network sandbox or proof that native telemetry/extensions never run.

Pin a binary with `CHECK_CLI_EXECUTABLE_<UPPER_ID>` and its expected version with `CHECK_CLI_VERSION_<UPPER_ID>` (e.g. `CHECK_CLI_EXECUTABLE_CLAUDE_CODE`). `CHECK_CLI_REPORT` creates a new raw JSON record and refuses an existing path; it does not by itself certify compatibility. `CHECK_CLI_REQUIRE_ALL=1` rejects skips. Missing explicitly requested CLIs/suites, unknown IDs and zero-match filters fail; only optional discovery may skip missing binaries. Known Snap launch wrappers are refused because they can rewrite HOME: use a direct official binary rather than real credentials. See [harness controls and limitations](docs/external-cli.md#reproducible-harness-controls) and [exact compatibility evidence](docs/cli-compatibility.md).

`DSH_CHECKOUT=/path/to/dsh node scripts/check-probe-host.mjs` separately tests the actual installed HTTP bridge/Gateway with an isolated loopback server and a fixture subprocess boundary; it does not deploy or restart DSH.

`lib/` is committed. After changing sources, run `pnpm build` and commit `lib/` with them.

## License

MIT
