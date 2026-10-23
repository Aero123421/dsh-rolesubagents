/** Pure, strict role changes shared by management tools and raw-backed settings editing. */
import { ACCESS_ORDER, type AccessLevel, cliDescriptor, isCliId, presetAccess } from './cli/index.ts'
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_INSTRUCTIONS_LENGTH,
  MAX_NAME_LENGTH,
  MAX_ROLES,
  normalizeSettings,
  ROLE_ID_PATTERN,
  type RoleDefinition,
  type SettingsProblem,
} from './roles.ts'
import { MAX_RUNNER_TIMEOUT_MINUTES, RUNNER_NAME_PATTERN } from './runner.ts'

export type RoleChange =
  | { op: 'create'; role: unknown }
  | { op: 'update'; id: string; patch: unknown }
  | { op: 'delete'; id: string }

export interface RoleManagementIssue {
  readonly code: string
  readonly id?: string
  readonly field?: string
}

const MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  'settings-repair-needed': 'Stored role settings need repair before they can be changed.',
  'invalid-changes': 'The role change batch is invalid.',
  'too-many-changes': 'At most sixteen role changes are allowed in one batch.',
  'duplicate-operation': 'A role may be changed only once in one batch.',
  'unknown-field': 'The request contains an unsupported field.',
  'invalid-role': 'The requested role settings are invalid.',
  'role-exists': 'A role with that id already exists.',
  'role-not-found': 'The requested role does not exist.',
  'builtin-protected': 'Built-in role identity and existence cannot be changed.',
  'agent-preset-forbidden': 'Agent presets may only be preserved or explicitly cleared.',
  'permission-ceiling': 'The requested CLI permission exceeds the caller access ceiling.',
  'read-only': 'Read-only callers cannot change role settings.',
  'invalid-ceiling': 'The caller access ceiling is invalid.',
  'too-many-roles': 'The role limit would be exceeded.',
  'invalid-origins': 'The role origin mapping is invalid.',
})

/** Errors contain only fixed messages and bounded identifiers, never raw settings or normalizer messages. */
export class RoleManagementError extends Error {
  readonly code: string
  readonly issues?: readonly RoleManagementIssue[]

  constructor(code: string, issues?: readonly RoleManagementIssue[]) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'invalid-role'
    super(MESSAGES[safeCode])
    this.name = 'RoleManagementError'
    this.code = safeCode
    if (issues !== undefined) {
      this.issues = issues.map(issue => ({
        code: /^[a-z][a-z0-9-]{0,63}$/.test(issue.code) ? issue.code : 'invalid-role',
        ...(typeof issue.id === 'string' && ROLE_ID_PATTERN.test(issue.id) ? { id: issue.id } : {}),
        ...(typeof issue.field === 'string' && /^[a-zA-Z][a-zA-Z0-9.]{0,63}$/.test(issue.field)
          ? { field: issue.field }
          : {}),
      }))
    }
  }
}

type Raw = Record<string, unknown>
const ROLE_FIELDS = [
  'id',
  'enabled',
  'builtin',
  'description',
  'instructions',
  'context',
  'forkScope',
  'model',
  'agentPreset',
  'readOnly',
  'runner',
] as const
const MODEL_FIELDS = ['provider', 'model', 'reasoningEffort'] as const
const RUNNER_FIELDS = ['cli', 'model', 'provider', 'effort', 'permission', 'timeoutMinutes'] as const
const CREATE_FIELDS = ROLE_FIELDS.filter(field => field !== 'builtin')
const PATCH_FIELDS = ROLE_FIELDS.filter(field => field !== 'id' && field !== 'builtin')
const RESERVED_IDS = new Set(['general', 'fork'])

function plainRecord(value: unknown): value is Raw {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** JSON-shaped records only; do not invoke accessors while examining supposedly inert configuration. */
function record(value: unknown): value is Raw {
  return (
    plainRecord(value) &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => 'value' in descriptor)
  )
}

function fail(code: string, field?: string, id?: string): never {
  throw new RoleManagementError(code, [
    { code, ...(id === undefined ? {} : { id }), ...(field === undefined ? {} : { field }) },
  ])
}

function keys(value: Raw, allowed: readonly string[], field: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('unknown-field', field)
}

function identifier(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || !ROLE_ID_PATTERN.test(value)) fail('invalid-role', field)
  return value
}

function routeName(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_NAME_LENGTH &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

function runnerName(value: unknown): boolean {
  return typeof value === 'string' && RUNNER_NAME_PATTERN.test(value)
}

function validateModel(value: unknown, strict: boolean): Raw {
  if (!record(value)) fail('invalid-role', 'model')
  if (strict) keys(value, MODEL_FIELDS, 'model')
  if (!routeName(value.provider) || !routeName(value.model)) fail('invalid-role', 'model')
  if (Object.hasOwn(value, 'reasoningEffort') && !routeName(value.reasoningEffort)) fail('invalid-role', 'model')
  return value
}

function validateRunner(value: unknown, strict: boolean, defaults: boolean): Raw {
  if (!record(value)) fail('invalid-role', 'runner')
  if (strict) keys(value, RUNNER_FIELDS, 'runner')
  if (!isCliId(value.cli)) fail('invalid-role', 'runner')
  const descriptor = cliDescriptor(value.cli)
  const permission = !Object.hasOwn(value, 'permission') && defaults ? descriptor.defaultPermission : value.permission
  if (typeof permission !== 'string' || presetAccess(descriptor, permission) === undefined)
    fail('invalid-role', 'runner')
  for (const field of ['model', 'provider', 'effort'] as const) {
    if (Object.hasOwn(value, field) && !runnerName(value[field])) fail('invalid-role', 'runner')
  }
  if (
    Object.hasOwn(value, 'timeoutMinutes') &&
    (typeof value.timeoutMinutes !== 'number' ||
      !Number.isInteger(value.timeoutMinutes) ||
      value.timeoutMinutes < 1 ||
      value.timeoutMinutes > MAX_RUNNER_TIMEOUT_MINUTES)
  )
    fail('invalid-role', 'runner')
  return { ...value, permission }
}

/** Primitive integrity checks cover silent normalizer defaults; absent optional/defaulted stored fields are valid. */
function validateStoredRole(value: unknown): asserts value is Raw {
  if (!record(value)) fail('invalid-role', 'role')
  identifier(value.id)
  if (
    Object.hasOwn(value, 'builtin') &&
    (typeof value.builtin !== 'string' || !RESERVED_IDS.has(value.builtin) || value.id !== value.builtin)
  )
    fail('invalid-role', 'builtin')
  for (const field of ['enabled', 'readOnly'] as const) {
    if (Object.hasOwn(value, field) && typeof value[field] !== 'boolean') fail('invalid-role', field)
  }
  for (const [field, maximum] of [
    ['description', MAX_DESCRIPTION_LENGTH],
    ['instructions', MAX_INSTRUCTIONS_LENGTH],
  ] as const) {
    if (Object.hasOwn(value, field) && (typeof value[field] !== 'string' || value[field].length > maximum))
      fail('invalid-role', field)
  }
  if (Object.hasOwn(value, 'context') && value.context !== 'spawn' && value.context !== 'fork')
    fail('invalid-role', 'context')
  if (
    value.forkScope !== undefined &&
    value.forkScope !== null &&
    value.forkScope !== 'full' &&
    value.forkScope !== 'task'
  )
    fail('invalid-role', 'forkScope')
  if (value.model !== undefined && value.model !== null) validateModel(value.model, false)
  if (value.runner !== undefined && value.runner !== null) validateRunner(value.runner, false, false)
  if (value.agentPreset !== undefined && value.agentPreset !== null && !routeName(value.agentPreset))
    fail('invalid-role', 'agentPreset')
}

function issueProjection(problems: readonly SettingsProblem[]): RoleManagementIssue[] {
  return problems.map(problem => ({ code: problem.code, ...(problem.id === undefined ? {} : { id: problem.id }) }))
}

function normalized(rawRoles: readonly unknown[], stored: boolean): RoleDefinition[] {
  try {
    if (rawRoles.length > MAX_ROLES) throw new RoleManagementError(stored ? 'settings-repair-needed' : 'too-many-roles')
    for (const role of rawRoles) validateStoredRole(role)
    const result = normalizeSettings({ enabled: true, roles: rawRoles })
    if (result.problems.length)
      throw new RoleManagementError(
        stored ? 'settings-repair-needed' : 'invalid-role',
        issueProjection(result.problems),
      )
    return result.settings.roles
  } catch (error) {
    if (error instanceof RoleManagementError) {
      if (!stored) throw error
      throw new RoleManagementError('settings-repair-needed', error.issues)
    }
    throw new RoleManagementError(stored ? 'settings-repair-needed' : 'invalid-role')
  }
}

function equal(left: unknown, right: unknown): boolean {
  // These values are known role projections, never arbitrary unknown stored fields.
  return JSON.stringify(left) === JSON.stringify(right)
}

function unknownFields(raw: unknown, known: readonly string[]): Raw {
  return record(raw) ? Object.fromEntries(Object.entries(raw).filter(([key]) => !known.includes(key))) : {}
}

/** Known nested objects are replacements; only the old object's opaque keys are retained. */
function mergedRole(raw: Raw | undefined, role: RoleDefinition): Raw {
  const known = Object.fromEntries(ROLE_FIELDS.filter(key => Object.hasOwn(role, key)).map(key => [key, role[key]]))
  return {
    ...unknownFields(raw, ROLE_FIELDS),
    ...known,
    ...(role.model === undefined ? {} : { model: { ...unknownFields(raw?.model, MODEL_FIELDS), ...role.model } }),
    ...(role.runner === undefined ? {} : { runner: { ...unknownFields(raw?.runner, RUNNER_FIELDS), ...role.runner } }),
  }
}

/**
 * Mirror normalizeSettings' row admission and final cap trimming, without reading role contents or
 * nested values. Effective ids (builtin overrides id) identify the first selected raw row, not a
 * discarded duplicate. Restored builtins deliberately have no raw origin.
 */
function eligibleRawRoleSources(rawRoles: unknown): Map<string, Raw> {
  if (!Array.isArray(rawRoles)) return new Map()
  const selected: { id: string; builtin?: 'general' | 'fork'; raw?: Raw }[] = []
  const seen = new Set<string>()
  const builtins = new Set<string>()
  for (const raw of rawRoles) {
    if (selected.length >= MAX_ROLES) break
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    // Non-JSON prototype/selector accessors make row admission unknowable; never guess an opaque origin.
    if (!plainRecord(raw)) return new Map()
    const marker = Object.getOwnPropertyDescriptor(raw, 'builtin')
    if (marker && !('value' in marker)) return new Map()
    const markerValue: unknown = marker?.value
    const builtin = markerValue === 'general' || markerValue === 'fork' ? markerValue : undefined
    if (builtin !== undefined && builtins.has(builtin)) continue
    const idField = Object.getOwnPropertyDescriptor(raw, 'id')
    if (builtin === undefined && idField && !('value' in idField)) return new Map()
    const rawId: unknown = idField?.value
    const id = builtin ?? (typeof rawId === 'string' ? rawId : '')
    if (!ROLE_ID_PATTERN.test(id) || seen.has(id)) continue
    seen.add(id)
    if (builtin !== undefined) builtins.add(builtin)
    selected.push({ id, ...(builtin === undefined ? {} : { builtin }), ...(record(raw) ? { raw } : {}) })
  }
  for (const builtin of ['general', 'fork'] as const) {
    if (builtins.has(builtin) || seen.has(builtin)) continue
    selected.splice(builtin === 'general' ? 0 : Math.min(1, selected.length), 0, { id: builtin, builtin })
  }
  while (selected.length > MAX_ROLES) {
    const index = selected.findLastIndex(item => item.builtin === undefined)
    if (index < 0) break
    selected.splice(index, 1)
  }
  return new Map(selected.flatMap(item => (item.raw === undefined ? [] : [[item.id, item.raw] as const])))
}

/** Source ids safe for an accepted UI normalization repair; not authorization for management mutations. */
export function eligibleRawRoleSourceIds(rawRoles: unknown): readonly string[] {
  try {
    return [...eligibleRawRoleSources(rawRoles).keys()]
  } catch {
    return []
  }
}

/**
 * Merge a validated known UI projection without dropping opaque stored metadata. An optional origin maps
 * a target id to its prior id for renames. Omitted origins defaults to id matching; an explicit empty list
 * means no metadata inheritance (including delete/recreate with the same id). Unmapped new rows have no opaque data.
 * This helper is a serializer, not management authorization: the tool path additionally applies strict commands/ceilings.
 */
export function mergeKnownRoles(
  rawRoles: unknown,
  roles: readonly RoleDefinition[],
  origins?: readonly { id: string; sourceId: string }[],
): unknown[] {
  try {
    if (!Array.isArray(rawRoles)) throw new RoleManagementError('settings-repair-needed')
    if (origins !== undefined && !Array.isArray(origins)) throw new RoleManagementError('invalid-origins')
    const projected = normalized(roles, false)
    const byId = eligibleRawRoleSources(rawRoles)
    const originIds = new Map<string, string>()
    const targetIds = new Set(projected.map(role => role.id))
    for (const origin of origins ?? []) {
      if (
        !record(origin) ||
        Object.keys(origin).some(key => key !== 'id' && key !== 'sourceId') ||
        typeof origin.id !== 'string' ||
        !targetIds.has(origin.id) ||
        typeof origin.sourceId !== 'string' ||
        !ROLE_ID_PATTERN.test(origin.sourceId) ||
        originIds.has(origin.id) ||
        !byId.has(origin.sourceId)
      )
        throw new RoleManagementError('invalid-origins')
      originIds.set(origin.id, origin.sourceId)
    }
    return projected.map(role => {
      const sourceId = origins === undefined ? role.id : originIds.get(role.id)
      const raw = sourceId === undefined ? undefined : byId.get(sourceId)
      // Preserve exact raw object identity when the known projection already matches.
      if (raw !== undefined) {
        let prior: RoleDefinition | undefined
        try {
          validateStoredRole(raw)
          const single = normalizeSettings({ enabled: true, roles: [raw] })
          // Missing other builtins is an artifact of this one-row projection; a reported repair on
          // the source row itself must be serialized canonically rather than retaining invalid raw fields.
          if (!single.problems.some(problem => problem.index === 0))
            prior = single.settings.roles.find(entry => entry.id === role.id)
        } catch {
          // A UI repair may replace an invalid old row; do not evaluate unsafe nested accessors for identity checks.
        }
        if (sourceId === role.id && equal(prior, role)) return raw
      }
      return mergedRole(raw, role)
    })
  } catch (error) {
    if (error instanceof RoleManagementError) throw error
    throw new RoleManagementError('invalid-role')
  }
}

function createdRole(value: unknown): Raw {
  if (!record(value)) fail('invalid-role', 'role')
  keys(value, CREATE_FIELDS, 'role')
  const id = identifier(value.id)
  if (RESERVED_IDS.has(id)) fail('builtin-protected', 'id', id)
  if (Object.hasOwn(value, 'agentPreset')) fail('agent-preset-forbidden', 'agentPreset', id)
  if (!Object.hasOwn(value, 'description') || typeof value.description !== 'string')
    fail('invalid-role', 'description', id)
  const role: Raw = { enabled: true, instructions: '', context: 'spawn', readOnly: false, ...value }
  validateRequestFields(role)
  for (const key of ['model', 'runner', 'forkScope'] as const) if (role[key] === null) delete role[key]
  if (Object.hasOwn(role, 'model')) role.model = validateModel(role.model, true)
  if (Object.hasOwn(role, 'runner')) role.runner = validateRunner(role.runner, true, true)
  return role
}

function validateRequestFields(value: Raw): void {
  for (const field of ['enabled', 'readOnly'] as const) {
    if (Object.hasOwn(value, field) && typeof value[field] !== 'boolean') fail('invalid-role', field)
  }
  for (const [field, maximum] of [
    ['description', MAX_DESCRIPTION_LENGTH],
    ['instructions', MAX_INSTRUCTIONS_LENGTH],
  ] as const) {
    if (Object.hasOwn(value, field) && (typeof value[field] !== 'string' || value[field].length > maximum))
      fail('invalid-role', field)
  }
  if (Object.hasOwn(value, 'context') && value.context !== 'spawn' && value.context !== 'fork')
    fail('invalid-role', 'context')
  if (
    Object.hasOwn(value, 'forkScope') &&
    value.forkScope !== null &&
    value.forkScope !== 'full' &&
    value.forkScope !== 'task'
  )
    fail('invalid-role', 'forkScope')
}

function updatedRole(raw: Raw, value: unknown): Raw {
  if (!record(value)) fail('invalid-role', 'patch')
  keys(value, PATCH_FIELDS, 'patch')
  validateRequestFields(value)
  if (Object.hasOwn(value, 'agentPreset') && value.agentPreset !== null) fail('agent-preset-forbidden', 'agentPreset')
  const result = { ...raw }
  for (const key of PATCH_FIELDS) {
    if (!Object.hasOwn(value, key)) continue
    const next = value[key]
    if (next === null && ['model', 'runner', 'forkScope', 'agentPreset'].includes(key)) delete result[key]
    else if (key === 'model') result.model = { ...unknownFields(raw.model, MODEL_FIELDS), ...validateModel(next, true) }
    else if (key === 'runner')
      result.runner = { ...unknownFields(raw.runner, RUNNER_FIELDS), ...validateRunner(next, true, true) }
    else result[key] = next
  }
  return result
}

export interface RoleChangeDiff {
  readonly op: RoleChange['op']
  readonly id: string
  readonly before?: RoleDefinition
  readonly after?: RoleDefinition
  /** Known top-level role fields only; model and runner represent nested replacement operations. */
  readonly fields: readonly string[]
}

/** Preview an immutable, roles-only mutation. It never persists settings or performs discovery/execution. */
export function previewRoleChanges(
  rawValue: unknown,
  changes: readonly RoleChange[],
  ceiling: AccessLevel,
): { rawRoles: readonly unknown[]; roles: readonly RoleDefinition[]; diff: readonly RoleChangeDiff[] } {
  try {
    if (!plainRecord(rawValue)) throw new RoleManagementError('settings-repair-needed')
    const rolesField = Object.getOwnPropertyDescriptor(rawValue, 'roles')
    if (!rolesField || !('value' in rolesField) || !Array.isArray(rolesField.value))
      throw new RoleManagementError('settings-repair-needed')
    const original = rolesField.value as readonly unknown[]
    const before = normalized(original, true)
    if (!Array.isArray(changes)) fail('invalid-changes', 'changes')
    if (changes.length > 16) fail('too-many-changes', 'changes')
    if (typeof ceiling !== 'string' || !Object.hasOwn(ACCESS_ORDER, ceiling)) fail('invalid-ceiling')
    if (ceiling === 'read-only' && changes.length) fail('read-only')
    const touched = new Set<string>()
    let candidate = [...original]
    const operations: { op: RoleChange['op']; id: string }[] = []
    for (const change of changes) {
      if (!record(change)) fail('invalid-changes', 'change')
      if (change.op !== 'create' && change.op !== 'update' && change.op !== 'delete') fail('invalid-changes', 'change')
      keys(
        change,
        change.op === 'create' ? ['op', 'role'] : change.op === 'update' ? ['op', 'id', 'patch'] : ['op', 'id'],
        'change',
      )
      const next = change.op === 'create' ? createdRole(change.role) : undefined
      const id = next === undefined ? identifier(change.id) : identifier(next.id)
      if (touched.has(id)) fail('duplicate-operation', 'id', id)
      touched.add(id)
      const index = candidate.findIndex(role => record(role) && role.id === id)
      if (change.op === 'create') {
        if (index !== -1) fail('role-exists', 'id', id)
        candidate.push(next)
      } else {
        if (index === -1) fail('role-not-found', 'id', id)
        const raw = candidate[index] as Raw
        if (change.op === 'delete') {
          if (raw.builtin !== undefined || RESERVED_IDS.has(id)) fail('builtin-protected', 'id', id)
          candidate = candidate.filter((_, at) => at !== index)
        } else candidate[index] = updatedRole(raw, change.patch)
      }
      operations.push({ op: change.op, id })
    }
    if (candidate.length > MAX_ROLES) fail('too-many-roles')
    const roles = normalized(candidate, false)
    const oldById = new Map(before.map(role => [role.id, role]))
    const newById = new Map(roles.map(role => [role.id, role]))
    const originalById = new Map(before.map((role, index) => [role.id, original[index]]))
    const diff: RoleChangeDiff[] = []
    for (const { op, id } of operations) {
      const prior = oldById.get(id)
      const after = newById.get(id)
      const fields = ROLE_FIELDS.filter(field => !equal(prior?.[field], after?.[field]))
      if (!fields.length) continue
      if (after?.runner) {
        const descriptor = cliDescriptor(after.runner.cli)
        const access = presetAccess(descriptor, after.runner.permission)
        if (access === undefined || ACCESS_ORDER[access] > ACCESS_ORDER[ceiling])
          fail('permission-ceiling', 'runner', id)
        if (after.readOnly && access !== 'read-only') fail('invalid-role', 'runner', id)
        if (descriptor.needsProvider && (!after.runner.model || !after.runner.provider))
          fail('invalid-role', 'runner', id)
      }
      diff.push({
        op,
        id,
        ...(prior === undefined ? {} : { before: prior }),
        ...(after === undefined ? {} : { after }),
        fields,
      })
    }
    // A semantically unchanged patch must not rewrite/default otherwise untouched raw fields.
    const changedIds = new Set(diff.map(item => item.id))
    const rawRoles = candidate.map(raw => {
      const id = (raw as Raw).id as string
      return !changedIds.has(id) && originalById.has(id) ? originalById.get(id) : raw
    })
    return { rawRoles, roles, diff }
  } catch (error) {
    if (error instanceof RoleManagementError) throw error
    throw new RoleManagementError('invalid-role')
  }
}
