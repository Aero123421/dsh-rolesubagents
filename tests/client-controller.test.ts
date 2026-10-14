import { describe, expect, it, vi } from 'vitest'
import { type Controller, createController } from '../src/client/controller.ts'
import { DEFAULT_ROLES, type RoleDefinition } from '../src/shared/roles.ts'
import { CATALOG, fail, type FakeForm, fakeForm, fakeRemote, ok } from './client-helpers.ts'

function setup(initial: Parameters<typeof fakeForm>[0] = {}, locale = 'en') {
  const fake = fakeForm(initial)
  const remote = fakeRemote()
  const controller = createController({ form: fake.form, remote, locale })
  return { fake, remote, controller }
}

const rows = (controller: Controller) => controller.getSnapshot().draft?.rows ?? []
const uidOf = (controller: Controller, id: string): number => {
  const row = rows(controller).find(candidate => candidate.role.id === id)
  if (row === undefined) throw new Error(`no row ${id}`)
  return row.uid
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}
const roleOf = (fake: FakeForm, id: string): RoleDefinition | undefined =>
  (fake.form.getSnapshot().value as { roles: RoleDefinition[] }).roles.find(role => role.id === id)

describe('state', () => {
  it('starts from the Host settings with a clean draft, and publishes a new snapshot per change', () => {
    const { controller } = setup()
    const first = controller.getSnapshot()
    expect(first).toMatchObject({
      status: 'ready',
      writable: true,
      dirty: false,
      canEdit: true,
      canSave: false,
      save: 'idle',
    })
    expect(rows(controller).map(row => row.role.id)).toEqual(['general', 'fork', 'worker', 'explorer', 'reviewer'])
    expect(controller.getSnapshot()).toBe(first)
    const listener = vi.fn()
    const stop = controller.subscribe(listener)
    controller.setEnabled(false)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot()).not.toBe(first)
    expect(controller.getSnapshot()).toMatchObject({ dirty: true, canSave: true })
    stop()
    controller.setEnabled(true)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().dirty).toBe(false)
  })

  it('renders no draft while the form is loading or unavailable, and builds one once it is ready', () => {
    const { controller, fake } = setup({ status: 'loading', value: undefined, revision: undefined })
    expect(controller.getSnapshot()).toMatchObject({ status: 'loading', draft: undefined, canEdit: false })
    controller.setEnabled(false)
    expect(controller.getSnapshot().draft).toBeUndefined()
    fake.set({ status: 'unavailable' })
    expect(controller.getSnapshot()).toMatchObject({ status: 'unavailable', draft: undefined })
    fake.set({ status: 'ready', value: { enabled: false, roles: DEFAULT_ROLES }, revision: 3 })
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', dirty: false })
    expect(controller.getSnapshot().draft?.enabled).toBe(false)
  })

  it('ignores every edit when the Host document is not writable, but still opens editors', () => {
    const { controller } = setup({ writable: false })
    expect(controller.getSnapshot()).toMatchObject({ writable: false, canEdit: false, canAdd: false })
    controller.setEnabled(false)
    controller.addRole()
    controller.removeRole(uidOf(controller, 'worker'))
    expect(controller.getSnapshot().dirty).toBe(false)
    controller.toggleEditor(uidOf(controller, 'worker'))
    expect(controller.getSnapshot().expanded).toBe(uidOf(controller, 'worker'))
  })

  it('shows repaired stored settings as a clean draft and lists what was repaired', () => {
    const stored = { enabled: true, roles: [{ id: 'Not Valid', description: 'x' }, ...DEFAULT_ROLES] }
    const { controller } = setup({ value: stored })
    const state = controller.getSnapshot()
    expect(state.repaired.map(problem => problem.code)).toEqual(['invalid-id'])
    expect(state.dirty).toBe(false)
    expect(rows(controller).map(row => row.role.id)).not.toContain('Not Valid')
  })

  it('follows the locale', () => {
    const { controller } = setup({}, 'ja')
    expect(controller.getSnapshot().locale).toBe('ja')
    const first = controller.getSnapshot()
    controller.setLocale('ja')
    expect(controller.getSnapshot()).toBe(first)
    controller.setLocale('en')
    expect(controller.getSnapshot().locale).toBe('en')
  })
})

describe('editing', () => {
  it('opens the editor of an added or duplicated role and closes the editor of a deleted one', () => {
    const { controller, remote } = setup()
    controller.addRole()
    const added = controller.getSnapshot().expanded
    expect(added).toBeDefined()
    expect(rows(controller).find(row => row.uid === added)?.role.id).toBe('role')
    expect(remote.session.modelCatalog).toHaveBeenCalledTimes(1)
    controller.duplicateRole(uidOf(controller, 'worker'))
    expect(rows(controller).find(row => row.uid === controller.getSnapshot().expanded)?.role.id).toBe('worker-2')
    controller.addTemplate('reviewer')
    expect(rows(controller).find(row => row.uid === controller.getSnapshot().expanded)?.role.id).toBe('reviewer-2')
    controller.removeRole(controller.getSnapshot().expanded ?? -1)
    expect(controller.getSnapshot().expanded).toBeUndefined()
    controller.toggleEditor(uidOf(controller, 'worker'))
    controller.removeRole(uidOf(controller, 'explorer'))
    expect(controller.getSnapshot().expanded).toBe(uidOf(controller, 'worker'))
    controller.toggleEditor(uidOf(controller, 'worker'))
    expect(controller.getSnapshot().expanded).toBeUndefined()
  })

  it('applies the draft edits through the controller and clears an earlier save result', async () => {
    const { controller } = setup()
    controller.patchRole(uidOf(controller, 'worker'), { description: 'new text' })
    await controller.save()
    expect(controller.getSnapshot().save).toBe('saved')
    controller.setContext(uidOf(controller, 'worker'), 'fork')
    expect(controller.getSnapshot().save).toBe('idle')
    controller.setContext(uidOf(controller, 'worker'), 'spawn')
    controller.setModel(uidOf(controller, 'worker'), { provider: 'p', model: 'm' })
    controller.setAgentPreset(uidOf(controller, 'worker'), 'ptc')
    controller.moveRole(uidOf(controller, 'worker'), -1)
    const worker = rows(controller).find(row => row.role.id === 'worker')?.role
    expect(worker).toMatchObject({ model: { provider: 'p', model: 'm' }, agentPreset: 'ptc' })
    expect(
      rows(controller)
        .map(row => row.role.id)
        .indexOf('worker'),
    ).toBe(1)
  })

  it('lists why a draft cannot be saved and blocks saving', async () => {
    const { controller, fake } = setup()
    const uid = uidOf(controller, 'worker')
    controller.patchRole(uid, { id: 'Bad Id' })
    expect(controller.getSnapshot()).toMatchObject({
      canSave: false,
      issues: [{ code: 'invalid-id', uid, field: 'id' }],
    })
    await controller.save()
    expect(fake.calls).toHaveLength(0)
    controller.patchRole(uid, { id: 'builder' })
    expect(controller.getSnapshot()).toMatchObject({ canSave: true, issues: [] })
  })
})

describe('save', () => {
  it('writes enabled and roles in one fenced mutation, then shows the saved settings', async () => {
    const { controller, fake } = setup({ revision: 4 })
    controller.setEnabled(false)
    controller.patchRole(uidOf(controller, 'worker'), { description: 'Updated.' })
    controller.setModel(uidOf(controller, 'explorer'), {
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      reasoningEffort: '',
    })
    const pending = controller.save()
    expect(controller.getSnapshot()).toMatchObject({ save: 'saving', canEdit: false, canSave: false })
    await pending
    expect(fake.calls).toHaveLength(1)
    const call = fake.calls[0]
    if (call === undefined) throw new Error('no mutate call')
    expect(call.revision).toBe(4)
    expect(call.ops.map(op => (op.op === 'set' ? op.path : ['unset']))).toEqual([['enabled'], ['roles']])
    expect(call.ops[0]).toMatchObject({ value: false })
    const written = (call.ops[1] as { value: RoleDefinition[] }).value
    expect(written.map(role => role.id)).toEqual(['general', 'fork', 'worker', 'explorer', 'reviewer'])
    expect(written[2]?.description).toBe('Updated.')
    expect(written[3]?.model).toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' })
    expect(JSON.parse(JSON.stringify(written))).toEqual(written)
    expect(controller.getSnapshot()).toMatchObject({ save: 'saved', dirty: false, conflict: false, canEdit: true })
    expect(controller.getSnapshot().draft?.revision).toBe(5)
    expect(roleOf(fake, 'worker')?.description).toBe('Updated.')
  })

  it('ignores edits made while a save is in flight and a second save', async () => {
    const { controller, fake } = setup()
    let release: () => void = () => {}
    fake.gate = new Promise(resolve => {
      release = resolve
    })
    controller.setEnabled(false)
    const first = controller.save()
    controller.setEnabled(true)
    const second = controller.save()
    controller.discard()
    expect(controller.getSnapshot().draft?.enabled).toBe(false)
    release()
    await Promise.all([first, second])
    expect(fake.calls).toHaveLength(1)
    expect(controller.getSnapshot().save).toBe('saved')
  })

  it('reports a refused write as failed and keeps the draft', async () => {
    const { controller, fake } = setup()
    fake.outcome = 'refuse'
    controller.setEnabled(false)
    await controller.save()
    expect(controller.getSnapshot()).toMatchObject({ save: 'failed', dirty: true, conflict: false, canSave: true })
    fake.outcome = 'accept'
    await controller.save()
    expect(controller.getSnapshot()).toMatchObject({ save: 'saved', dirty: false })
  })

  it('reports a transport failure as failed', async () => {
    const { controller, fake } = setup()
    fake.outcome = 'throw'
    controller.setEnabled(false)
    await controller.save()
    expect(controller.getSnapshot()).toMatchObject({ save: 'failed', dirty: true })
  })

  it('reports a conflict when the Host refused because its revision moved, and offers a reload', async () => {
    const { controller, fake } = setup()
    fake.outcome = 'refuse'
    fake.onRefuse = () => fake.set({ revision: 2, value: { enabled: true, roles: DEFAULT_ROLES.slice(0, 2) } })
    controller.patchRole(uidOf(controller, 'worker'), { description: 'mine' })
    await controller.save()
    expect(controller.getSnapshot()).toMatchObject({ conflict: true, save: 'idle', canSave: false, dirty: true })
    controller.discard()
    expect(controller.getSnapshot()).toMatchObject({ conflict: false, dirty: false, canSave: false })
    expect(rows(controller).map(row => row.role.id)).toEqual(['general', 'fork'])
  })

  it('does not send a write once the Host revision moved, even if no notification arrived', async () => {
    const { controller, fake } = setup()
    controller.setEnabled(false)
    fake.listeners.clear()
    fake.set({ revision: 2 })
    expect(controller.getSnapshot().conflict).toBe(false)
    await controller.save()
    expect(fake.calls).toHaveLength(0)
    expect(controller.getSnapshot()).toMatchObject({ conflict: true, save: 'idle' })
  })

  it('does nothing when there is nothing to save', async () => {
    const { controller, fake } = setup()
    await controller.save()
    expect(fake.calls).toHaveLength(0)
    expect(controller.getSnapshot().save).toBe('idle')
  })
})

describe('Host changes', () => {
  it('follows the Host while the draft holds no edits', () => {
    const { controller, fake } = setup()
    controller.toggleEditor(uidOf(controller, 'worker'))
    fake.set({ revision: 2, value: { enabled: false, roles: DEFAULT_ROLES } })
    expect(controller.getSnapshot()).toMatchObject({ conflict: false, dirty: false, expanded: undefined })
    expect(controller.getSnapshot().draft?.enabled).toBe(false)
    expect(controller.getSnapshot().draft?.revision).toBe(2)
  })

  it('flags a conflict when the Host moves under unsaved edits, and drops it when the Host already holds them', () => {
    const { controller, fake } = setup()
    controller.setEnabled(false)
    fake.set({ revision: 2, value: { enabled: true, roles: DEFAULT_ROLES.slice(0, 3) } })
    expect(controller.getSnapshot()).toMatchObject({ conflict: true, dirty: true, canSave: false })
    controller.discard()
    controller.setEnabled(false)
    fake.set({ revision: 3, value: { enabled: false, roles: DEFAULT_ROLES.slice(0, 3) } })
    controller.discard()
    controller.setEnabled(true)
    expect(controller.getSnapshot().dirty).toBe(true)
    fake.set({ revision: 4, value: { enabled: true, roles: DEFAULT_ROLES.slice(0, 3) } })
    expect(controller.getSnapshot()).toMatchObject({ conflict: false, dirty: false })
  })

  it('keeps the draft when only the writable flag changes', () => {
    const { controller, fake } = setup()
    controller.setEnabled(false)
    fake.set({ writable: false })
    expect(controller.getSnapshot()).toMatchObject({ dirty: true, canEdit: false, conflict: false })
  })
})

describe('discard', () => {
  it('drops edits, the saved message and an open editor', async () => {
    const { controller } = setup()
    controller.setEnabled(false)
    controller.toggleEditor(uidOf(controller, 'worker'))
    controller.discard()
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, expanded: undefined, save: 'idle' })
    controller.setEnabled(false)
    await controller.save()
    expect(controller.getSnapshot().save).toBe('saved')
    controller.discard()
    expect(controller.getSnapshot().save).toBe('idle')
  })
})

describe('model catalog and agent presets', () => {
  it('loads both lists once when an editor opens, and maps them for the pickers', async () => {
    const { controller, remote } = setup()
    expect(controller.getSnapshot()).toMatchObject({ catalog: { status: 'idle' }, presets: { status: 'idle' } })
    controller.toggleEditor(uidOf(controller, 'worker'))
    expect(controller.getSnapshot()).toMatchObject({ catalog: { status: 'loading' }, presets: { status: 'loading' } })
    await flush()
    controller.toggleEditor(uidOf(controller, 'explorer'))
    controller.loadReference()
    await flush()
    expect(remote.session.modelCatalog).toHaveBeenCalledTimes(1)
    expect(remote.agentPresets.list).toHaveBeenCalledTimes(1)
    const { catalog, presets } = controller.getSnapshot()
    expect(catalog.status).toBe('ready')
    expect(catalog.partial).toBe(false)
    expect(catalog.groups.map(group => group.id)).toEqual(['deepseek', 'other'])
    expect(catalog.groups[0]?.models[0]).toEqual({
      id: 'deepseek-v4-flash',
      name: 'V4 Flash',
      efforts: CATALOG.groups[0]?.models[0]?.reasoning?.efforts,
    })
    expect(catalog.groups[0]?.models[1]?.efforts).toEqual([])
    expect(presets).toEqual({
      status: 'ready',
      options: [
        { id: 'ptc', name: 'PTC' },
        { id: 'minimal', name: 'minimal' },
      ],
    })
  })

  it('marks a partial catalog', async () => {
    const { controller, remote } = setup()
    remote.session.modelCatalog.mockResolvedValue(ok({ ...CATALOG, failures: [{ id: 'x' }] }))
    controller.loadReference()
    await flush()
    expect(controller.getSnapshot().catalog).toMatchObject({ status: 'ready', partial: true })
  })

  it('falls back to error states, keeps the last good list, and retries', async () => {
    const { controller, remote } = setup()
    remote.session.modelCatalog.mockResolvedValueOnce(fail('gateway/internal'))
    remote.agentPresets.list.mockRejectedValueOnce(new Error('boom'))
    controller.loadReference()
    await flush()
    expect(controller.getSnapshot()).toMatchObject({
      catalog: { status: 'error', groups: [] },
      presets: { status: 'error' },
    })
    controller.loadReference()
    await flush()
    expect(controller.getSnapshot()).toMatchObject({ catalog: { status: 'ready' }, presets: { status: 'ready' } })
    remote.session.modelCatalog.mockRejectedValueOnce(new Error('boom'))
    controller.invalidateReference()
    await flush()
    expect(controller.getSnapshot().catalog.status).toBe('error')
    expect(controller.getSnapshot().catalog.groups).toHaveLength(2)
  })

  it('treats a Host without the preset service as having no presets', async () => {
    const { controller, remote } = setup()
    remote.agentPresets.list.mockResolvedValue(fail('gateway/invocation-unavailable'))
    controller.loadReference()
    await flush()
    expect(controller.getSnapshot().presets).toEqual({ status: 'ready', options: [] })
  })

  it('reports an error when the Remote namespaces are missing', async () => {
    const fake = fakeForm()
    const controller = createController({ form: fake.form, remote: undefined, locale: 'en' })
    controller.loadReference()
    await flush()
    expect(controller.getSnapshot()).toMatchObject({ catalog: { status: 'error' }, presets: { status: 'error' } })
  })

  it('reloads on invalidation only once an editor needed the lists, and drops answers that arrive late', async () => {
    const { controller, remote } = setup()
    controller.invalidateReference()
    await flush()
    expect(remote.session.modelCatalog).not.toHaveBeenCalled()
    let answer: (value: Awaited<ReturnType<typeof remote.session.modelCatalog>>) => void = () => {}
    remote.session.modelCatalog.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          answer = resolve
        }),
    )
    controller.loadReference()
    controller.invalidateReference()
    answer(ok({ ...CATALOG, groups: [] }))
    await flush()
    expect(remote.session.modelCatalog).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().catalog.groups).toHaveLength(2)
  })
})

describe('dispose', () => {
  it('stops listening to the form and stops publishing', async () => {
    const { controller, fake, remote } = setup()
    const listener = vi.fn()
    controller.subscribe(listener)
    let answer: (value: Awaited<ReturnType<typeof remote.session.modelCatalog>>) => void = () => {}
    remote.session.modelCatalog.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          answer = resolve
        }),
    )
    controller.loadReference()
    listener.mockClear()
    controller.dispose()
    expect(fake.listeners.size).toBe(0)
    fake.set({ revision: 9 })
    answer(ok(CATALOG))
    await flush()
    controller.setLocale('ja')
    expect(listener).not.toHaveBeenCalled()
    expect(controller.getSnapshot().catalog.status).toBe('loading')
  })
})
