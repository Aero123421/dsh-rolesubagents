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

import {
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
  type RoleSettings,
  roleContextText,
  roleListLine,
  type SettingsProblem,
} from '../shared/roles.ts'

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
  return { ...role, ...(role.model === undefined ? {} : { model: { ...role.model } }) }
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
    rows: settings.roles.map((role, index) => ({ uid: index + 1, role: cloneRole(role) })),
    base: { enabled: settings.enabled, roles: settings.roles.map(cloneRole) },
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
  return { enabled: draft.enabled, roles: draft.rows.map(row => row.role) }
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
    a.roles.length === b.roles.length &&
    JSON.stringify(a.roles.map(canonical)) === JSON.stringify(b.roles.map(canonical))
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
    return { ...role, ...rest, ...(id === undefined || role.builtin !== undefined ? {} : { id }) }
  })
}

/**
 * Change how a role's child starts. A built-in role's context is fixed; a role that
 * becomes a fork loses its model and agent preset, which forks cannot have.
 * @param draft - the draft.
 * @param uid - the row.
 * @param context - the new context.
 * @returns the edited draft.
 */
export function setContext(draft: Draft, uid: number, context: RoleContext): Draft {
  return mapRow(draft, uid, role => {
    if (role.builtin !== undefined || role.context === context) return role
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
 * Set the child's model route; an all-empty route clears it. Ignored for fork roles.
 * A half-filled route is kept so the user can finish it; validation blocks the save.
 * @param draft - the draft.
 * @param uid - the row.
 * @param model - the route, or undefined to inherit the parent's.
 * @returns the edited draft.
 */
export function setModel(draft: Draft, uid: number, model: RoleModel | undefined): Draft {
  return mapRow(draft, uid, role => {
    if (role.context === 'fork') return role
    const { model: _previous, ...rest } = role
    if (model === undefined || (model.provider === '' && model.model === '' && !model.reasoningEffort)) return rest
    const route: RoleModel = { provider: model.provider, model: model.model }
    if (model.reasoningEffort) route.reasoningEffort = model.reasoningEffort
    return { ...rest, model: route }
  })
}

/**
 * Set the agent preset the child mounts; empty clears it. Ignored for fork roles.
 * @param draft - the draft.
 * @param uid - the row.
 * @param preset - the preset id.
 * @returns the edited draft.
 */
export function setAgentPreset(draft: Draft, uid: number, preset: string | undefined): Draft {
  return mapRow(draft, uid, role => {
    if (role.context === 'fork') return role
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
export type IssueField = 'id' | 'description' | 'instructions' | 'model' | 'preset'

/** One reason the draft cannot be saved as typed. */
export interface Issue {
  readonly code: SettingsProblem['code']
  /** The row the issue belongs to, when it belongs to one. */
  readonly uid?: number
  /** The role id as typed. */
  readonly roleId?: string
  readonly field?: IssueField
}

const FIELD_OF: Partial<Record<SettingsProblem['code'], IssueField>> = {
  'invalid-id': 'id',
  'duplicate-id': 'id',
  'description-too-long': 'description',
  'instructions-too-long': 'instructions',
  'invalid-model': 'model',
  'fork-model-ignored': 'model',
  'invalid-preset': 'preset',
  'fork-preset-ignored': 'preset',
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
    let index = problem.index
    const row = index === undefined ? undefined : draft.rows[index]
    if (problem.code === 'duplicate-id' && row !== undefined && row.role.builtin !== undefined) {
      // A custom role placed above a built-in with its id would be blamed on the built-in; blame the custom role.
      const custom = draft.rows.findIndex(other => other.role.builtin === undefined && other.role.id === row.role.id)
      if (custom >= 0) index = custom
    }
    const field = FIELD_OF[problem.code]
    const owner = index === undefined ? undefined : draft.rows[index]
    issues.push({
      code: problem.code,
      ...(owner === undefined ? {} : { uid: owner.uid, roleId: owner.role.id }),
      ...(owner === undefined && problem.id !== undefined ? { roleId: problem.id } : {}),
      ...(field === undefined ? {} : { field }),
    })
  }
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
