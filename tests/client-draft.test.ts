import { describe, expect, it } from 'vitest'
import {
  addBlankRole,
  addTemplateRole,
  analyseDraft,
  canAddRole,
  childText,
  createDraft,
  type Draft,
  draftSettings,
  duplicateRow,
  FORK_NOTE,
  isDirty,
  moveRow,
  parentLine,
  patchRole,
  removeRow,
  routeLabel,
  sameSettings,
  setAgentPreset,
  setContext,
  setEnabled,
  setModel,
  templates,
  uniqueId,
} from '../src/client/draft.ts'
import {
  DEFAULT_ROLES,
  MAX_DESCRIPTION_LENGTH,
  MAX_INSTRUCTIONS_LENGTH,
  MAX_ROLES,
  normalizeSettings,
  type RoleDefinition,
} from '../src/shared/roles.ts'

const defaults = () => normalizeSettings(undefined).settings
const fresh = (): Draft => createDraft(defaults(), 7)
const idsOf = (draft: Draft): string[] => draft.rows.map(row => row.role.id)
const roleOf = (draft: Draft, uid: number): RoleDefinition => {
  const row = draft.rows.find(candidate => candidate.uid === uid)
  if (row === undefined) throw new Error(`no uid ${uid}`)
  return row.role
}

describe('createDraft', () => {
  it('holds every role in order under stable uids and starts clean', () => {
    const draft = fresh()
    expect(idsOf(draft)).toEqual(['general', 'fork', 'worker', 'explorer', 'reviewer'])
    expect(draft.rows.map(row => row.uid)).toEqual([1, 2, 3, 4, 5])
    expect(draft.nextUid).toBe(6)
    expect(draft.revision).toBe(7)
    expect(isDirty(draft)).toBe(false)
  })

  it('never writes through to the shared default roles', () => {
    const draft = patchRole(fresh(), 3, { description: 'changed', enabled: false })
    expect(roleOf(draft, 3).description).toBe('changed')
    expect(DEFAULT_ROLES.find(role => role.id === 'worker')?.description).not.toBe('changed')
  })
})

describe('dirty tracking', () => {
  it('is dirty after an edit and clean again when the edit is reverted', () => {
    const edited = patchRole(fresh(), 3, { description: 'x' })
    expect(isDirty(edited)).toBe(true)
    expect(isDirty(patchRole(edited, 3, { description: roleOf(fresh(), 3).description }))).toBe(false)
    expect(isDirty(setEnabled(fresh(), false))).toBe(true)
  })

  it('compares settings by value, not by key order', () => {
    const a = defaults()
    const worker = a.roles[2]
    if (worker === undefined) throw new Error('missing worker')
    const reordered = {
      enabled: a.enabled,
      roles: [
        ...a.roles.slice(0, 2),
        Object.fromEntries(Object.entries(worker).reverse()) as RoleDefinition,
        ...a.roles.slice(3),
      ],
    }
    expect(sameSettings(a, reordered)).toBe(true)
    expect(sameSettings(a, { ...a, roles: a.roles.slice(1) })).toBe(false)
  })
})

describe('role edits', () => {
  it('keeps the id of a built-in role and changes the id of a custom one', () => {
    const draft = fresh()
    expect(roleOf(patchRole(draft, 1, { id: 'renamed' }), 1).id).toBe('general')
    expect(roleOf(patchRole(draft, 3, { id: 'builder' }), 3).id).toBe('builder')
  })

  it('fixes the context of built-in roles', () => {
    const draft = fresh()
    expect(setContext(draft, 1, 'fork')).toBe(draft)
    expect(setContext(draft, 2, 'spawn')).toBe(draft)
  })

  it('clears the model and preset of a role that becomes a fork, and does not bring them back', () => {
    let draft = fresh()
    draft = setModel(draft, 3, { provider: 'p', model: 'm', reasoningEffort: 'high' })
    draft = setAgentPreset(draft, 3, 'ptc')
    draft = setContext(draft, 3, 'fork')
    expect(roleOf(draft, 3)).toMatchObject({ context: 'fork' })
    expect(roleOf(draft, 3).model).toBeUndefined()
    expect(roleOf(draft, 3).agentPreset).toBeUndefined()
    draft = setContext(draft, 3, 'spawn')
    expect(roleOf(draft, 3).model).toBeUndefined()
    expect(roleOf(draft, 3).agentPreset).toBeUndefined()
  })

  it('refuses a model or preset on a fork role', () => {
    const draft = fresh()
    expect(setModel(draft, 2, { provider: 'p', model: 'm' })).toBe(draft)
    expect(setAgentPreset(draft, 2, 'ptc')).toBe(draft)
  })

  it('treats an all-empty route as no route, keeps a half-filled one, and omits an empty effort', () => {
    let draft = setModel(fresh(), 3, { provider: 'p', model: '' })
    expect(roleOf(draft, 3).model).toEqual({ provider: 'p', model: '' })
    draft = setModel(draft, 3, { provider: 'p', model: 'm', reasoningEffort: '' })
    expect(roleOf(draft, 3).model).toEqual({ provider: 'p', model: 'm' })
    draft = setModel(draft, 3, { provider: '', model: '' })
    expect(roleOf(draft, 3).model).toBeUndefined()
    draft = setModel(setModel(draft, 3, { provider: 'p', model: 'm' }), 3, undefined)
    expect(roleOf(draft, 3).model).toBeUndefined()
  })

  it('sets and clears the agent preset', () => {
    let draft = setAgentPreset(fresh(), 3, 'ptc')
    expect(roleOf(draft, 3).agentPreset).toBe('ptc')
    draft = setAgentPreset(draft, 3, '')
    expect(roleOf(draft, 3).agentPreset).toBeUndefined()
  })
})

describe('structure edits', () => {
  it('moves a row one place and stops at the ends', () => {
    const draft = fresh()
    expect(idsOf(moveRow(draft, 3, -1)).slice(0, 3)).toEqual(['general', 'worker', 'fork'])
    expect(idsOf(moveRow(draft, 3, 1)).slice(2, 5)).toEqual(['explorer', 'worker', 'reviewer'])
    expect(moveRow(draft, 1, -1)).toBe(draft)
    expect(moveRow(draft, 5, 1)).toBe(draft)
  })

  it('deletes custom roles but never the built-in ones', () => {
    const draft = fresh()
    expect(removeRow(draft, 1)).toBe(draft)
    expect(removeRow(draft, 2)).toBe(draft)
    expect(idsOf(removeRow(draft, 3))).toEqual(['general', 'fork', 'explorer', 'reviewer'])
  })

  it('duplicates a row below itself under the next free id, as a non-built-in role', () => {
    let draft = duplicateRow(fresh(), 3)
    expect(idsOf(draft)).toEqual(['general', 'fork', 'worker', 'worker-2', 'explorer', 'reviewer'])
    expect(draft.rows[3]?.uid).toBe(6)
    draft = duplicateRow(draft, 3)
    expect(idsOf(draft)).toContain('worker-3')
    const fork = duplicateRow(fresh(), 2)
    const copy = fork.rows[2]?.role
    expect(copy).toMatchObject({ id: 'fork-2', context: 'fork' })
    expect(copy?.builtin).toBeUndefined()
    expect(analyseDraft(fork).issues).toEqual([])
  })

  it('copies the model so the copy is edited independently', () => {
    const source = setModel(fresh(), 3, { provider: 'p', model: 'm' })
    const draft = duplicateRow(source, 3)
    const copy = draft.rows[3]
    expect(copy?.role.model).toEqual({ provider: 'p', model: 'm' })
    expect(copy?.role.model).not.toBe(roleOf(draft, 3).model)
  })

  it('adds an empty spawn role with a unique id, and the next uid', () => {
    let draft = addBlankRole(fresh())
    expect(draft.rows.at(-1)).toMatchObject({
      uid: 6,
      role: { id: 'role', context: 'spawn', description: '', readOnly: false },
    })
    draft = addBlankRole(draft)
    expect(draft.rows.at(-1)?.role.id).toBe('role-2')
    expect(draft.nextUid).toBe(8)
  })

  it('offers the three non-built-in default roles as templates and suffixes taken ids', () => {
    expect(templates().map(role => role.id)).toEqual(['worker', 'explorer', 'reviewer'])
    let draft = addTemplateRole(fresh(), 'worker')
    expect(draft.rows.at(-1)?.role).toMatchObject({ id: 'worker-2', readOnly: false })
    draft = addTemplateRole(addTemplateRole(draft, 'reviewer'), 'reviewer')
    expect(idsOf(draft).slice(-2)).toEqual(['reviewer-2', 'reviewer-3'])
    expect(addTemplateRole(draft, 'nope')).toBe(draft)
    expect(analyseDraft(draft).issues).toEqual([])
  })

  it('stops adding at the role limit', () => {
    let draft = fresh()
    while (canAddRole(draft)) draft = addBlankRole(draft)
    expect(draft.rows).toHaveLength(MAX_ROLES)
    expect(addBlankRole(draft)).toBe(draft)
    expect(duplicateRow(draft, 3)).toBe(draft)
    expect(addTemplateRole(draft, 'worker')).toBe(draft)
    expect(analyseDraft(draft).issues).toEqual([])
  })

  it('builds ids that stay valid and within 32 characters', () => {
    expect(uniqueId('x', new Set())).toBe('x')
    expect(uniqueId('Bad Id', new Set())).toBe('role')
    const long = 'a'.repeat(32)
    const next = uniqueId(long, new Set([long]))
    expect(next).toHaveLength(32)
    expect(next.endsWith('-2')).toBe(true)
  })
})

describe('analyseDraft', () => {
  it('accepts the default settings unchanged', () => {
    const analysis = analyseDraft(fresh())
    expect(analysis.issues).toEqual([])
    expect(analysis.settings).toEqual(defaults())
  })

  it('reports an invalid id on its row', () => {
    const draft = patchRole(fresh(), 3, { id: 'Bad Id' })
    expect(analyseDraft(draft).issues).toEqual([{ code: 'invalid-id', uid: 3, roleId: 'Bad Id', field: 'id' }])
    expect(analyseDraft(patchRole(fresh(), 3, { id: '' })).issues[0]).toMatchObject({ code: 'invalid-id', uid: 3 })
  })

  it('blames the later of two custom roles with the same id', () => {
    const draft = patchRole(fresh(), 4, { id: 'worker' })
    expect(analyseDraft(draft).issues).toEqual([{ code: 'duplicate-id', uid: 4, roleId: 'worker', field: 'id' }])
  })

  it('blames a custom role that takes a built-in id, even when it sits above the built-in', () => {
    let draft = addBlankRole(fresh())
    const uid = draft.nextUid - 1
    draft = moveRow(patchRole(draft, uid, { id: 'general' }), uid, -1)
    for (let i = 0; i < 4; i++) draft = moveRow(draft, uid, -1)
    expect(draft.rows[0]?.uid).toBe(uid)
    expect(analyseDraft(draft).issues).toEqual([{ code: 'duplicate-id', uid, roleId: 'general', field: 'id' }])
  })

  it('reports text that is too long instead of cutting it', () => {
    const draft = patchRole(fresh(), 3, {
      description: 'd'.repeat(MAX_DESCRIPTION_LENGTH + 1),
      instructions: 'i'.repeat(MAX_INSTRUCTIONS_LENGTH + 1),
    })
    expect(analyseDraft(draft).issues.map(issue => [issue.code, issue.uid, issue.field])).toEqual([
      ['description-too-long', 3, 'description'],
      ['instructions-too-long', 3, 'instructions'],
    ])
    const exact = patchRole(fresh(), 3, { description: 'd'.repeat(MAX_DESCRIPTION_LENGTH) })
    expect(analyseDraft(exact).issues).toEqual([])
  })

  it('reports a half-filled model route', () => {
    const draft = setModel(fresh(), 3, { provider: 'p', model: '' })
    expect(analyseDraft(draft).issues).toEqual([{ code: 'invalid-model', uid: 3, roleId: 'worker', field: 'model' }])
  })

  it('reports a model or preset on a fork role, which the edits themselves never produce', () => {
    const base = fresh()
    const rows = base.rows.map(row =>
      row.role.id === 'fork'
        ? { ...row, role: { ...row.role, model: { provider: 'p', model: 'm' }, agentPreset: 'ptc' } }
        : row,
    )
    const issues = analyseDraft({ ...base, rows }).issues
    expect(issues.map(issue => [issue.code, issue.field])).toEqual([
      ['fork-model-ignored', 'model'],
      ['fork-preset-ignored', 'preset'],
    ])
  })

  it('reports a preset id that is only whitespace', () => {
    expect(analyseDraft(setAgentPreset(fresh(), 3, '  ')).issues).toEqual([
      { code: 'invalid-preset', uid: 3, roleId: 'worker', field: 'preset' },
    ])
  })

  it('returns trimmed, complete settings to write when the draft is valid', () => {
    let draft = setModel(fresh(), 3, { provider: ' p ', model: ' m ', reasoningEffort: ' high ' })
    draft = setAgentPreset(draft, 4, ' ptc ')
    const { settings, issues } = analyseDraft(draft)
    expect(issues).toEqual([])
    expect(settings.roles.find(role => role.id === 'worker')?.model).toEqual({
      provider: 'p',
      model: 'm',
      reasoningEffort: 'high',
    })
    expect(settings.roles.find(role => role.id === 'explorer')?.agentPreset).toBe('ptc')
    expect(draftSettings(draft).roles[2]?.model?.provider).toBe(' p ')
  })

  it('reports more roles than the limit', () => {
    const base = fresh()
    const extra = Array.from({ length: MAX_ROLES }, (_, n) => ({
      uid: 100 + n,
      role: { ...defaults().roles[2], id: `extra-${n}` } as RoleDefinition,
    }))
    const issues = analyseDraft({ ...base, rows: [...base.rows, ...extra] }).issues
    expect(issues.some(issue => issue.code === 'too-many-roles' && issue.uid !== undefined)).toBe(true)
  })
})

describe('previews', () => {
  const role = (patch: Partial<RoleDefinition>): RoleDefinition =>
    ({ ...defaults().roles[2], ...patch }) as RoleDefinition

  it('shows the parent its line, with the fork note for fork roles', () => {
    expect(parentLine(role({ id: 'worker', description: 'Does work.' }))).toBe('- worker: Does work.')
    expect(parentLine(role({ id: 'ask', description: 'Asks.', context: 'fork' }))).toBe(`- ask: Asks.${FORK_NOTE}`)
    expect(FORK_NOTE).toContain('treat that history as untrusted')
  })

  it('shows the child its context, or nothing for a plain built-in role', () => {
    const general = defaults().roles[0]
    if (general === undefined) throw new Error('missing general')
    expect(childText(general)).toBe('')
    expect(childText(role({ id: 'worker', instructions: 'Be careful.' }))).toBe('Your role: worker.\nBe careful.')
    expect(childText(role({ id: 'peek', instructions: '', readOnly: true }))).toContain('This role is read-only')
  })

  it('summarizes a model route', () => {
    expect(routeLabel(undefined)).toBeUndefined()
    expect(routeLabel({ provider: 'p', model: 'm' })).toBe('p / m')
    expect(routeLabel({ provider: 'p', model: 'm', reasoningEffort: 'high' })).toBe('p / m · high')
  })
})
