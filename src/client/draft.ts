/**
 * Pure draft model of the role editor: the list the user is editing, the edits
 * that keep it consistent, and its validation.
 *
 * The draft always carries every role, in order, under a stable `uid` so a row
 * keeps its identity while its id is being typed. {@link analyseDraft} is the
 * only judge of whether a draft may be saved: it runs the shared
 * `normalizeSettings` and reports every adjustment it would make, because
 * each of those would drop or change something the user typed.
 */

import { CLI_IDS, type CliId, cliDescriptor, isCliId, presetAccess } from '../shared/cli/index.ts'
import {
  type CliSettings,
  type CliSettingsMap,
  DEFAULT_ROLES,
  MAX_DESCRIPTION_LENGTH,
  MAX_INSTRUCTIONS_LENGTH,
  MAX_ROLES,
  normalizeSettings,
  ROLE_ID_PATTERN,
  type ForkScope,
  type RoleContext,
  type RoleDefinition,
  type RoleModel,
  type RoleRunner,
  type RoleSettings,
  roleContextText,
  roleListLine,
  type SettingsProblem,
} from '../shared/roles.ts'
import { normalizeClis } from '../shared/runner.ts'

/** Longest role id; the `{0,31}` tail of `ROLE_ID_PATTERN` plus its first letter. */
export const ID_MAX_LENGTH = 32

/** One role in the draft. */
export interface DraftRow {
  readonly uid: number
  readonly role: RoleDefinition
}

/** The whole settings value being edited. */
export interface Draft {
  readonly enabled: boolean
  readonly workflowModel?: { provider: string; model: string }
  /** Per-CLI executable and forwarded variable names, as typed; omitted when nothing is set. */
  readonly clis?: CliSettingsMap
  readonly rows: readonly DraftRow[]
  /** The settings this draft started from; the baseline of {@link isDirty}. */
  readonly base: RoleSettings
  /** Host revision the draft started from; it fences the save. */
  readonly revision: number | undefined
  /** The uid the next added row receives. */
  readonly nextUid: number
}

/** The part of a role the text fields and switches edit directly. */
export type RolePatch = Partial<Pick<RoleDefinition, 'id' | 'enabled' | 'description' | 'instructions' | 'readOnly'>>

function cloneRole(role: RoleDefinition): RoleDefinition {
  return {
    ...role,
    ...(role.model === undefined ? {} : { model: { ...role.model } }),
    ...(role.runner === undefined ? {} : { runner: { ...role.runner } }),
  }
}

function cloneClis(clis: CliSettingsMap | undefined): CliSettingsMap | undefined {
  if (clis === undefined) return undefined
  const copy: CliSettingsMap = {}
  for (const id of CLI_IDS) {
    const entry = clis[id]
    if (entry === undefined) continue
    copy[id] = {
      ...entry,
      ...(entry.envPassthrough === undefined ? {} : { envPassthrough: [...entry.envPassthrough] }),
    }
  }
  return copy
}

/**
 * Start a draft from normalized settings.
 * @param settings - the Host's current settings, already normalized.
 * @param revision - the Host revision they were read at.
 * @returns a draft with no edits.
 */
export function createDraft(settings: RoleSettings, revision: number | undefined): Draft {
  return {
    enabled: settings.enabled,
    ...(settings.workflowModel === undefined ? {} : { workflowModel: { ...settings.workflowModel } }),
    ...(settings.clis === undefined ? {} : { clis: cloneClis(settings.clis) }),
    rows: settings.roles.map((role, index) => ({ uid: index + 1, role: cloneRole(role) })),
    base: {
      enabled: settings.enabled,
      roles: settings.roles.map(cloneRole),
      ...(settings.workflowModel === undefined ? {} : { workflowModel: { ...settings.workflowModel } }),
      ...(settings.clis === undefined ? {} : { clis: cloneClis(settings.clis) }),
    },
    revision,
    nextUid: settings.roles.length + 1,
  }
}

/**
 * The settings value the draft stands for, exactly as typed.
 * @param draft - the draft.
 * @returns settings that may still be invalid.
 */
export function draftSettings(draft: Draft): RoleSettings {
  return {
    enabled: draft.enabled,
    roles: draft.rows.map(row => row.role),
    ...(draft.workflowModel === undefined ? {} : { workflowModel: { ...draft.workflowModel } }),
    ...(draft.clis === undefined ? {} : { clis: cloneClis(draft.clis) }),
  }
}

/** A number as text, so NaN (a half-typed timeout) differs from "not set" when compared. */
const numberKey = (value: number | undefined): string | null => (value === undefined ? null : String(value))

function canonicalRunner(runner: RoleRunner | undefined): unknown {
  if (runner === undefined) return null
  return [
    runner.cli,
    runner.provider ?? null,
    runner.model ?? null,
    runner.effort ?? null,
    runner.permission,
    numberKey(runner.timeoutMinutes),
  ]
}

function canonicalClis(clis: CliSettingsMap | undefined): unknown[] {
  return CLI_IDS.map(id => {
    const entry = clis?.[id]
    return [entry?.executable ?? null, entry?.envPassthrough ?? null]
  })
}

function canonical(role: RoleDefinition): unknown[] {
  const { model } = role
  return [
    role.id,
    role.enabled,
    role.builtin ?? null,
    role.description,
    role.instructions,
    role.context,
    role.forkScope ?? null,
    role.readOnly,
    role.agentPreset ?? null,
    model === undefined ? null : [model.provider, model.model, model.reasoningEffort ?? null],
    canonicalRunner(role.runner),
  ]
}

/**
 * Whether two settings hold the same values, whatever their key order.
 * @param a - first settings.
 * @param b - second settings.
 * @returns true when equal.
 */
export function sameSettings(a: RoleSettings, b: RoleSettings): boolean {
  return (
    a.enabled === b.enabled &&
    a.workflowModel?.provider === b.workflowModel?.provider &&
    a.workflowModel?.model === b.workflowModel?.model &&
    a.roles.length === b.roles.length &&
    JSON.stringify(a.roles.map(canonical)) === JSON.stringify(b.roles.map(canonical)) &&
    JSON.stringify(canonicalClis(a.clis)) === JSON.stringify(canonicalClis(b.clis))
  )
}

/**
 * Whether the draft differs from the settings it started from.
 * @param draft - the draft.
 * @returns true when a save would write something new.
 */
export function isDirty(draft: Draft): boolean {
  return !sameSettings(draftSettings(draft), draft.base)
}

function idsOf(draft: Draft): Set<string> {
  return new Set(draft.rows.map(row => row.role.id))
}

/**
 * A role id derived from `base` that no other role uses: `base`, then `base-2`, `base-3`…
 * @param base - the wanted id; an invalid one falls back to `role`.
 * @param taken - ids already in use.
 * @returns a valid, unused id.
 */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  const root = ROLE_ID_PATTERN.test(base) ? base : 'role'
  if (!taken.has(root)) return root
  for (let n = 2; ; n++) {
    const suffix = `-${n}`
    const candidate = `${root.slice(0, ID_MAX_LENGTH - suffix.length)}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

function mapRow(draft: Draft, uid: number, edit: (role: RoleDefinition) => RoleDefinition): Draft {
  let changed = false
  const rows = draft.rows.map(row => {
    if (row.uid !== uid) return row
    const role = edit(row.role)
    if (role === row.role) return row
    changed = true
    return { uid, role }
  })
  return changed ? { ...draft, rows } : draft
}

/**
 * Switch the master switch.
 * @param draft - the draft.
 * @param enabled - the new value.
 * @returns the edited draft.
 */
export function setEnabled(draft: Draft, enabled: boolean): Draft {
  return draft.enabled === enabled ? draft : { ...draft, enabled }
}

/** Set the workflow default route; preserve incomplete pairs for validation. */
export function setWorkflowModel(draft: Draft, model: RoleSettings['workflowModel']): Draft {
  const next =
    model === undefined || (model.provider === '' && model.model === '')
      ? undefined
      : { provider: model.provider, model: model.model }
  if (draft.workflowModel?.provider === next?.provider && draft.workflowModel?.model === next?.model) return draft
  const { workflowModel: _previous, ...rest } = draft
  return next === undefined ? rest : { ...rest, workflowModel: next }
}

/**
 * Edit text fields and switches of one role. The id of a built-in role is ignored.
 * @param draft - the draft.
 * @param uid - the row.
 * @param patch - the new values.
 * @returns the edited draft.
 */
export function patchRole(draft: Draft, uid: number, patch: RolePatch): Draft {
  return mapRow(draft, uid, role => {
    const { id, ...rest } = patch
    const next = { ...role, ...rest, ...(id === undefined || role.builtin !== undefined ? {} : { id }) }
    if (role.runner !== undefined && patch.readOnly !== undefined && patch.readOnly !== role.readOnly) {
      // A runner's permission follows Read-only: on → the CLI's read-only preset, off → its default preset.
      next.runner = { ...role.runner, permission: switchedPermission(role.runner.cli, patch.readOnly) }
    }
    return next
  })
}

function switchedPermission(cli: CliId, readOnly: boolean): string {
  const descriptor = cliDescriptor(cli)
  return readOnly ? descriptor.presetForAccess['read-only'] : descriptor.defaultPermission
}

/**
 * Choose where a role's child runs. Built-in roles always run on DSH.
 * DSH → CLI starts fresh and drops the DSH-only fields (fork, inherited context,
 * model, agent preset); CLI → DSH drops the runner; CLI → another CLI keeps only
 * the permission Read-only implies. The permission is the CLI's read-only preset
 * for a read-only role, its default preset otherwise.
 * @param draft - the draft.
 * @param uid - the row.
 * @param cli - the CLI, or undefined for DSH.
 * @returns the edited draft.
 */
export function setRunner(draft: Draft, uid: number, cli: CliId | undefined): Draft {
  return mapRow(draft, uid, role => {
    if (role.builtin !== undefined || role.runner?.cli === cli) return role
    if (cli === undefined) {
      const { runner: _runner, ...dsh } = role
      return dsh
    }
    const { runner: _runner, model: _model, agentPreset: _preset, forkScope: _scope, ...rest } = role
    return { ...rest, context: 'spawn', runner: { cli, permission: switchedPermission(cli, role.readOnly) } }
  })
}

/** The runner fields the editor changes directly. An empty text clears its field. */
export type RunnerPatch = Partial<Pick<RoleRunner, 'model' | 'provider' | 'effort' | 'permission' | 'timeoutMinutes'>>

/**
 * Edit the runner fields of a CLI role; ignored for DSH roles. Values are kept
 * as typed (a half-filled provider/model pair, a non-integer timeout) so
 * validation can point at them; `timeoutMinutes: undefined` clears the timeout.
 * @param draft - the draft.
 * @param uid - the row.
 * @param patch - the new values.
 * @returns the edited draft.
 */
export function patchRunner(draft: Draft, uid: number, patch: RunnerPatch): Draft {
  return mapRow(draft, uid, role => {
    if (role.runner === undefined) return role
    const runner: RoleRunner = { ...role.runner }
    for (const key of ['model', 'provider', 'effort'] as const) {
      if (!(key in patch)) continue
      const value = patch[key]
      if (value === undefined || value === '') delete runner[key]
      else runner[key] = value
    }
    if (patch.permission !== undefined && patch.permission !== '') runner.permission = patch.permission
    if ('timeoutMinutes' in patch) {
      if (patch.timeoutMinutes === undefined) delete runner.timeoutMinutes
      else runner.timeoutMinutes = patch.timeoutMinutes
    }
    return JSON.stringify(canonicalRunner(runner)) === JSON.stringify(canonicalRunner(role.runner))
      ? role
      : { ...role, runner }
  })
}

/**
 * Whether a permission preset can be chosen for a role: while Read-only is on,
 * only the CLI's read-only presets can.
 * @param cli - the role's CLI.
 * @param preset - a preset id of that CLI.
 * @param readOnly - the role's Read-only switch.
 * @returns true when the preset is selectable.
 */
export function permissionAllowed(cli: CliId, preset: string, readOnly: boolean): boolean {
  const access = presetAccess(cliDescriptor(cli), preset)
  return access !== undefined && (!readOnly || access === 'read-only')
}

/**
 * Edit the plugin-level settings of one CLI. A blank executable and an empty
 * name list are removed, and so is an entry that ends up empty. The names are
 * kept as typed so validation can point at an invalid one.
 * @param draft - the draft.
 * @param cli - the CLI.
 * @param patch - `executable` and/or `envPassthrough`; a key that is present replaces the value.
 * @returns the edited draft.
 */
export function setCliSettings(draft: Draft, cli: CliId, patch: CliSettings): Draft {
  const current = draft.clis?.[cli] ?? {}
  const next: CliSettings = { ...current }
  if ('executable' in patch) {
    if (patch.executable === undefined || patch.executable.trim() === '') delete next.executable
    else next.executable = patch.executable
  }
  if ('envPassthrough' in patch) {
    if (patch.envPassthrough === undefined || patch.envPassthrough.length === 0) delete next.envPassthrough
    else next.envPassthrough = [...patch.envPassthrough]
  }
  const map: CliSettingsMap = { ...draft.clis }
  if (Object.keys(next).length === 0) delete map[cli]
  else map[cli] = next
  const clis = cloneClis(map)
  if (JSON.stringify(canonicalClis(clis)) === JSON.stringify(canonicalClis(draft.clis))) return draft
  const { clis: _previous, ...rest } = draft
  return clis === undefined || Object.keys(clis).length === 0 ? rest : { ...rest, clis }
}

/**
 * Split the forwarded-variables text into names: commas and whitespace separate them.
 * @param text - what the user typed.
 * @returns the names, without empty entries.
 */
export function parseEnvNames(text: string): string[] {
  return text.split(/[\s,]+/).filter(name => name.length > 0)
}

/**
 * Change how a role's child starts. A built-in role's context is fixed, and a CLI role
 * always starts fresh; a role that becomes a fork loses its model and agent preset,
 * which forks cannot have.
 * @param draft - the draft.
 * @param uid - the row.
 * @param context - the new context.
 * @returns the edited draft.
 */
export function setContext(draft: Draft, uid: number, context: RoleContext): Draft {
  return mapRow(draft, uid, role => {
    if (role.builtin !== undefined || role.runner !== undefined || role.context === context) return role
    if (context === 'spawn') {
      const { model: _model, agentPreset: _preset, forkScope: _scope, ...rest } = role
      return { ...rest, context }
    }
    const { model: _model, agentPreset: _preset, ...rest } = role
    return { ...rest, context, forkScope: 'full' }
  })
}

/**
 * Choose how much parent history a fork role copies. Ignored unless the role is a fork.
 * @param draft - the draft.
 * @param uid - the row.
 * @param scope - `full` copies completed turns; `task` does not.
 * @returns the edited draft.
 */
export function setForkScope(draft: Draft, uid: number, scope: ForkScope): Draft {
  return mapRow(draft, uid, role => {
    if (role.context !== 'fork' || role.forkScope === scope) return role
    return { ...role, forkScope: scope }
  })
}

/**
 * Set the child's model route; an all-empty route clears it. Ignored for fork and CLI roles.
 * A half-filled route is kept so the user can finish it; validation blocks the save.
 * @param draft - the draft.
 * @param uid - the row.
 * @param model - the route, or undefined to inherit the parent's.
 * @returns the edited draft.
 */
export function setModel(draft: Draft, uid: number, model: RoleModel | undefined): Draft {
  return mapRow(draft, uid, role => {
    if (role.context === 'fork' || role.runner !== undefined) return role
    const { model: _previous, ...rest } = role
    if (model === undefined || (model.provider === '' && model.model === '' && !model.reasoningEffort)) return rest
    const route: RoleModel = { provider: model.provider, model: model.model }
    if (model.reasoningEffort) route.reasoningEffort = model.reasoningEffort
    return { ...rest, model: route }
  })
}

/**
 * Set the agent preset the child mounts; empty clears it. Ignored for fork and CLI roles.
 * @param draft - the draft.
 * @param uid - the row.
 * @param preset - the preset id.
 * @returns the edited draft.
 */
export function setAgentPreset(draft: Draft, uid: number, preset: string | undefined): Draft {
  return mapRow(draft, uid, role => {
    if (role.context === 'fork' || role.runner !== undefined) return role
    const { agentPreset: _previous, ...rest } = role
    return preset === undefined || preset === '' ? rest : { ...rest, agentPreset: preset }
  })
}

/**
 * Move a row one place.
 * @param draft - the draft.
 * @param uid - the row.
 * @param delta - -1 for up, 1 for down.
 * @returns the edited draft; unchanged at either end.
 */
export function moveRow(draft: Draft, uid: number, delta: -1 | 1): Draft {
  const from = draft.rows.findIndex(row => row.uid === uid)
  const rows = [...draft.rows]
  const a = rows[from]
  const b = rows[from + delta]
  if (a === undefined || b === undefined) return draft
  rows[from] = b
  rows[from + delta] = a
  return { ...draft, rows }
}

/**
 * Delete a row. The two built-in roles cannot be deleted.
 * @param draft - the draft.
 * @param uid - the row.
 * @returns the edited draft.
 */
export function removeRow(draft: Draft, uid: number): Draft {
  const row = draft.rows.find(candidate => candidate.uid === uid)
  if (row === undefined || row.role.builtin !== undefined) return draft
  return { ...draft, rows: draft.rows.filter(candidate => candidate !== row) }
}

function insertRole(draft: Draft, index: number, role: RoleDefinition): Draft {
  if (draft.rows.length >= MAX_ROLES) return draft
  const rows = [...draft.rows]
  rows.splice(index, 0, { uid: draft.nextUid, role })
  return { ...draft, rows, nextUid: draft.nextUid + 1 }
}

/**
 * Whether another role fits under the limit.
 * @param draft - the draft.
 * @returns true when below `MAX_ROLES`.
 */
export function canAddRole(draft: Draft): boolean {
  return draft.rows.length < MAX_ROLES
}

/**
 * Copy a row to just below itself under a new id; the copy is never built-in.
 * A new row always receives uid `draft.nextUid`.
 * @param draft - the draft.
 * @param uid - the row to copy.
 * @returns the edited draft; unchanged at the role limit.
 */
export function duplicateRow(draft: Draft, uid: number): Draft {
  const index = draft.rows.findIndex(row => row.uid === uid)
  const source = draft.rows[index]
  if (source === undefined) return draft
  const { builtin: _builtin, ...copy } = cloneRole(source.role)
  return insertRole(draft, index + 1, { ...copy, id: uniqueId(source.role.id, idsOf(draft)) })
}

/**
 * Append an empty spawn role. A new row always receives uid `draft.nextUid`.
 * @param draft - the draft.
 * @returns the edited draft; unchanged at the role limit.
 */
export function addBlankRole(draft: Draft): Draft {
  const role: RoleDefinition = {
    id: uniqueId('role', idsOf(draft)),
    enabled: true,
    description: '',
    instructions: '',
    context: 'spawn',
    readOnly: false,
  }
  return insertRole(draft, draft.rows.length, role)
}

/** The ready-made roles offered by "Add from template": the non-built-in default roles. */
export function templates(): readonly RoleDefinition[] {
  return DEFAULT_ROLES.filter(role => role.builtin === undefined)
}

/**
 * Append a copy of a template under an unused id. A new row always receives uid `draft.nextUid`.
 * @param draft - the draft.
 * @param templateId - the template's id.
 * @returns the edited draft; unchanged for an unknown template or at the role limit.
 */
export function addTemplateRole(draft: Draft, templateId: string): Draft {
  const template = templates().find(role => role.id === templateId)
  if (template === undefined) return draft
  return insertRole(draft, draft.rows.length, { ...cloneRole(template), id: uniqueId(template.id, idsOf(draft)) })
}

/** Which field of a role an issue belongs to. */
export type IssueField =
  | 'id'
  | 'description'
  | 'instructions'
  | 'model'
  | 'preset'
  /** Runs on (the runner as a whole). */
  | 'runner'
  /** The runner's provider and model. */
  | 'runnerModel'
  | 'effort'
  | 'permission'
  | 'timeout'
  /** A CLI's executable (External CLIs section). */
  | 'executable'
  /** A CLI's forwarded variable names (External CLIs section). */
  | 'env'

/** One reason the draft cannot be saved as typed. */
export interface Issue {
  readonly code: SettingsProblem['code']
  /** The row the issue belongs to, when it belongs to one. */
  readonly uid?: number
  /** The role id as typed. */
  readonly roleId?: string
  readonly field?: IssueField
  /** The CLI involved: the row's runner, or the External CLIs card. */
  readonly cli?: CliId
}

const FIELD_OF: Partial<Record<SettingsProblem['code'], IssueField>> = {
  'invalid-id': 'id',
  'duplicate-id': 'id',
  'description-too-long': 'description',
  'instructions-too-long': 'instructions',
  'invalid-model': 'model',
  'invalid-workflow-model': 'model',
  'fork-model-ignored': 'model',
  'invalid-preset': 'preset',
  'fork-preset-ignored': 'preset',
  'builtin-runner-ignored': 'runner',
  'invalid-runner': 'runner',
  'runner-context-forced': 'runner',
  'runner-model-ignored': 'runner',
  'runner-preset-ignored': 'runner',
  'invalid-runner-model': 'runnerModel',
  'invalid-runner-effort': 'effort',
  'invalid-runner-permission': 'permission',
  'runner-readonly-permission': 'permission',
  'invalid-runner-timeout': 'timeout',
}

/** The `clis` problems of one card field, found by normalizing that field alone. */
function cliIssues(clis: CliSettingsMap | undefined): Issue[] {
  const issues: Issue[] = []
  for (const cli of CLI_IDS) {
    const entry = clis?.[cli]
    if (entry === undefined) continue
    const fields = [
      ['executable', { executable: entry.executable }],
      ['env', { envPassthrough: entry.envPassthrough }],
    ] as const
    for (const [field, value] of fields) {
      let bad = false
      normalizeClis({ [cli]: value }, () => {
        bad = true
      })
      if (bad) issues.push({ code: 'invalid-cli-settings', field, cli })
    }
  }
  return issues
}

/** Settings as they would be stored, and every reason the draft cannot be saved as typed. */
export interface Analysis {
  readonly settings: RoleSettings
  readonly issues: readonly Issue[]
}

/**
 * Normalize the draft with the shared contract. Every problem it reports would
 * drop or change something the user typed, so any issue blocks the save.
 * @param draft - the draft.
 * @returns the normalized settings to write when `issues` is empty, and the issues.
 */
export function analyseDraft(draft: Draft): Analysis {
  const { settings, problems } = normalizeSettings(draftSettings(draft))
  const issues: Issue[] = []
  for (const problem of problems) {
    // Reported per card and field below, where the user can fix them.
    if (problem.code === 'invalid-cli-settings') continue
    let index = problem.index
    const row = index === undefined ? undefined : draft.rows[index]
    if (problem.code === 'duplicate-id' && row !== undefined && row.role.builtin !== undefined) {
      // A custom role placed above a built-in with its id would be blamed on the built-in; blame the custom role.
      const custom = draft.rows.findIndex(other => other.role.builtin === undefined && other.role.id === row.role.id)
      if (custom >= 0) index = custom
    }
    const field = FIELD_OF[problem.code]
    const owner = index === undefined ? undefined : draft.rows[index]
    const cli = isCliId(owner?.role.runner?.cli) ? owner?.role.runner?.cli : undefined
    issues.push({
      code: problem.code,
      ...(owner === undefined ? {} : { uid: owner.uid, roleId: owner.role.id }),
      ...(owner === undefined && problem.id !== undefined ? { roleId: problem.id } : {}),
      ...(field === undefined ? {} : { field }),
      ...(cli === undefined ? {} : { cli }),
    })
  }
  issues.push(...cliIssues(draft.clis))
  // A built-in shadowed by a custom role is already reported as that role's duplicate id.
  const shadowed = (issue: Issue): boolean =>
    issue.code === 'builtin-missing' && issues.some(o => o.code === 'duplicate-id' && o.roleId === issue.roleId)
  return { settings, issues: issues.filter(issue => !shadowed(issue)) }
}

/** Text a field is limited to, for the "characters left" counter. */
export const FIELD_LIMITS = { description: MAX_DESCRIPTION_LENGTH, instructions: MAX_INSTRUCTIONS_LENGTH } as const

export { FORK_NOTE } from '../shared/roles.ts'

/**
 * The line the parent model reads for this role in the delegation tool description.
 * @param role - the role.
 * @returns the shared tool-description line, so preview and Host never drift.
 */
export function parentLine(role: RoleDefinition): string {
  return roleListLine(role)
}

/**
 * The runtime context the child receives for this role.
 * @param role - the role.
 * @returns the paragraph, or '' when the role adds nothing.
 */
export function childText(role: RoleDefinition): string {
  return roleContextText(role)
}

/**
 * Short text for a model route.
 * @param model - the route.
 * @returns `provider / model` with the effort, or undefined for the parent's model.
 */
export function routeLabel(model: RoleModel | undefined): string | undefined {
  if (model === undefined) return undefined
  const route = `${model.provider} / ${model.model}`
  return model.reasoningEffort ? `${route} · ${model.reasoningEffort}` : route
}

/**
 * Short text for a runner's model.
 * @param runner - the runner.
 * @returns `model` (OpenCode: `provider/model`) with the effort, or undefined for the CLI's default model.
 */
export function runnerModelLabel(runner: RoleRunner): string | undefined {
  const model =
    runner.provider !== undefined && runner.model !== undefined
      ? `${runner.provider}/${runner.model}`
      : (runner.model ?? runner.provider)
  if (model === undefined) return undefined
  return runner.effort ? `${model} · ${runner.effort}` : model
}
