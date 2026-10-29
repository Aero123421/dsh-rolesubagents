# AI role administration: `manage_roles`

`manage_roles` manages **saved role definitions for this DSH Host/profile**. It does not start, stop, or modify a running child. Actual execution remains the existing `delegate` tool.

日本語の概要は [README](<../README.ja.md#aiによるロール管理>) を参照してください。保存、現在の親への反映、既存の子の実行は別の操作です。モデル候補の取得を、認証・利用可能性の確認と混同しないでください。

## Permission and scope

The Plugins page has a dedicated **Allow AI role management** / **AIによるロール管理を許可** switch. It defaults **OFF** and persists immediately, separately from the role Save button. The displayed switch value is the Host-accepted value, not an optimistic draft. Saving, failure and revision-conflict states are visible.

This is an explicit **Host/profile role-configuration administration capability**, not merely permission to write workspace files. Eligible ordinary workspace-write parents can use it; full access is not required to create workspace-limited roles. It does not change the caller's filesystem sandbox. The normal delegation checks still decide whether a particular child may run.

The gate is live configuration, intentionally separate from snapshotted `RoleSettings` and the master Subagents switch. Turning management OFF does not delete saved roles, undo earlier commits, disable ordinary delegation, or cancel children. If OFF commits before an old preview's apply, the shared settings revision fences that apply out; a change that committed before OFF is not retroactively rolled back.

The tool is restricted to eligible live parent agents and checks the actual execution caller on every call. Children do not receive management authority through tool inheritance, a role instruction, a captured tool definition, or caller-supplied IDs. A human-created fork is not automatically a subagent merely because it has a `parentSession` link; trusted origin/delegation depth and recorded role identity matter. Mutation checks also respect the caller's read-only state and CLI access ceiling. Hiding the tool is not the only enforcement layer. Child initialization restricts `manage_roles` only when that tool is actually visible on the inherited surface: an absent parent-local registration must not break child startup, including strongly read-only children. Execution guards and live caller checks still deny child administration.

The management API has **no operation** to change:

- `allowAiRoleManagement`, the master `enabled` switch, or another plugin's namespace;
- `clis`, executable paths, forwarded environment-variable settings, authentication, installation or updates;
- `workflowModel`, spawn/fork provider routes, or the caller's sandbox mode;
- a built-in role's identity or existence;
- an arbitrary Agent Preset. An existing preset may be preserved or explicitly cleared; selecting a new preset requires the settings UI.

These are boundaries of this capability, not a claim that it can restrain unrelated tools already granted broader Host/file access. Editing role definitions is persistent administration, so enable it only for a Host/profile where that authority is intended.

## Operations

| `action` | Input and result |
| --- | --- |
| `help` | No extra arguments. Fixed guidance, prompt-field distinctions, schematic calls and safe sequence. Requires the same live parent and enabled gate; allowed for read-only parents. No write, preview plan, model lookup, audit query or child launch. |
| `list` | Saved role summaries, global settings `revision`, current session catalog state, repair status and recent audit metadata. Descriptions are shortened and instructions are represented by character counts. |
| `get` | Exact saved `id`; returns the full **known** role fields, including instructions, plus global/current revisions. |
| `capabilities` | Optional `target` (`dsh` or a CLI ID); returns supported contexts, required route fields, permission/effort metadata and service-presence information. Advertised permissions are not caller authorization. |
| `models` | Required `target`, optional DSH `provider`, `query`, `limit`, `offset`, `refresh`; returns bounded reference data with its provenance and uncertainty. |
| `preview` | Exact `expectedRevision` from a fresh read and a `changes` batch of `create`/`update`/`delete`; strictly validates and returns a caller-owned `planId`, expiry, known-field summary diff and `noChange`. Does not save the role settings. |
| `apply` | The live caller's unexpired `planId`; rechecks permission, revision and semantics, then writes only the roles path. Does not refresh the caller's catalog or start a child. |
| `apply_current` | Fresh global `expectedRevision` and exact string `expectedSessionRevision` from `currentSession.revision`; explicitly refreshes only the calling parent's future delegation catalog. |

Unknown action-specific fields are rejected: this is not an arbitrary config-path/JSON-patch API. The tool never accepts a caller-selected settings namespace or another session to refresh.

### Help and the four prompt/display fields

Start with `{ "action": "help" }` for a short model-facing guide. The response is static and contains no live settings or role contents; example revisions and plan/session IDs must be replaced with fresh returned values. Its examples are not executed by reading help. Reuse a suitable existing role rather than creating near-duplicates for one-off tasks.

| Field | Audience and purpose |
| --- | --- |
| Saved role `description` | Parent: when to choose this role; not a child instruction. |
| Saved role `instructions` | Child: reusable approach, constraints and report format, delivered as additional role context, not higher-priority authority. |
| `delegate.prompt` | Child: this particular task, targets, context and completion criteria. Fresh children do not see the parent conversation. |
| `delegate.description` | Short display label for this particular task; not the saved role description. |

For example: describe a reviewer as “use for reviewing changes without edits”; instruct it to report severity, evidence and suggested fixes; request a specific authentication diff in `delegate.prompt`; label that task “Review authentication changes.” Text saying “do not edit” is not a permission setting: also use `readOnly: true` where intended and supported. Neither instructions nor help grant permissions.

### Change syntax and validation

A preview accepts at most **16 changes**; the normal total role limit remains **32**. A role may be changed only once in one batch.

- Create: `{ "op": "create", "role": { "id": "...", "description": "...", ... } }`. Context defaults to `spawn`; omitted optional model settings retain the normal inheritance/default semantics. A CLI runner can omit its permission to use that CLI's advertised default.
- Update: `{ "op": "update", "id": "...", "patch": { ... } }`. The role ID stays stable; built-in identity markers are not editable.
- Delete: `{ "op": "delete", "id": "..." }`. Built-in `general` and `fork` cannot be deleted or shadowed.
- `model` and `runner` are replacement objects, not implicit deep patches. Supply their complete intended known values. Explicit `null` clears optional model, runner, fork scope or an existing Agent Preset where supported.
- Incompatible combinations must be cleared deliberately. For example, moving to fork cannot silently discard an existing model/preset, and selecting a CLI cannot silently leave DSH model/preset fields attached.
- A requested CLI preset above the caller's effective ceiling is rejected. Unsupported read-only presets are rejected, not silently disabled or converted to full access.
- Normalization repairs are not success: stored settings needing repair or invalid requested changes receive structured diagnostics. Use the settings UI to repair the stored configuration rather than having an unrelated management change repair it implicitly.

Known-field validation and immutable merging are shared with settings editing. **Preservation applies to literal JSON role configuration, not executable profile bindings.** The Host scans the bound entry's raw composed configuration (including inherited configuration), without returning it to the model. A root or role-subtree `__jsExpr`/`!!js` expression, accessor, cyclic/nonliteral or overly complex data refuses mutation instead of materializing evaluated values/secrets. The UI obtains a read-only `rolesubagentsManagement/writeSafety` status for the exact sent revision before the normal form mutation; absent/stale/unsafe status refuses the whole-array write. This check remains available with AI management OFF. Gate-only writes do not restate roles and remain independent. Edit executable profiles natively.

Within that literal-only contract, untouched role data and unknown nested model/runner metadata are preserved internally, including across a custom-role rename in the UI. Newly added/duplicated roles do not inherit an old row's opaque metadata merely because an ID was reused. Only known role projections reach the model; unknown raw fields are not returned by `list`, `get` or previews.

Writable administration requires a successfully resolved supported caller sandbox policy; missing/throwing/unknown policy does not default to writable administration. Read-only parent metadata queries remain possible, but mutation is refused. Agent disposal and permission OFF promptly release that owner's plans and abort metadata waits. Metadata retrieval has a 10-second deadline (up to 30 seconds only through the internal test/service seam); provider-side requests already issued may complete independently, but aborted/invalidated results cannot refill the cache.

Preview plans are bound to the live caller, expire after **10 minutes**, and are bounded to **20 per caller / 100 total**. Changing the settings revision—including OFF/ON—invalidates an old plan's write fence. A successfully applied plan can replay its stored result without writing again while it remains live; pending applies share the same result. This is not an exactly-once guarantee across plugin/process restarts. A missing/expired plan or conflict requires a fresh read and preview, not blind retry.

## One-off execution is not role administration

Use an existing role with `delegate` for a one-off task. DSH spawn roles accept a one-shot `provider` + `model` pair and optional `effort`; effort alone needs a configured role model. A new pair clears old effort unless explicitly supplied. DSH validates the route. Fork roles (including task-only) and external CLI roles reject route/effort overrides. `readOnly: true` can strengthen this execution, never weaken it (`false` is rejected); unsupported CLI read-only presets refuse. Parent restrictions still apply.

These options neither save roles nor mutate the current catalog, and do not require enabling AI management. The start receipt identifies the configured request, not a confirmed actual model/effort or a completed answer. Persistent changes still require the preview/apply sequence below.

## Sequential example

The following are **schematic individual tool calls**, not one already-bound workflow program. Replace example revisions and plan/session IDs with the exact values returned by your own calls. No management step invokes inference or starts a child.

1. Read saved/current catalog state:

   ```json
   { "action": "list" }
   ```

2. Optionally inspect targets/models. DSH first returns its provider roster; request one returned provider explicitly to list its models. Do not invent a provider or treat a candidate as a verified account entitlement.

   ```json
   { "action": "capabilities", "target": "pi" }
   ```

   ```json
   { "action": "models", "target": "dsh" }
   ```

   ```json
   { "action": "models", "target": "dsh", "provider": "replace-with-returned-provider-id", "limit": 20 }
   ```

3. Preview a fresh DSH role that inherits the parent's model. Here `42` stands for the exact global revision from `list`; it is not a value to reuse blindly.

   ```json
   {
     "action": "preview",
     "expectedRevision": 42,
     "changes": [
       {
         "op": "create",
         "role": {
           "id": "managed_worker",
           "description": "Implement a narrowly scoped change and report the checks performed.",
           "instructions": "Change only the requested scope. Report what changed, how it was checked, and remaining issues.",
           "context": "spawn",
           "readOnly": false
         }
       }
     ]
   }
   ```

   For a Pi role, the corresponding role may instead include `"runner": { "cli": "pi", "permission": "workspace-write" }` and use another ID. This chooses configuration only: it does not install Pi, authenticate it, certify its defaults, or execute it. Choose a model from the reference data or supply a valid manual ID if intended.

4. Inspect the returned diff, then apply its exact plan ID:

   ```json
   { "action": "apply", "planId": "replace-with-returned-plan-id" }
   ```

5. **Read `list` again.** A successful apply may be followed by another writer, so do not guess the new revision. Global saving alone leaves the current session catalog unchanged.

6. If current-session use is wanted, apply the fresh saved catalog explicitly. Both values below must come from that latest `list` response:

   ```json
   {
     "action": "apply_current",
     "expectedRevision": 43,
     "expectedSessionRevision": "replace-with-currentSession.revision"
   }
   ```

7. Inspect `currentApplied`, `sessionDurable`, `currentSession` and `nextAction`. At the **next model/tool boundary**, the parent may make a separate ordinary delegation, for example `delegate({ role: "managed_worker", description: "Implement scoped fix", prompt: "...the actual task..." })`.

The final `delegate` is optional and, if actually run, starts a child and can consume normal model usage. Do not parallelize apply/current refresh with delegation. A previously bound `run_code`/workflow program can retain the old role enum; finish it and let the next tool/model step bind fresh definitions. Creating a role is not permission to skip that boundary.

## Saving versus current-session application

Settings-page edits and management `apply` affect **new root conversations**. A child or fork of an old conversation can inherit its old catalog, even if the child itself is newly created. Previously saved/resumed session snapshots are not silently replaced.

`apply_current` replaces only the caller's role catalog, persists the session snapshot where possible, and rebuilds its delegate definition. It preserves the session's `enabled`, workflow default model and CLI settings. It does not enable a session whose snapshot disabled delegation. Such a session needs a new root conversation after the human enables the relevant setting.

The following remain unchanged:

- already-admitted delegations, which retain the role/settings they captured;
- existing children, their instructions, read-only enforcement and catalog snapshots;
- other root conversations and their children;
- previously bound workflow programs.

Future stale delegate wrappers are rejected rather than letting a removed role survive a capture. Ordinary later delegation still checks the caller's permissions, working directory, depth and runner support. Removing a saved role is not a global cancellation/revocation of every old session's snapshot; stopping a running child remains the existing interruption mechanism.

### Read the truth fields, not a single success label

Global profile storage, session KV persistence, tool re-registration and audit storage do **not** share one transaction. Current refresh revalidates the live gate, exact global/session revisions, caller and lifetime after asynchronous storage waits and before publication. A Session-keyed shield keeps tentative storage candidates private: forks and same-session replacement Agents inherit the prior committed catalog, and replacement refreshes stay busy until the old refresh settles. Plugin teardown awaits pending restoration and storage close. Delegate owner/plugin liveness is separate from the catalog epoch, so refresh preserves admitted roles but disposal/unload cannot start a late unpinned child after delayed validation. If invalidated, it keeps the old delegate catalog and attempts to restore the prior Session snapshot; an unconfirmed restoration is reported, not described as an atomic rollback.

The canonical Host profile writer does not accept an abort signal. Once a profile transaction is admitted, caller cancellation or unload alone cannot retroactively cancel it; OFF is different because it changes the same CAS revision. New calls/plans are stopped and metadata waits are canceled, while known committed outcomes remain reported truthfully.

| Field | Meaning when returned |
| --- | --- |
| `globalSaved` | Global role configuration was committed (or already required no change). It does not mean the current catalog changed. |
| `currentApplied` | The calling parent's future delegation catalog was applied. |
| `sessionDurable` | The current-session snapshot persistence outcome; do not infer it from global saving. |
| `auditDurable` | Audit metadata persistence outcome; audit failure does not undo a global commit. |
| `sessionOutcome` | Distinguishes applied/unchanged/restored from an unconfirmed local rollback. |
| `revisionUnknown` / `currentOutcome` | A follow-up state could not be confirmed. Read the current state before deciding what to retry. |

For example, a current-refresh failure can correctly report `globalSaved: true` and `currentApplied: false`. Do not tell the user that their role was never saved, and do not repeat the global write merely because a later step failed. False/omitted durability fields must not be promoted to durable success.

## Model and capability references

Targets are `dsh`, `codex`, `claude-code`, `agy`, `opencode`, `grok-build`, and `pi`.

- **DSH:** reads the registered provider roster first. An explicit provider request lists its model metadata and reasoning efforts; individual failures remain partial/error results rather than discarding successful data.
- **External CLIs:** combines only known built-in suggestions, safely projected configuration and previously observed/cached probe data. The catalog lookup itself does not launch a new probe or CLI process.
- **Pi:** projects permitted IDs/names from its model JSON configuration. It does not open the auth store, refresh OAuth or initialize extensions/packages.
- **Grok:** recognizes bounded model-table header aliases from its TOML configuration. It is not a complete TOML/config/model-catalog evaluator. Header-like text inside multiline values is not a model. No key command is evaluated and browser/MCP token stores are not opened.

Configuration files may themselves contain credentials; only the defined model metadata projection is returned. Neither raw config contents nor authentication values are included in reference results. Host registry methods may perform their normal metadata retrieval; “no inference” is not a promise of no network activity by a provider adapter.

Results distinguish `source`, `fetchedAt`, `lastAttemptAt`, `stale`, `status` (`ready`/`partial`/`unknown`/`error`), coverage, limitations and bounded failures. `authentication` is **`not-verified`**, and valid manual IDs remain allowed. A ready candidate page is not proof of a complete native catalog, installed/authenticated CLI, model entitlement, model compatibility, or successful delegation. A service-presence capability check is not a fresh sandbox-enforcement probe.

Model pages support filtering and offsets, with a maximum page size of **100**. `refresh` refreshes safe metadata/cache input only; it does not run inference, log in, install/update a CLI, evaluate key commands, or activate user extensions. Missing discovery data is an honest unknown, not an empty authoritative catalog or a reason to invent models.

## Persistence, conflicts and history

Management selects its own active settings entry and reads gate, role data and revision from the **same authoritative descriptor**. It writes only `roles` through the Host's canonical revision-fenced `settings.mutate`. No direct profile editing, `Volatile.set`, or session storage is used as a substitute for saving global configuration.

The current custom page supports the standard unique `rolesubagents` namespace. A missing/ambiguous/rebound owning entry or a Host without the required settings service refuses management rather than choosing another plugin's row. Ordinary role delegation remains available independently of this optional management feature.

A profile revision check occurs inside the Host's writer lock, so UI writes, other AI writes and gate changes participate in the same conflict protocol. There is no automatic retry after a conflict and no silent repair/rebase of a real role change. A dirty UI draft survives a gate-only change when both its known base and raw roles are unchanged; real role or opaque-metadata changes remain a conflict. A clean editor follows the accepted Host state. The immediate gate save never writes a stale role draft.

Audit history stores **metadata only**: time, caller/session identifiers, operation, role IDs, field names and revisions. It is bounded to **100 records**, and `list` returns the most recent **20** with durability status. It does not store full prompts, role instruction contents, raw configuration or authentication. Audit degradation is reported separately from a committed configuration change.

## Verification scope

This document describes the operation contract and its intended usage, not a blanket compatibility certificate. See the [isolated validation report and raw evidence](<role-management-validation-20261023.md>) for tested versions, results and fixture boundaries. The examples do not change a running deployment, restart DSH, configure credentials, install a CLI, or invoke a model by being documented.
