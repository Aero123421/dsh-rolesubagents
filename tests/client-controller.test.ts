import { describe, expect, it, vi } from 'vitest'
import {
  type Controller,
  cliSuggestions,
  createController,
  type ProbeCall,
  probeResultOf,
  ProbeUnavailableError,
} from '../src/client/controller.ts'
import { DEFAULT_ROLES, type RoleDefinition } from '../src/shared/roles.ts'
import { CATALOG, fail, type FakeForm, fakeForm, fakeProbe, fakeRemote, ok, probeAnswer } from './client-helpers.ts'

function setup(initial: Parameters<typeof fakeForm>[0] = {}, locale = 'en', probe?: ProbeCall) {
  const fake = fakeForm(initial)
  const remote = fakeRemote()
  const controller = createController({ form: fake.form, remote, locale, ...(probe === undefined ? {} : { probe }) })
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
    expect(call.ops.map(op => (op.op === 'set' ? op.path : ['unset']))).toEqual([
      ['enabled'],
      ['roles'],
      ['workflowModel'],
      ['clis'],
    ])
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

describe('workflow model', () => {
  it('saves and clears the route atomically with roles, blocking incomplete pairs', async () => {
    const { controller, fake } = setup({ revision: 10 })
    controller.setWorkflowModel({ provider: 'p', model: '' })
    expect(controller.getSnapshot()).toMatchObject({
      dirty: true,
      canSave: false,
      issues: [{ code: 'invalid-workflow-model' }],
    })
    await controller.save()
    expect(fake.calls).toHaveLength(0)
    controller.setWorkflowModel({ provider: 'p', model: 'm' })
    await controller.save()
    expect(fake.calls[0]).toMatchObject({
      revision: 10,
      ops: [
        { path: ['enabled'] },
        { path: ['roles'] },
        { path: ['workflowModel'], value: { provider: 'p', model: 'm' } },
        { path: ['clis'], value: {} },
      ],
    })
    expect(controller.getSnapshot()).toMatchObject({
      dirty: false,
      draft: { workflowModel: { provider: 'p', model: 'm' } },
    })
    controller.setEnabled(false)
    await controller.save()
    expect(controller.getSnapshot().draft?.workflowModel).toEqual({ provider: 'p', model: 'm' })
    controller.setWorkflowModel(undefined)
    await controller.save()
    expect(fake.calls[2]?.ops[2]).toEqual({ op: 'set', path: ['workflowModel'], value: null })
    expect(controller.getSnapshot().draft?.workflowModel).toBeUndefined()
    expect(controller.getSnapshot().repaired).toEqual([])
  })

  it('loads only the catalog once, reloads on invalidation, and retries only on request', async () => {
    const { controller, remote } = setup()
    remote.session.modelCatalog.mockResolvedValueOnce(fail('down'))
    controller.loadWorkflowCatalog()
    controller.loadWorkflowCatalog()
    await flush()
    expect(remote.session.modelCatalog).toHaveBeenCalledTimes(1)
    expect(remote.agentPresets.list).not.toHaveBeenCalled()
    expect(controller.getSnapshot().catalog.status).toBe('error')
    controller.setWorkflowModel({ provider: 'p', model: 'm' })
    await flush()
    expect(remote.session.modelCatalog).toHaveBeenCalledTimes(1)
    controller.loadWorkflowCatalog()
    await flush()
    controller.loadWorkflowCatalog()
    expect(remote.session.modelCatalog).toHaveBeenCalledTimes(2)
    controller.invalidateReference()
    await flush()
    expect(remote.session.modelCatalog).toHaveBeenCalledTimes(3)
    expect(remote.agentPresets.list).not.toHaveBeenCalled()
  })
})

describe('external CLI runners', () => {
  it('edits runners and CLI settings, and saves them with the roles in one fenced mutation', async () => {
    const { controller, fake } = setup({ revision: 6 })
    const worker = uidOf(controller, 'worker')
    controller.setRunner(worker, 'codex')
    controller.patchRunner(worker, { model: 'gpt-5.5', effort: 'high', timeoutMinutes: 20 })
    controller.setRunner(uidOf(controller, 'general'), 'codex')
    controller.setCliSettings('codex', { executable: '/opt/codex', envPassthrough: ['CODEX_API_KEY'] })
    controller.setCliSettings('agy', { executable: 'not/a/bare/name' })
    expect(controller.getSnapshot()).toMatchObject({
      canSave: false,
      issues: [{ code: 'invalid-cli-settings', cli: 'agy', field: 'executable' }],
    })
    controller.setCliSettings('agy', { executable: '' })
    expect(controller.getSnapshot().canSave).toBe(true)
    await controller.save()
    const call = fake.calls[0]
    expect(call?.revision).toBe(6)
    expect(call?.ops.map(op => op.path[0])).toEqual(['enabled', 'roles', 'workflowModel', 'clis'])
    expect(call?.ops[3]).toEqual({
      op: 'set',
      path: ['clis'],
      value: { codex: { executable: '/opt/codex', envPassthrough: ['CODEX_API_KEY'] } },
    })
    expect(roleOf(fake, 'worker')?.runner).toEqual({
      cli: 'codex',
      model: 'gpt-5.5',
      effort: 'high',
      permission: 'workspace-write',
      timeoutMinutes: 20,
    })
    expect(roleOf(fake, 'general')?.runner).toBeUndefined()
    expect(controller.getSnapshot()).toMatchObject({ dirty: false, save: 'saved', repaired: [] })
    expect(controller.getSnapshot().draft?.clis).toEqual({
      codex: { executable: '/opt/codex', envPassthrough: ['CODEX_API_KEY'] },
    })
  })

  it('follows Read-only with the runner permission', () => {
    const { controller } = setup()
    const explorer = uidOf(controller, 'explorer')
    controller.setRunner(explorer, 'claude-code')
    expect(rows(controller).find(row => row.uid === explorer)?.role.runner?.permission).toBe('read-only')
    controller.patchRole(explorer, { readOnly: false })
    expect(rows(controller).find(row => row.uid === explorer)?.role.runner?.permission).toBe('acceptEdits')
  })
})

describe('CLI connection test', () => {
  const flushAll = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  it('is unavailable without a way to call it', () => {
    const { controller } = setup()
    expect(controller.getSnapshot().probes.available).toBe(false)
    controller.probeCli('codex')
    expect(controller.getSnapshot().probes.clis.codex).toEqual({ status: 'idle' })
  })

  it('tests one CLI and keeps its answer', async () => {
    const probe = fakeProbe()
    probe.mockResolvedValueOnce(
      probeAnswer('codex', { models: [{ id: 'gpt-x', name: 'GPT X', efforts: ['low', 9] }, { name: 'no id' }] }),
    )
    const { controller } = setup({}, 'en', probe)
    expect(controller.getSnapshot().probes).toMatchObject({ available: true, clis: { codex: { status: 'idle' } } })
    controller.probeCli('codex')
    expect(controller.getSnapshot().probes.clis.codex.status).toBe('loading')
    await flushAll()
    expect(probe).toHaveBeenCalledWith('codex', expect.any(AbortSignal))
    expect(controller.getSnapshot().probes.clis.codex).toEqual({
      status: 'ready',
      result: {
        cli: 'codex',
        found: true,
        path: '/usr/local/bin/codex',
        version: '1.2.3',
        auth: 'ok',
        models: [{ id: 'gpt-x', name: 'GPT X', efforts: ['low'] }],
      },
    })
    expect(controller.getSnapshot().probes.clis.agy.status).toBe('idle')
    controller.probeCli('codex')
    expect(controller.getSnapshot().probes.clis.codex).toMatchObject({ status: 'loading', result: { found: true } })
  })

  it.each([
    ['a Host without the probe method', async () => fail('gateway/invocation-unavailable'), 'remote-unavailable'],
    ['a Host without the Remote service', async () => fail('gateway/method-unavailable'), 'remote-unavailable'],
    ['a missing service', async () => fail('gateway/service-unavailable'), 'remote-unavailable'],
    [
      'a client without the connection service',
      async () => Promise.reject(new ProbeUnavailableError()),
      'connection-unavailable',
    ],
    [
      'an ambiguous missing endpoint',
      async () => Promise.reject(new Error('transport failure: HTTP 404')),
      'endpoint-unavailable',
    ],
    ['host authentication', async () => Promise.reject(new Error('transport failure: HTTP 401')), 'host-auth'],
    ['host authorization', async () => Promise.reject(new Error('transport failure: HTTP 403')), 'host-auth'],
    ['structured access denial', async () => fail('remote-access/denied'), 'host-auth'],
    ['transport failure', async () => Promise.reject(new Error('transport failure: HTTP 503')), 'transport'],
    ['invalid JSON', async () => Promise.reject(new SyntaxError('bad JSON')), 'malformed'],
    [
      'invalid carrier envelope',
      async () => Promise.reject(new TypeError('connection: invalid server-response envelope')),
      'malformed',
    ],
    [
      'correlation mismatch',
      async () => Promise.reject(new Error('rpcId mismatch for rolesubagentsCli/probe')),
      'malformed',
    ],
    ['withdrawn definition', async () => fail('gateway/definition-unavailable'), 'remote-unavailable'],
    ['invalid envelope', async () => null, 'malformed'],
    ['invalid error envelope', async () => ({ ok: false, error: null }), 'malformed'],
  ])('distinguishes %s and allows retry', async (_name, answer, issue) => {
    const probe = vi.fn<ProbeCall>(answer as ProbeCall)
    const { controller } = setup({}, 'en', probe)
    controller.probeCli('agy')
    await flushAll()
    expect(controller.getSnapshot().probes.available).toBe(true)
    expect(controller.getSnapshot().probes.clis.agy).toEqual({ status: 'error', issue })
    expect(controller.getSnapshot().probes.clis.codex).toEqual({ status: 'idle' })
    probe.mockResolvedValueOnce(probeAnswer('agy'))
    controller.probeCli('agy')
    await flushAll()
    expect(probe).toHaveBeenCalledTimes(2)
    expect(controller.getSnapshot().probes.clis.agy.status).toBe('ready')
    expect(controller.getSnapshot().canEdit).toBe(true)
  })

  it.each([
    ['a thrown error', async () => Promise.reject(new Error('boom'))],
    ['a failed call', async () => fail('gateway/internal')],
    ['an answer that is not a probe result', async () => ok({ nope: true })],
    ['an answer for another CLI', async () => probeAnswer('codex')],
  ])('reports %s as a failed test and keeps the button', async (_name, answer) => {
    const { controller } = setup({}, 'en', vi.fn<ProbeCall>(answer as ProbeCall))
    controller.probeCli('opencode')
    await flushAll()
    expect(controller.getSnapshot().probes).toMatchObject({ available: true, clis: { opencode: { status: 'error' } } })
  })

  it('keeps only the latest test of a CLI and aborts tests on dispose', async () => {
    const signals: AbortSignal[] = []
    const answers: ((value: Awaited<ReturnType<ProbeCall>>) => void)[] = []
    const probe = vi.fn<ProbeCall>(
      (_cli, signal) =>
        new Promise(resolve => {
          signals.push(signal)
          answers.push(resolve)
        }),
    )
    const { controller } = setup({}, 'en', probe)
    controller.probeCli('codex')
    controller.probeCli('codex')
    expect(signals[0]?.aborted).toBe(true)
    answers[1]?.(probeAnswer('codex', { version: 'new' }))
    answers[0]?.(probeAnswer('codex', { version: 'old' }))
    await flushAll()
    expect(controller.getSnapshot().probes.clis.codex.result?.version).toBe('new')
    controller.probeCli('agy')
    controller.dispose()
    expect(signals[2]?.aborted).toBe(true)
  })

  it('forgets the tests on a new connection', async () => {
    const { controller } = setup({}, 'en', fakeProbe())
    controller.probeCli('codex')
    await flushAll()
    controller.resetProbes()
    expect(controller.getSnapshot().probes.clis.codex).toEqual({ status: 'idle' })
  })
})

describe('CLI suggestions', () => {
  it('suggests the static models until a test lists the CLI models', () => {
    expect(cliSuggestions(undefined, 'claude-code').models).toEqual(['default', 'opus', 'sonnet', 'haiku', 'fable'])
    expect(cliSuggestions({ status: 'ready', result: { cli: 'codex', found: false } }, 'codex').models).toContain(
      'gpt-5.5',
    )
    const ready = {
      status: 'ready' as const,
      result: { cli: 'agy' as const, found: true, models: [{ id: 'a', efforts: ['low'] }, { id: 'b' }, { id: 'a' }] },
    }
    expect(cliSuggestions(ready, 'agy', '', 'a')).toEqual({ providers: [], models: ['a', 'b'], efforts: ['low'] })
    expect(cliSuggestions({ ...ready, status: 'error' }, 'agy').models).toContain('gemini-3.1-pro')
  })

  it('splits OpenCode ids into providers and models', () => {
    const probe = {
      status: 'ready' as const,
      result: {
        cli: 'opencode' as const,
        found: true,
        models: [
          { id: 'deepseek/v4-pro', efforts: ['high', 'max'] },
          { id: 'deepseek/v4-flash' },
          { id: 'openrouter/qwen/qwen3' },
          { id: 'broken/' },
          { id: 'noslash' },
        ],
      },
    }
    expect(cliSuggestions(undefined, 'opencode')).toEqual({ providers: [], models: [], efforts: [] })
    expect(cliSuggestions(probe, 'opencode')).toEqual({
      providers: ['deepseek', 'openrouter'],
      models: ['v4-pro', 'v4-flash', 'qwen/qwen3'],
      efforts: [],
    })
    expect(cliSuggestions(probe, 'opencode', 'deepseek', 'v4-pro')).toEqual({
      providers: ['deepseek', 'openrouter'],
      models: ['v4-pro', 'v4-flash'],
      efforts: ['high', 'max'],
    })
  })

  it('reads probe answers defensively', () => {
    expect(probeResultOf('codex', null)).toBeUndefined()
    expect(probeResultOf('codex', { found: 'yes' })).toBeUndefined()
    expect(probeResultOf('codex', { found: false, auth: 'maybe', path: 3, message: 'not-found' })).toEqual({
      cli: 'codex',
      found: false,
      message: 'not-found',
    })
  })
})
