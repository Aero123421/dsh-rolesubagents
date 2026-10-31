import { describe, expect, it, vi } from 'vitest'
import { managementAuthorization } from '../src/host/management/auth.ts'
import type { roleManagementHelp } from '../src/host/management/help.ts'
import { createManagementAudit } from '../src/host/management/audit.ts'
import {
  createRoleManagement,
  type ActiveRoleCatalog,
  type CurrentCatalogResult,
  type ManagementDeps,
  type ManagementReply,
} from '../src/host/management/service.ts'
import { managementSettings, type ManagementSettingsPort } from '../src/host/management/settings.ts'
import type { AgentPort } from '../src/host/ports.ts'
import { DEFAULT_ROLES, type RoleDefinition } from '../src/shared/roles.ts'
import { fakeAgent, fakeSession, fakeStorage } from './host-fakes.ts'

vi.mock('@deepseek-ai/dsh-storage-domain', () => import('./host-fakes.ts').then(module => module.storageDomainModule()))

function deferred() {
  let done: () => void = () => {}
  const promise = new Promise<void>(resolve => {
    done = resolve
  })
  return { promise, resolve: () => done() }
}
function setup(options: Partial<Pick<ManagementDeps, 'metadataTimeoutMs' | 'lifetime'>> = {}) {
  const agent = fakeAgent('owner', fakeSession('session-owner', { origin: 'web', delegationDepth: 0 }))
  const live = new Set<AgentPort>([agent])
  const children = new Set<AgentPort>()
  const readers = new Set<AgentPort>()
  const state = {
    revision: 10,
    value: {
      allowAiRoleManagement: true,
      enabled: true,
      roles: structuredClone(DEFAULT_ROLES),
      opaque: 'SECRET_OPAQUE',
      clis: { pi: { executable: '/never/execute' } },
    } as Record<string, unknown>,
    clock: 1000,
    mode: 'workspace-write',
    disposed: false,
    readFailure: false,
    writeFailure: false,
    postCommitReadFailure: false,
    activeFailure: false,
    auditFailure: false,
    persistedWrites: 0,
    currentResult: undefined as CurrentCatalogResult | undefined,
    currentError: undefined as Error | undefined,
  }
  const hooks: { beforeCommit?: () => void | Promise<void> } = {}
  const port: ManagementSettingsPort = {
    writable: true,
    describe: vi.fn(() => {
      if (state.readFailure) throw new Error('SECRET_READ')
      return [{ ns: 'rolesubagents', revision: state.revision, value: structuredClone(state.value) }]
    }),
    mutate: vi.fn(async (ns, ops, revision) => {
      await hooks.beforeCommit?.()
      if (ns !== 'rolesubagents' || revision !== state.revision)
        throw Object.assign(new Error('SECRET_CONFLICT'), { code: 'SETTINGS_CONFLICT' })
      if (state.writeFailure) throw new Error('SECRET_WRITE')
      expect(ops).toHaveLength(1)
      expect(ops[0]).toMatchObject({ op: 'set', path: ['roles'] })
      state.value = { ...state.value, roles: structuredClone(ops[0]!.value) }
      state.revision++
      state.persistedWrites++
      if (state.postCommitReadFailure) state.readFailure = true
    }),
  }
  const settings = managementSettings({ settings: () => port, namespace: () => 'rolesubagents' })
  const authorize = managementAuthorization({
    isDisposed: () => state.disposed,
    isCurrentAgent: candidate => live.has(candidate),
    isRecordedChild: candidate => children.has(candidate),
    isReadOnly: candidate => readers.has(candidate),
    sandboxPolicy: () => ({ resolve: () => ({ mode: state.mode, workspaceRoot: '/fixture/workspace' }) }),
  })
  const catalogs = new Map<AgentPort, ActiveRoleCatalog>([
    [agent, { revision: 'session-1', enabled: true, roles: structuredClone(DEFAULT_ROLES) }],
  ])
  const catalogFns = {
    capabilities: vi.fn(async () => ({ targets: [] })),
    models: vi.fn(async (_request?: unknown, _signal?: AbortSignal) => ({ models: [], status: 'unknown' })),
    invalidate: vi.fn(),
  }
  const audit = {
    list: vi.fn(async () => ({ entries: [], durable: true })),
    append: vi.fn(async () => {
      if (state.auditFailure) throw new Error('SECRET_AUDIT')
      return true
    }),
  }
  const applyCurrent = vi.fn(
    async (owner: AgentPort, roles: readonly RoleDefinition[], expected: string): Promise<CurrentCatalogResult> => {
      if (state.currentError) throw state.currentError
      if (state.currentResult) return state.currentResult
      const old = catalogs.get(owner)
      if (!old || old.revision !== expected)
        return {
          applied: false,
          durable: false,
          revision: old?.revision ?? 'unavailable',
          code: 'session-revision-conflict',
        }
      const next = { ...old, roles: structuredClone(roles), revision: 'session-2' }
      catalogs.set(owner, next)
      return { applied: true, durable: true, revision: next.revision }
    },
  )
  let sequence = 0
  const token = vi.fn(() => `token-${++sequence}`)
  const active = vi.fn((owner: AgentPort) => {
    if (state.activeFailure) throw new Error('SECRET_ACTIVE')
    return catalogs.get(owner)
  })
  const service = createRoleManagement({
    settings,
    authorize,
    catalog: catalogFns as unknown as ManagementDeps['catalog'],
    active,
    applyCurrent,
    audit,
    now: () => state.clock,
    token,
    planTtlMs: 100,
    ...options,
  })
  const run = (args: unknown, owner: AgentPort | undefined = agent, signal?: AbortSignal) =>
    service.execute(owner, args, signal)
  const gate = (allowed: boolean) => {
    state.value = { ...state.value, allowAiRoleManagement: allowed }
    state.revision++
  }
  const preview = (changes: unknown[] = [{ op: 'create', role: { id: 'tester', description: 'Test scoped code' } }]) =>
    run({ action: 'preview', expectedRevision: state.revision, changes })
  return {
    agent,
    live,
    children,
    readers,
    state,
    hooks,
    port,
    settings,
    catalogs,
    catalogFns,
    audit,
    applyCurrent,
    active,
    token,
    service,
    run,
    gate,
    preview,
  }
}
function expectFailure(reply: ManagementReply, code: string) {
  expect(reply).toMatchObject({ ok: false, code })
  expect(JSON.stringify(reply)).not.toContain('SECRET_')
}

describe('Host role management service', () => {
  it('returns static JSON help without consulting roles, metadata, history or write machinery', async () => {
    const t = setup()
    t.state.value.roles = [
      { id: 'secret-role', description: 'SECRET_DESCRIPTION', instructions: 'SECRET_INSTRUCTIONS' },
    ]
    t.state.activeFailure = true
    const before = structuredClone(t.state.value)
    const reply = await t.run({ action: 'help' })
    expect(reply).toMatchObject({ ok: true, kind: 'help' })
    expect(Object.keys(reply).sort()).toEqual([
      'actions',
      'examples',
      'kind',
      'ok',
      'promptExample',
      'promptFields',
      'purpose',
      'rules',
      'sequence',
    ])
    expect(reply.promptFields).toEqual(
      expect.objectContaining({
        'role.description': expect.any(String),
        'role.instructions': expect.any(String),
        'delegate.prompt': expect.any(String),
        'delegate.description': expect.any(String),
      }),
    )
    expect(Object.keys(reply.actions as object)).toEqual([
      'help',
      'list',
      'get',
      'capabilities',
      'models',
      'preview',
      'apply',
      'apply_current',
    ])
    expect(JSON.parse(JSON.stringify(reply))).toEqual(reply)
    expect(JSON.stringify(reply)).not.toMatch(/SECRET_|secret-role|session-owner|session-1|\/never\/execute/)
    expect(reply).not.toHaveProperty('revision')
    expect(reply).not.toHaveProperty('currentSession')
    expect(t.port.describe).toHaveBeenCalled()
    expect(t.port.mutate).not.toHaveBeenCalled()
    expect(t.audit.list).not.toHaveBeenCalled()
    expect(t.audit.append).not.toHaveBeenCalled()
    for (const fn of Object.values(t.catalogFns)) expect(fn).not.toHaveBeenCalled()
    expect(t.active).not.toHaveBeenCalled()
    expect(t.applyCurrent).not.toHaveBeenCalled()
    expect(t.token).not.toHaveBeenCalled()
    expect(t.state.value).toEqual(before)
    expect(t.state.revision).toBe(10)
    expect(t.state.persistedWrites).toBe(0)

    t.state.value.roles = [{ id: 'different-secret', instructions: 'SECRET_CHANGED' }]
    t.state.revision = 99
    t.catalogs.clear()
    expect(await t.run({ action: 'help' })).toEqual(reply)
  })
  it('returns deeply detached help across concurrent requests and subsequent calls', async () => {
    const t = setup()
    const replies = await Promise.all(Array.from({ length: 8 }, () => t.run({ action: 'help' })))
    const expected = JSON.parse(JSON.stringify(replies[0]))
    const poison = (value: unknown): void => {
      if (!value || typeof value !== 'object') return
      for (const child of Object.values(value)) poison(child)
      if (Array.isArray(value)) value.push('SECRET_MUTATION')
      else (value as Record<string, unknown>).poison = 'SECRET_MUTATION'
    }
    for (const reply of replies) {
      expect(reply).toEqual(expected)
      expect(reply).not.toBe(expected)
    }
    poison(replies[0])
    for (const reply of replies.slice(1)) expect(reply).toEqual(expected)
    expect(await t.run({ action: 'help' })).toEqual(expected)
    expect(t.token).not.toHaveBeenCalled()
    expect(t.port.mutate).not.toHaveBeenCalled()
  })
  it.each(['topic', 'id', 'target', 'expectedRevision', 'changes', 'planId', 'allowAiRoleManagement'])(
    'accepts no help field other than action (%s)',
    async field => {
      const t = setup()
      expectFailure(await t.run({ action: 'help', [field]: 'SECRET_INPUT' }), 'invalid-request')
      expect(t.port.describe).not.toHaveBeenCalled()
      expect(t.token).not.toHaveBeenCalled()
      expect(t.port.mutate).not.toHaveBeenCalled()
    },
  )
  it('authorizes help as a read for eligible read-only and ordinary fork parents', async () => {
    const t = setup()
    t.readers.add(t.agent)
    t.state.mode = 'read-only'
    expect(await t.run({ action: 'help' })).toMatchObject({ ok: true, kind: 'help' })
    const fork = fakeAgent(
      'fork',
      fakeSession('fork-session', {
        parentSession: t.agent.session.id,
        origin: 'web',
        delegationDepth: 0,
      }),
    )
    t.live.add(fork)
    expect(await t.run({ action: 'help' }, fork)).toMatchObject({ ok: true, kind: 'help' })
    expectFailure(await t.preview(), 'read-only-caller')
    expect(t.port.mutate).not.toHaveBeenCalled()
  })
  it.each(['gate', 'child', 'recorded-child', 'stale', 'missing', 'disposed', 'service-disposed'] as const)(
    'does not bypass existing %s authorization for help',
    async reason => {
      const t = setup()
      let owner: AgentPort | undefined = t.agent
      let code = 'caller-unavailable'
      if (reason === 'gate') {
        t.gate(false)
        code = 'management-disabled'
      }
      if (reason === 'child') {
        owner = fakeAgent('child', fakeSession('child-session', { origin: 'subagent', delegationDepth: 1 }))
        t.live.add(owner)
        code = 'child-not-authorized'
      }
      if (reason === 'recorded-child') {
        t.children.add(t.agent)
        code = 'child-not-authorized'
      }
      if (reason === 'stale') t.live.delete(t.agent)
      if (reason === 'missing') owner = undefined
      if (reason === 'disposed') t.state.disposed = true
      if (reason === 'service-disposed') {
        t.service.dispose()
        code = 'management-unavailable'
      }
      expectFailure(await t.service.execute(owner, { action: 'help' }), code)
      expect(t.audit.list).not.toHaveBeenCalled()
      expect(t.token).not.toHaveBeenCalled()
      expect(t.port.mutate).not.toHaveBeenCalled()
    },
  )
  it('checks cancellation after parsing and authorization before returning help', async () => {
    const t = setup()
    const controller = new AbortController()
    controller.abort(new Error('SECRET_ABORT'))
    const reply = await t.run({ action: 'help' }, t.agent, controller.signal)
    expect(reply.ok).toBe(false)
    expect(JSON.stringify(reply)).not.toContain('SECRET_')
    expect(t.port.describe).toHaveBeenCalled()
    t.gate(false)
    expectFailure(await t.run({ action: 'help' }, t.agent, controller.signal), 'management-disabled')
    expectFailure(await t.run({ action: 'help', topic: 'roles' }, t.agent, controller.signal), 'invalid-request')
    expect(t.audit.list).not.toHaveBeenCalled()
    expect(t.token).not.toHaveBeenCalled()
    expect(t.port.mutate).not.toHaveBeenCalled()
  })
  it('executes the documented management examples against the actual service without delegating', async () => {
    const t = setup()
    const help = (await t.run({ action: 'help' })) as ReturnType<typeof roleManagementHelp>
    expect(help).toMatchObject({ ok: true, kind: 'help' })
    const examples = help.examples
    expect(Object.keys(examples).sort()).toEqual([
      'apply',
      'apply_current',
      'create',
      'delegate',
      'delete',
      'get',
      'list',
      'note',
      'update',
    ])
    expect(examples.delegate).toMatchObject({
      role: examples.get.id,
      description: expect.any(String),
      prompt: expect.any(String),
    })
    expect(examples.create.changes[0]?.role).toMatchObject({
      id: examples.get.id,
      description: expect.any(String),
      instructions: expect.any(String),
      readOnly: true,
    })
    const listed = await t.run(examples.list)
    expect(listed).toMatchObject({ ok: true, revision: 10, currentSession: { revision: 'session-1' } })
    const create = await t.run({ ...examples.create, expectedRevision: listed.revision })
    expect(create).toMatchObject({ ok: true, planId: expect.any(String) })
    expect(t.port.mutate).not.toHaveBeenCalled()
    expect(await t.run({ ...examples.apply, planId: create.planId })).toMatchObject({ ok: true, globalSaved: true })
    const fetched = await t.run(examples.get)
    expect(fetched).toMatchObject({ ok: true, role: examples.create.changes[0]?.role })
    const fresh = await t.run(examples.list)
    expect(
      await t.run({
        ...examples.apply_current,
        expectedRevision: fresh.revision,
        expectedSessionRevision: (fresh.currentSession as { revision: string }).revision,
      }),
    ).toMatchObject({ ok: true, globalSaved: true, currentApplied: true })
    expect(t.catalogs.get(t.agent)?.roles).toContainEqual(expect.objectContaining({ id: examples.get.id }))
    for (const example of [examples.update, examples.delete]) {
      const current = await t.run(examples.list)
      const preview = await t.run({ ...example, expectedRevision: current.revision })
      expect(preview).toMatchObject({ ok: true, planId: expect.any(String) })
      expect(await t.run({ ...examples.apply, planId: preview.planId })).toMatchObject({ ok: true, globalSaved: true })
      if (example === examples.update) {
        expect(await t.run(examples.get)).toMatchObject({ ok: true, role: examples.update.changes[0]?.patch })
      }
    }
    expectFailure(await t.run(examples.get), 'role-not-found')
    expect(t.state.persistedWrites).toBe(3)
    expect(t.applyCurrent).toHaveBeenCalledTimes(1)
  })
  it('reports saved and active catalogs separately and never exposes opaque settings', async () => {
    const t = setup()
    const listed = await t.run({ action: 'list' })
    expect(listed).toMatchObject({
      ok: true,
      kind: 'roles',
      revision: 10,
      currentSession: { revision: 'session-1', roleIds: DEFAULT_ROLES.map(role => role.id) },
    })
    expect(JSON.stringify(listed)).not.toContain('SECRET_OPAQUE')
    const role = await t.run({ action: 'get', id: 'worker' })
    expect(role).toMatchObject({ ok: true, role: { id: 'worker', instructions: DEFAULT_ROLES[2]?.instructions } })
    expect(t.port.mutate).not.toHaveBeenCalled()
    expect(t.catalogFns.models).not.toHaveBeenCalled()
  })
  it('safely reports malformed stored role identifiers while requiring repair before preview', async () => {
    const t = setup()
    t.state.value.roles = [...DEFAULT_ROLES, { id: 'SECRET_INVALID ID', description: 'SECRET_INVALID' }]
    const reply = await t.run({ action: 'list' })
    expect(reply).toMatchObject({ ok: true, repairNeeded: true })
    expect(JSON.stringify(reply)).not.toContain('SECRET_')
    expectFailure(await t.preview(), 'settings-repair-needed')
    expect(t.port.mutate).not.toHaveBeenCalled()
  })
  it('rechecks OFF for every action and never returns a hidden write capability', async () => {
    const t = setup()
    expect(t.service.available(t.agent)).toBe(true)
    const plan = await t.preview()
    t.gate(false)
    expect(t.service.available(t.agent)).toBe(false)
    for (const args of [
      { action: 'list' },
      { action: 'get', id: 'worker' },
      { action: 'capabilities' },
      { action: 'models', target: 'pi' },
      { action: 'apply', planId: plan.planId },
      { action: 'apply_current', expectedRevision: t.state.revision, expectedSessionRevision: 'session-1' },
    ])
      expectFailure(await t.run(args), 'management-disabled')
    expect(t.port.mutate).not.toHaveBeenCalled()
    expect(t.catalogFns.models).not.toHaveBeenCalled()
  })
  it('denies actual children and read-only changes, but allows ordinary user-fork parents', async () => {
    const t = setup()
    const child = fakeAgent(
      'child',
      fakeSession('child-session', { origin: 'subagent', delegationDepth: 1, parentSession: t.agent.session.id }),
    )
    t.live.add(child)
    expectFailure(await t.run({ action: 'list' }, child), 'child-not-authorized')
    t.readers.add(t.agent)
    expect((await t.run({ action: 'list' })).ok).toBe(true)
    expectFailure(await t.preview(), 'read-only-caller')
    t.readers.delete(t.agent)
    const fork = fakeAgent(
      'fork',
      fakeSession('fork-session', { parentSession: t.agent.session.id, origin: 'web', delegationDepth: 0 }),
    )
    t.live.add(fork)
    expect((await t.run({ action: 'list' }, fork)).ok).toBe(true)
  })
  it.each([
    { action: 'set_enabled', enabled: true },
    { action: 'list', allowAiRoleManagement: true },
    { action: 'preview', expectedRevision: 10, changes: [], path: ['clis'] },
    { action: 'apply', planId: 'x', expectedRevision: 10 },
    { action: 'models', target: 'pi', credentials: 'SECRET_INPUT' },
  ])('rejects unknown actions/fields and arbitrary config paths safely', async args => {
    const t = setup()
    expectFailure(await t.run(args), 'invalid-request')
    expect(t.port.mutate).not.toHaveBeenCalled()
  })
  it('requires the exact revision and immutable copies of previewed input', async () => {
    const t = setup()
    expectFailure(await t.run({ action: 'preview', changes: [] }), 'invalid-request')
    expectFailure(await t.run({ action: 'preview', changes: [], expectedRevision: 9 }), 'revision-conflict')
    const changes = [{ op: 'create', role: { id: 'tester', description: 'Before' } }]
    const plan = await t.preview(changes)
    changes[0]!.role.description = 'AFTER_MUTATION'
    const applied = await t.run({ action: 'apply', planId: plan.planId })
    expect(applied).toMatchObject({ ok: true, globalSaved: true, currentApplied: false, revision: 11 })
    expect(t.state.value.roles).toContainEqual(expect.objectContaining({ id: 'tester', description: 'Before' }))
    expect(t.catalogs.get(t.agent)?.roles.some(role => role.id === 'tester')).toBe(false)
    expect(t.applyCurrent).not.toHaveBeenCalled()
  })
  it('binds a plan to live owner identity and expiration', async () => {
    const t = setup()
    const plan = await t.preview()
    const other = fakeAgent('other')
    t.live.add(other)
    expectFailure(await t.run({ action: 'apply', planId: plan.planId }, other), 'plan-unavailable')
    t.live.delete(t.agent)
    expectFailure(await t.run({ action: 'apply', planId: plan.planId }), 'caller-unavailable')
    t.live.add(t.agent)
    t.state.clock += 101
    expectFailure(await t.run({ action: 'apply', planId: plan.planId }), 'plan-expired')
    expect(t.port.mutate).not.toHaveBeenCalled()
  })
  it('revalidates the caller ceiling after preview before commit', async () => {
    const t = setup()
    t.state.mode = 'danger-full-access'
    const plan = await t.preview([
      { op: 'create', role: { id: 'native', description: 'Native', runner: { cli: 'pi', permission: 'native' } } },
    ])
    expect(plan.ok).toBe(true)
    t.state.mode = 'workspace-write'
    expectFailure(await t.run({ action: 'apply', planId: plan.planId }), 'permission-ceiling')
    expect(t.port.mutate).not.toHaveBeenCalled()
  })
  it('deduplicates concurrent application and later replay of one plan', async () => {
    const t = setup()
    const plan = await t.preview()
    const [first, second] = await Promise.all([
      t.run({ action: 'apply', planId: plan.planId }),
      t.run({ action: 'apply', planId: plan.planId }),
    ])
    expect(first).toMatchObject({ ok: true, globalSaved: true })
    expect(second).toMatchObject({ ok: true, globalSaved: true })
    expect(t.port.mutate).toHaveBeenCalledTimes(1)
    expect(t.state.persistedWrites).toBe(1)
    expect(t.audit.append).toHaveBeenCalledTimes(1)
    expect(await t.run({ action: 'apply', planId: plan.planId })).toMatchObject({ ok: true, replayed: true })
    expect(t.port.mutate).toHaveBeenCalledTimes(1)
  })
  it('permits only one of two independent plans at the same settings revision, with no automatic retry', async () => {
    const t = setup()
    const a = await t.preview()
    const b = await t.preview([{ op: 'create', role: { id: 'another', description: 'Other' } }])
    const replies = await Promise.all([
      t.run({ action: 'apply', planId: a.planId }),
      t.run({ action: 'apply', planId: b.planId }),
    ])
    expect(replies.filter(reply => reply.ok)).toHaveLength(1)
    expect(replies.filter(reply => reply.code === 'revision-conflict')).toHaveLength(1)
    expect(t.state.persistedWrites).toBe(1)
    expect(t.port.mutate).toHaveBeenCalledTimes(2)
  })
  it.each(['off', 'off-on'] as const)('fences a queued global mutation after an %s switch change', async mode => {
    const t = setup()
    const plan = await t.preview()
    t.hooks.beforeCommit = () => {
      t.gate(false)
      if (mode === 'off-on') t.gate(true)
    }
    expectFailure(await t.run({ action: 'apply', planId: plan.planId }), 'revision-conflict')
    expect(t.state.persistedWrites).toBe(0)
    expect(t.port.mutate).toHaveBeenCalledTimes(1)
  })
  it('does not persist no-op plans, advance revisions or create false audit entries', async () => {
    const t = setup()
    const plan = await t.preview([{ op: 'update', id: 'worker', patch: {} }])
    expect(plan).toMatchObject({ ok: true, noChange: true, changes: [] })
    expect(await t.run({ action: 'apply', planId: plan.planId })).toMatchObject({
      ok: true,
      globalSaved: true,
      noChange: true,
      revision: 10,
    })
    expect(t.port.mutate).not.toHaveBeenCalled()
    expect(t.audit.append).not.toHaveBeenCalled()
  })
  it('reports fixed persistence failure without pretending a write succeeded', async () => {
    const t = setup()
    const plan = await t.preview()
    t.state.writeFailure = true
    expectFailure(await t.run({ action: 'apply', planId: plan.planId }), 'settings-write-failed')
    expect(t.state.persistedWrites).toBe(0)
    expect(t.port.mutate).toHaveBeenCalledTimes(1)
    expect(t.audit.append).not.toHaveBeenCalled()
  })
  it('truthfully returns globalSaved after committed write/readback failure', async () => {
    const t = setup()
    const plan = await t.preview()
    t.state.postCommitReadFailure = true
    const reply = await t.run({ action: 'apply', planId: plan.planId })
    expect(reply).toMatchObject({ ok: true, globalSaved: true, revisionUnknown: true, currentApplied: false })
    expect(reply).not.toHaveProperty('revision')
    expect(JSON.stringify(reply)).not.toContain('SECRET_')
    expect(t.state.persistedWrites).toBe(1)
  })
  it('preserves a successful global save even if the active-session status reader fails', async () => {
    const t = setup()
    const plan = await t.preview()
    t.state.activeFailure = true
    const reply = await t.run({ action: 'apply', planId: plan.planId })
    expect(reply).toMatchObject({ ok: true, globalSaved: true, currentSession: { available: false } })
    expect(JSON.stringify(reply)).not.toContain('SECRET_ACTIVE')
    expect(t.state.persistedWrites).toBe(1)
  })

  it('does not report a saved role as unapplied because audit persistence failed', async () => {
    const t = setup()
    const plan = await t.preview()
    t.state.auditFailure = true
    expect(await t.run({ action: 'apply', planId: plan.planId })).toMatchObject({
      ok: true,
      globalSaved: true,
      auditDurable: false,
    })
    expect(t.state.persistedWrites).toBe(1)
  })
  it('uses metadata-only audit fields, never raw roles or instruction text', async () => {
    const t = setup()
    const plan = await t.preview([{ op: 'update', id: 'worker', patch: { instructions: 'SECRET_NEW_INSTRUCTIONS' } }])
    expect(JSON.stringify(plan)).not.toContain('SECRET_NEW_INSTRUCTIONS')
    await t.run({ action: 'apply', planId: plan.planId })
    expect(JSON.stringify(t.audit.append.mock.calls)).not.toContain('SECRET_NEW_INSTRUCTIONS')
  })
  it('applies current roles only through an explicit second action and leaves other sessions unchanged', async () => {
    const t = setup()
    const other = fakeAgent('other')
    t.live.add(other)
    t.catalogs.set(other, { revision: 'other-1', enabled: false, roles: structuredClone(DEFAULT_ROLES) })
    const plan = await t.preview()
    await t.run({ action: 'apply', planId: plan.planId })
    expect(t.applyCurrent).not.toHaveBeenCalled()
    const reply = await t.run({ action: 'apply_current', expectedRevision: 11, expectedSessionRevision: 'session-1' })
    expect(reply).toMatchObject({
      ok: true,
      globalSaved: true,
      currentApplied: true,
      sessionDurable: true,
      sessionRevision: 'session-2',
    })
    expect(t.catalogs.get(t.agent)?.roles.some(role => role.id === 'tester')).toBe(true)
    expect(t.catalogs.get(other)?.roles.some(role => role.id === 'tester')).toBe(false)
    expect(t.port.mutate).toHaveBeenCalledTimes(1)
  })
  it('reports current-session failure separately without undoing a saved global role', async () => {
    const t = setup()
    const plan = await t.preview()
    await t.run({ action: 'apply', planId: plan.planId })
    t.state.currentResult = { applied: false, durable: false, revision: 'session-1', code: 'snapshot-write-failed' }
    expect(
      await t.run({ action: 'apply_current', expectedRevision: 11, expectedSessionRevision: 'session-1' }),
    ).toMatchObject({
      ok: false,
      globalSaved: true,
      currentApplied: false,
      sessionDurable: false,
      code: 'snapshot-write-failed',
    })
    expect(t.state.persistedWrites).toBe(1)
    expect((t.state.value.roles as { id: string }[]).some(role => role.id === 'tester')).toBe(true)
  })
  it('keeps global-save truth when the current-session callback unexpectedly rejects', async () => {
    const t = setup()
    t.state.currentError = new Error('SECRET_CURRENT_APPLY')
    const reply = await t.run({ action: 'apply_current', expectedRevision: 10, expectedSessionRevision: 'session-1' })
    expect(reply).toMatchObject({ ok: false, globalSaved: true, currentApplied: false })
    expect(JSON.stringify(reply)).not.toContain('SECRET_')
  })
  it('requires current global/session revisions and rejects stale refresh requests', async () => {
    const t = setup()
    expectFailure(
      await t.run({ action: 'apply_current', expectedRevision: 9, expectedSessionRevision: 'session-1' }),
      'revision-conflict',
    )
    expectFailure(await t.run({ action: 'apply_current', expectedRevision: 10 }), 'invalid-request')
    expect(
      await t.run({ action: 'apply_current', expectedRevision: 10, expectedSessionRevision: 'old' }),
    ).toMatchObject({ ok: false, globalSaved: true, currentApplied: false, code: 'session-revision-conflict' })
    expect(t.port.mutate).not.toHaveBeenCalled()
  })
  it('drops disposed owner plans instead of retaining the entire global capacity', async () => {
    const t = setup()
    const owners = Array.from({ length: 5 }, (_, i) => fakeAgent(`owner-${i}`))
    for (const owner of owners) {
      t.live.add(owner)
      for (let i = 0; i < 20; i++)
        expect((await t.run({ action: 'preview', expectedRevision: t.state.revision, changes: [] }, owner)).ok).toBe(
          true,
        )
    }
    expectFailure(await t.preview([]), 'too-many-plans')
    for (const owner of owners) {
      t.service.disposeAgent(owner)
      t.live.delete(owner)
    }
    expect((await t.preview([])).ok).toBe(true)
  })
  it.each(['timeout', 'agent', 'plugin', 'revoke'] as const)(
    'settles hung model metadata on %s without writes or raw provider errors',
    async kind => {
      const t = setup({ metadataTimeoutMs: kind === 'timeout' ? 10 : 1000 })
      const entered = deferred()
      t.catalogFns.models.mockImplementation(async (_request, signal) => {
        entered.resolve()
        return await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal?.reason)
          signal?.addEventListener('abort', abort, { once: true })
          if (signal?.aborted) abort()
        })
      })
      const running = t.run({ action: 'models', target: 'dsh', provider: 'fake' })
      await entered.promise
      if (kind === 'agent') t.service.disposeAgent(t.agent)
      if (kind === 'plugin') t.service.dispose()
      if (kind === 'revoke') t.service.revoke()
      const result = await running
      expect(result).toMatchObject({ ok: false, code: kind === 'timeout' ? 'metadata-timeout' : 'operation-aborted' })
      expect(t.port.mutate).not.toHaveBeenCalled()
    },
  )

  it('bounds per-caller plans and permits new plans after expiry cleanup', async () => {
    const t = setup()
    for (let i = 0; i < 20; i++) expect((await t.preview([])).ok).toBe(true)
    expectFailure(await t.preview([]), 'too-many-plans')
    t.state.clock += 101
    expect((await t.preview([])).ok).toBe(true)
  })
  it('rechecks authorization after asynchronous metadata work and respects cancellation', async () => {
    const t = setup()
    const wait = deferred()
    t.catalogFns.models.mockImplementationOnce(async () => {
      await wait.promise
      return { models: [], status: 'unknown' }
    })
    const reply = t.run({ action: 'models', target: 'pi' })
    t.gate(false)
    wait.resolve()
    expectFailure(await reply, 'management-disabled')
    t.gate(true)
    const controller = new AbortController()
    controller.abort(new Error('SECRET_ABORT'))
    const aborted = await t.run({ action: 'models', target: 'pi' }, t.agent, controller.signal)
    expect(aborted.ok).toBe(false)
    expect(JSON.stringify(aborted)).not.toContain('SECRET_ABORT')
    expect(t.catalogFns.models).toHaveBeenCalledTimes(1)
  })
})

describe('bounded role management audit', () => {
  it('stores metadata only, retains one hundred records and returns the newest twenty', async () => {
    const storage = fakeStorage()
    const audit = createManagementAudit(() => storage.facility)
    for (let i = 0; i < 105; i++)
      await audit.append({
        id: `audit-${i}`,
        at: new Date(i).toISOString(),
        sessionId: 'session',
        agentId: 'agent',
        operation: 'roles-change',
        roleIds: ['worker'],
        fields: ['instructions'],
        baseRevision: i,
        observedRevision: i + 1,
      })
    const result = await audit.list()
    expect(result.durable).toBe(true)
    expect(result.entries).toHaveLength(20)
    expect(result.entries[0]?.id).toBe('audit-85')
    const raw = storage.data.get('rolesubagents_management')?.get('history')?.get('recent') as { entries: unknown[] }
    expect(raw.entries).toHaveLength(100)
    await audit.close()
  })
  it('gracefully marks memory-only audit unavailable instead of failing role persistence', async () => {
    const audit = createManagementAudit(() => undefined)
    expect(
      await audit.append({
        id: 'audit',
        at: new Date(0).toISOString(),
        sessionId: 'session',
        agentId: 'agent',
        operation: 'apply-current',
        roleIds: ['worker'],
        fields: ['current-session-role-catalog'],
        baseRevision: 1,
        observedRevision: 1,
      }),
    ).toBe(false)
    expect(await audit.list()).toMatchObject({ durable: false, entries: [{ id: 'audit' }] })
    await audit.close()
  })
})
