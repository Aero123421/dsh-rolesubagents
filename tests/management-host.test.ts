import { describe, expect, it, vi } from 'vitest'
vi.mock('@deepseek-ai/dsh-tools', () => import('./host-fakes.ts').then(m => m.toolsModule()))
vi.mock('@deepseek-ai/dsh-storage-domain', () => import('./host-fakes.ts').then(m => m.storageDomainModule()))
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { apply, type Config } from '../src/host/index.ts'
import { DEFAULT_ROLES, type RoleDefinition } from '../src/shared/roles.ts'
import { execContext, fakeWorld, type FakeAgent, type FakeStorage } from './host-fakes.ts'

function activeTool(agent: FakeAgent, name: string): ToolDefinition | undefined {
  return agent.registered.filter((tool, i) => tool.name === name && agent.disposers[i]?.mock.calls.length === 0).at(-1)
}
function tool(agent: FakeAgent, name: string): ToolDefinition {
  const value = activeTool(agent, name)
  if (!value) throw new Error(`missing active ${name}`)
  return value
}
const enumOf = (definition: ToolDefinition) =>
  (definition.parameters as unknown as { properties: { role: { enum: string[] } } }).properties.role.enum
async function call(agent: FakeAgent, args: unknown, definition = tool(agent, 'manage_roles')) {
  return (await definition.execute(args, execContext(agent))) as Record<string, unknown>
}
async function setup(enabled = true, storage?: FakeStorage, roles: readonly RoleDefinition[] = DEFAULT_ROLES) {
  const world = fakeWorld(storage)
  const snapshotHooks: {
    before?: (key: string, value: unknown) => void | Promise<void>
    after?: (key: string, value: unknown) => void | Promise<void>
  } = {}
  world.services.storageDomain = {
    async open(spec) {
      const domain = await world.storage.facility.open(spec)
      return {
        ...domain,
        table(name) {
          const table = domain.table(name)
          return {
            ...table,
            async put(key, value) {
              const selected = (spec as { name?: string }).name === 'rolesubagents' && name === 'snapshots'
              if (selected) await snapshotHooks.before?.(key, value)
              await table.put(key, value)
              if (selected) await snapshotHooks.after?.(key, value)
            },
          }
        },
      }
    },
  }
  world.services.sandboxPolicy = { resolve: () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) }
  const root = world.newAgent('root')
  world.agents = [root]
  const raw: Record<string, unknown> = {
    enabled: true,
    roles: structuredClone(roles),
    workflowModel: { provider: 'workflow-provider', model: 'workflow-model' },
    allowAiRoleManagement: enabled,
    clis: {},
  }
  let revision = 1
  const settings = {
    writable: true,
    describe: () => [{ ns: 'rolesubagents', revision, value: structuredClone(raw) }],
    mutate: vi.fn(
      async (ns: string, ops: readonly { op: string; path: readonly string[]; value: unknown }[], expected: number) => {
        if (ns !== 'rolesubagents') throw new Error('wrong namespace')
        if (expected !== revision) throw Object.assign(new Error('conflict'), { code: 'SETTINGS_CONFLICT' })
        expect(ops).toHaveLength(1)
        expect(ops[0]?.path).toEqual(['roles'])
        raw.roles = structuredClone(ops[0]!.value)
        revision++
        world.emitVolatileUpdate()
      },
    ),
  }
  world.services.settings = settings
  const config: Partial<Config> = {
    enabled: { get: () => raw.enabled as boolean },
    roles: { get: () => raw.roles as unknown[] },
    workflowModel: { get: () => raw.workflowModel },
    allowAiRoleManagement: { get: () => raw.allowAiRoleManagement === true },
  }
  apply(world.ctx, config, { managementNamespace: () => 'rolesubagents' })
  await world.settle()
  return {
    world,
    root,
    raw,
    settings,
    config,
    snapshotHooks,
    revision: () => revision,
    toggle(value: boolean) {
      raw.allowAiRoleManagement = value
      revision++
      world.emitVolatileUpdate()
    },
  }
}
async function save(t: Awaited<ReturnType<typeof setup>>, changes: unknown[]) {
  const preview = await call(t.root, { action: 'preview', expectedRevision: t.revision(), changes })
  expect(preview.ok).toBe(true)
  const result = await call(t.root, { action: 'apply', planId: preview.planId })
  expect(result.ok).toBe(true)
  return result
}
async function refresh(root: FakeAgent) {
  const current = await call(root, { action: 'list' })
  return call(root, {
    action: 'apply_current',
    expectedRevision: current.revision,
    expectedSessionRevision: (current.currentSession as { revision: string }).revision,
  })
}
const create = {
  op: 'create',
  role: { id: 'fresh_worker', description: 'A newly configured worker', instructions: 'FRESH_INSTRUCTIONS' },
}
const delegateArgs = { role: 'worker', description: 'small task', prompt: 'run this task' }
function barrier() {
  let release!: () => void
  const promise = new Promise<void>(resolve => {
    release = resolve
  })
  return { promise, release }
}
const snapshotHasFresh = (value: unknown) =>
  (value as { settings: { roles: { id: string }[] } }).settings.roles.some(r => r.id === 'fresh_worker')

describe('manage_roles Host integration', () => {
  it('is OFF by default, appears after a live permission update and revokes captured tools on OFF', async () => {
    const t = await setup(false)
    expect(activeTool(t.root, 'manage_roles')).toBeUndefined()
    t.toggle(true)
    const captured = tool(t.root, 'manage_roles')
    expect((await call(t.root, { action: 'list' }, captured)).ok).toBe(true)
    t.toggle(false)
    expect(activeTool(t.root, 'manage_roles')).toBeUndefined()
    expect((await call(t.root, { action: 'list' }, captured)).ok).toBe(false)
    expect(t.settings.mutate).not.toHaveBeenCalled()
    await t.world.teardown()
  })
  it('saves globally without changing current enum, then explicitly refreshes only future parent delegations', async () => {
    const t = await setup()
    const old = tool(t.root, 'delegate')
    const other = t.world.newAgent('other')
    await t.world.emitCreated(other)
    await old.execute(delegateArgs, execContext(t.root))
    const child = t.world.children[0]!
    const childEnum = enumOf(tool(child, 'delegate'))
    const childContext = t.world.runtimeContext(child)
    const before = t.world.storedSnapshot(t.root.session.id) as {
      settings: { workflowModel: unknown; enabled: boolean }
    }
    const result = await save(t, [
      create,
      { op: 'update', id: 'worker', patch: { instructions: 'NEW_WORKER_INSTRUCTIONS' } },
      { op: 'delete', id: 'reviewer' },
    ])
    expect(result.currentApplied).toBe(false)
    expect(enumOf(tool(t.root, 'delegate'))).not.toContain('fresh_worker')
    const updated = await refresh(t.root)
    expect(updated).toMatchObject({ ok: true, currentApplied: true, sessionDurable: true })
    const fresh = tool(t.root, 'delegate')
    expect(enumOf(fresh)).toContain('fresh_worker')
    expect(enumOf(fresh)).not.toContain('reviewer')
    expect(enumOf(tool(other, 'delegate'))).not.toContain('fresh_worker')
    expect(enumOf(tool(child, 'delegate'))).toEqual(childEnum)
    expect(t.world.runtimeContext(child)).toBe(childContext)
    expect(t.world.runtimeContext(child)).not.toContain('NEW_WORKER_INSTRUCTIONS')
    const calls = t.world.subagents.startActivation.mock.calls.length
    await expect(old.execute(delegateArgs, execContext(t.root))).rejects.toThrow(/catalog.*changed|refreshed/)
    expect(t.world.subagents.startActivation.mock.calls).toHaveLength(calls)
    await fresh.execute({ ...delegateArgs, role: 'worker' }, execContext(t.root))
    const newChild = t.world.children.at(-1)!
    expect(t.world.runtimeContext(newChild)).toContain('NEW_WORKER_INSTRUCTIONS')
    expect(enumOf(tool(newChild, 'delegate'))).toContain('fresh_worker')
    const after = t.world.storedSnapshot(t.root.session.id) as {
      settings: { workflowModel: unknown; enabled: boolean }
    }
    expect(after.settings.workflowModel).toEqual(before.settings.workflowModel)
    expect(after.settings.enabled).toBe(before.settings.enabled)
    await t.world.teardown()
  })
  it('does not let inherited root definitions run in a child even if retained directly', async () => {
    const t = await setup()
    const manager = tool(t.root, 'manage_roles')
    const delegate = tool(t.root, 'delegate')
    await delegate.execute(delegateArgs, execContext(t.root))
    const child = t.world.children[0]!
    expect(activeTool(child, 'manage_roles')).toBeUndefined()
    expect(
      child.guards.some(check => check({ name: 'manage_roles', arguments: { action: 'list' } }) !== undefined),
    ).toBe(true)
    const reply = (await manager.execute({ action: 'list' }, execContext(child))) as { ok: boolean }
    expect(reply.ok).toBe(false)
    await expect(delegate.execute(delegateArgs, execContext(child))).rejects.toThrow(/calling agent|refreshed/)
    expect(t.settings.mutate).not.toHaveBeenCalled()
    await t.world.teardown()
  })
  it('allows a user fork with parentSession lineage but rejects actual delegated headers', async () => {
    const t = await setup()
    const fork = t.world.newAgent('user-fork', { origin: 'fork', parentSession: t.root.session.id, delegationDepth: 0 })
    await t.world.emitCreated(fork)
    expect((await call(fork, { action: 'list' })).ok).toBe(true)
    for (const header of [{ origin: 'subagent' }, { delegationDepth: 1 }]) {
      const child = t.world.newAgent(`header-${JSON.stringify(header)}`, header)
      await t.world.emitCreated(child)
      expect(activeTool(child, 'manage_roles')).toBeUndefined()
    }
    await t.world.teardown()
  })
  it('rejects a stale active-catalog revision without changing current registrations', async () => {
    const t = await setup()
    const old = tool(t.root, 'delegate')
    await save(t, [create])
    const result = await call(t.root, {
      action: 'apply_current',
      expectedRevision: t.revision(),
      expectedSessionRevision: 'stale',
    })
    expect(result).toMatchObject({ ok: false, currentApplied: false, code: 'session-revision-conflict' })
    expect(tool(t.root, 'delegate')).toBe(old)
    expect(enumOf(old)).not.toContain('fresh_worker')
    await t.world.teardown()
  })
  it('preserves explicitly refreshed catalog across resume while an unrefreshed child retains its snapshot', async () => {
    const t = await setup()
    await tool(t.root, 'delegate').execute(delegateArgs, execContext(t.root))
    const child = t.world.children[0]!
    await save(t, [create])
    expect((await refresh(t.root)).ok).toBe(true)
    const shared = t.world.storage
    const childId = child.id
    const childHeader = child.session.header
    await t.world.teardown()
    const resumed = fakeWorld(shared)
    const parent2 = resumed.newAgent('root')
    const child2 = resumed.newAgent(childId, childHeader)
    resumed.agents = [parent2, child2]
    apply(resumed.ctx, t.config, { managementNamespace: () => 'rolesubagents' })
    await resumed.settle()
    expect(enumOf(tool(parent2, 'delegate'))).toContain('fresh_worker')
    expect(enumOf(tool(child2, 'delegate'))).not.toContain('fresh_worker')
    expect(activeTool(child2, 'manage_roles')).toBeUndefined()
    await resumed.teardown()
  })
  it('reports global save separately when Session storage cannot support current refresh', async () => {
    const world = fakeWorld()
    world.services.sandboxPolicy = { resolve: () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }) }
    delete world.services.storageDomain
    const root = world.newAgent('memory-root')
    world.agents = [root]
    let revision = 1
    const raw: Record<string, unknown> = { allowAiRoleManagement: true, roles: structuredClone(DEFAULT_ROLES) }
    world.services.settings = {
      writable: true,
      describe: () => [{ ns: 'rolesubagents', value: raw, revision }],
      mutate: async (_ns: string, ops: { value: unknown }[], expected: number) => {
        expect(expected).toBe(revision)
        raw.roles = structuredClone(ops[0]!.value)
        revision++
      },
    }
    apply(
      world.ctx,
      { roles: { get: () => raw.roles as unknown[] }, allowAiRoleManagement: true },
      { managementNamespace: () => 'rolesubagents' },
    )
    await world.settle()
    const p = await call(root, { action: 'preview', expectedRevision: revision, changes: [create] })
    expect((await call(root, { action: 'apply', planId: p.planId })).globalSaved).toBe(true)
    const result = await refresh(root)
    expect(result).toMatchObject({
      ok: false,
      globalSaved: true,
      currentApplied: false,
      sessionDurable: false,
      code: 'session-storage-unavailable',
    })
    expect(enumOf(tool(root, 'delegate'))).not.toContain('fresh_worker')
    await world.teardown()
  })
  it('revokes captured delegate and manager after Agent disposal and plugin unload', async () => {
    const t = await setup()
    const delegate = tool(t.root, 'delegate')
    const manager = tool(t.root, 'manage_roles')
    t.world.emitDisposed(t.root)
    expect((await call(t.root, { action: 'list' }, manager)).ok).toBe(false)
    await expect(delegate.execute(delegateArgs, execContext(t.root))).rejects.toThrow(/catalog.*changed|refreshed/)
    await t.world.teardown()
  })
  it.each(['off', 'roles'] as const)(
    'revalidates %s after the initial Session flush before writing its catalog',
    async change => {
      const t = await setup()
      await save(t, [create])
      const old = tool(t.root, 'delegate')
      const state = await call(t.root, { action: 'list' })
      const blocked = barrier()
      t.snapshotHooks.before = key => (key === 'session-flush-blocker' ? blocked.promise : undefined)
      const blocker = t.world.newAgent('flush-blocker')
      const creating = t.world.emitCreated(blocker)
      await t.world.settle()
      const args = {
        action: 'apply_current',
        expectedRevision: state.revision,
        expectedSessionRevision: (state.currentSession as { revision: string }).revision,
      }
      const running = call(t.root, args)
      expect(await call(t.root, args)).toMatchObject({ ok: false, code: 'session-refresh-busy' })
      if (change === 'off') t.toggle(false)
      else
        await t.settings.mutate(
          'rolesubagents',
          [
            {
              op: 'set',
              path: ['roles'],
              value: [
                ...(t.raw.roles as unknown[]),
                {
                  id: 'ui_role',
                  description: 'Concurrent UI role',
                  enabled: true,
                  instructions: '',
                  context: 'spawn',
                  readOnly: false,
                },
              ],
            },
          ],
          t.revision(),
        )
      blocked.release()
      await creating
      expect(await running).toMatchObject({
        ok: false,
        currentApplied: false,
        globalSaved: true,
        code: change === 'off' ? 'management-disabled' : 'revision-conflict',
        sessionOutcome: 'unchanged',
      })
      expect(tool(t.root, 'delegate')).toBe(old)
      expect(snapshotHasFresh(t.world.storedSnapshot(t.root.session.id))).toBe(false)
      await t.world.teardown()
    },
  )
  it.each(['off', 'readonly'] as const)(
    'does not publish after %s during the candidate durability wait, and restores the old Session',
    async change => {
      const t = await setup()
      await save(t, [create])
      const old = tool(t.root, 'delegate')
      const entered = barrier(),
        blocked = barrier()
      let paused = false
      t.snapshotHooks.after = (key, value) => {
        if (!paused && key === t.root.session.id && snapshotHasFresh(value)) {
          paused = true
          entered.release()
          return blocked.promise
        }
      }
      const running = refresh(t.root)
      await entered.promise
      const fork = t.world.newAgent('while-pending', {
        origin: 'web',
        parentSession: t.root.session.id,
        delegationDepth: 0,
      })
      const creating = t.world.emitCreated(fork)
      await t.world.settle()
      expect(enumOf(tool(fork, 'delegate'))).not.toContain('fresh_worker')
      expect(enumOf(old)).not.toContain('fresh_worker')
      if (change === 'off') t.toggle(false)
      else t.world.services.sandboxPolicy = { resolve: () => ({ mode: 'read-only', workspaceRoot: process.cwd() }) }
      blocked.release()
      await creating
      expect(await running).toMatchObject({
        ok: false,
        currentApplied: false,
        globalSaved: true,
        sessionOutcome: 'restored',
        code: change === 'off' ? 'management-disabled' : 'read-only-caller',
      })
      expect(tool(t.root, 'delegate')).toBe(old)
      expect(snapshotHasFresh(t.world.storedSnapshot(t.root.session.id))).toBe(false)
      expect((t.raw.roles as { id: string }[]).some(r => r.id === 'fresh_worker')).toBe(true)
      expect(enumOf(tool(fork, 'delegate'))).not.toContain('fresh_worker')
      expect(snapshotHasFresh(t.world.storedSnapshot(fork.session.id))).toBe(false)
      await t.world.teardown()
    },
  )
  it('shields a replacement Agent with the same Session id until the disposed refresh rolls back', async () => {
    const t = await setup()
    await save(t, [
      create,
      {
        op: 'update',
        id: 'worker',
        patch: { description: 'Replacement-only worker', instructions: 'REPLACEMENT_INSTRUCTIONS' },
      },
    ])
    const oldDelegate = tool(t.root, 'delegate')
    const oldManager = tool(t.root, 'manage_roles')
    const oldState = await call(t.root, { action: 'list' })
    const entered = barrier(),
      blocked = barrier()
    let paused = false
    t.snapshotHooks.after = (key, value) => {
      if (!paused && key === t.root.session.id && snapshotHasFresh(value)) {
        paused = true
        entered.release()
        return blocked.promise
      }
    }
    const running = refresh(t.root)
    let busy: Promise<Record<string, unknown>> | undefined
    let creating: Promise<void> | undefined
    let creatingFork: Promise<void> | undefined
    try {
      await entered.promise
      expect(snapshotHasFresh(t.world.storedSnapshot(t.root.session.id))).toBe(true)
      t.world.emitDisposed(t.root)
      const replacement = t.world.newAgent('root')
      expect(replacement.session.id).toBe(t.root.session.id)
      expect(replacement === t.root).toBe(false)
      t.world.agents = [replacement]
      creating = t.world.emitCreated(replacement, 'resume')
      await t.world.settle()
      const replacementDelegate = tool(replacement, 'delegate')
      expect(enumOf(replacementDelegate)).not.toContain('fresh_worker')
      expect(replacementDelegate.description).not.toContain('Replacement-only worker')
      const listed = await call(replacement, { action: 'list' })
      expect((listed.currentSession as { revision: string }).revision).toBe(
        (oldState.currentSession as { revision: string }).revision,
      )
      expect((listed.currentSession as { roleIds: string[] }).roleIds).not.toContain('fresh_worker')
      let busySettled = false
      busy = refresh(replacement).then(result => {
        busySettled = true
        return result
      })
      await t.world.settle()
      expect(busySettled).toBe(true)
      expect(await busy).toMatchObject({ ok: false, currentApplied: false, code: 'session-refresh-busy' })
      const fork = t.world.newAgent('replacement-fork', {
        origin: 'web',
        parentSession: replacement.session.id,
        delegationDepth: 0,
      })
      creatingFork = t.world.emitCreated(fork)
      await t.world.settle()
      expect(enumOf(tool(fork, 'delegate'))).not.toContain('fresh_worker')
      expect(snapshotHasFresh(t.world.storedSnapshot(fork.session.id))).toBe(false)
      blocked.release()
      await creating
      expect(await running).toMatchObject({
        ok: false,
        globalSaved: true,
        currentApplied: false,
        sessionOutcome: 'restored',
      })
      expect(snapshotHasFresh(t.world.storedSnapshot(replacement.session.id))).toBe(false)
      expect(tool(replacement, 'delegate')).toBe(replacementDelegate)
      expect((await call(t.root, { action: 'list' }, oldManager)).ok).toBe(false)
      await expect(oldDelegate.execute(delegateArgs, execContext(t.root))).rejects.toThrow(/catalog.*changed|refreshed/)
      expect(await refresh(replacement)).toMatchObject({ ok: true, currentApplied: true, sessionDurable: true })
      const current = tool(replacement, 'delegate')
      expect(enumOf(current)).toContain('fresh_worker')
      expect(current.description).toContain('Replacement-only worker')
      expect(snapshotHasFresh(t.world.storedSnapshot(replacement.session.id))).toBe(true)
      expect(enumOf(tool(fork, 'delegate'))).not.toContain('fresh_worker')
      expect(snapshotHasFresh(t.world.storedSnapshot(fork.session.id))).toBe(false)
      await current.execute(delegateArgs, execContext(replacement))
      const child = t.world.children.at(-1)!
      await t.world.settle()
      expect(t.world.runtimeContext(child)).toContain('REPLACEMENT_INSTRUCTIONS')
      expect(enumOf(tool(child, 'delegate'))).toContain('fresh_worker')
      expect(snapshotHasFresh(t.world.storedSnapshot(child.session.id))).toBe(true)
      expect((t.raw.roles as { id: string }[]).some(role => role.id === 'fresh_worker')).toBe(true)
    } finally {
      blocked.release()
      await running
      await busy
      await creating
      await creatingFork
      await t.world.teardown()
    }
  })

  it('awaits candidate rollback during plugin teardown and never publishes a post-unload registry', async () => {
    const t = await setup()
    await save(t, [create])
    const oldDelegate = tool(t.root, 'delegate')
    const registrationCount = t.root.register.mock.calls.length
    const candidateEntered = barrier(),
      candidateBlocked = barrier(),
      rollbackEntered = barrier(),
      rollbackBlocked = barrier()
    let paused = false
    t.snapshotHooks.after = (key, value) => {
      if (!paused && key === t.root.session.id && snapshotHasFresh(value)) {
        paused = true
        candidateEntered.release()
        return candidateBlocked.promise
      }
    }
    t.snapshotHooks.before = (key, value) => {
      if (paused && key === t.root.session.id && !snapshotHasFresh(value)) {
        rollbackEntered.release()
        return rollbackBlocked.promise
      }
    }
    const running = refresh(t.root)
    await candidateEntered.promise
    const closed = vi.fn()
    const closing = t.world.teardown().then(() => {
      closed()
    })
    try {
      await t.world.settle()
      expect(closed).not.toHaveBeenCalled()
      expect(activeTool(t.root, 'delegate')).toBeUndefined()
      expect(activeTool(t.root, 'manage_roles')).toBeUndefined()
      expect(t.root.register).toHaveBeenCalledTimes(registrationCount)
      expect(snapshotHasFresh(t.world.storedSnapshot(t.root.session.id))).toBe(true)
      candidateBlocked.release()
      await rollbackEntered.promise
      expect(closed).not.toHaveBeenCalled()
      expect(snapshotHasFresh(t.world.storedSnapshot(t.root.session.id))).toBe(true)
      rollbackBlocked.release()
      expect(await running).toMatchObject({
        ok: false,
        globalSaved: true,
        currentApplied: false,
        sessionOutcome: 'restored',
      })
      await closing
      expect(closed).toHaveBeenCalledTimes(1)
      expect(snapshotHasFresh(t.world.storedSnapshot(t.root.session.id))).toBe(false)
      expect(activeTool(t.root, 'delegate')).toBeUndefined()
      expect(activeTool(t.root, 'manage_roles')).toBeUndefined()
      expect(t.root.register).toHaveBeenCalledTimes(registrationCount)
      await expect(oldDelegate.execute(delegateArgs, execContext(t.root))).rejects.toThrow(/catalog.*changed|refreshed/)
      expect(t.world.children).toHaveLength(0)
      expect((t.raw.roles as { id: string }[]).some(role => role.id === 'fresh_worker')).toBe(true)
    } finally {
      candidateBlocked.release()
      rollbackBlocked.release()
      await running
      await closing
    }
  })

  it.each(['plugin-unload', 'agent-disposal'] as const)(
    'does not start a native child after %s while model validation was pending',
    async lifecycle => {
      const oldModel = { provider: 'old-provider', model: 'old-model', reasoningEffort: 'low' }
      const roles = DEFAULT_ROLES.map(role =>
        role.id === 'worker' ? { ...role, model: oldModel, instructions: 'ADMITTED_OLD_INSTRUCTIONS' } : role,
      )
      const t = await setup(true, undefined, roles)
      const delegate = tool(t.root, 'delegate')
      const entered = barrier(),
        blocked = barrier()
      const llm = t.world.services.llm!
      llm.resolveCallConfig.mockImplementationOnce(async () => {
        entered.release()
        await blocked.promise
        return {}
      })
      const outcome = delegate.execute(delegateArgs, execContext(t.root)).then(
        value => ({ status: 'fulfilled' as const, value }),
        error => ({ status: 'rejected' as const, error }),
      )
      let closing: Promise<void> | undefined
      try {
        await entered.promise
        expect(llm.resolveCallConfig.mock.calls[0]?.[0]).toEqual(oldModel)
        const signal = llm.resolveCallConfig.mock.calls[0]?.[1]
        expect(signal?.aborted).toBe(false)
        expect(t.world.subagents.startActivation).not.toHaveBeenCalled()
        if (lifecycle === 'plugin-unload') closing = t.world.teardown()
        else t.world.emitDisposed(t.root)
        expect(signal?.aborted).toBe(true)
        blocked.release()
        expect(await outcome).toMatchObject({ status: 'rejected' })
        await closing
        expect(t.world.subagents.startActivation).not.toHaveBeenCalled()
        expect(t.world.children).toHaveLength(0)
        expect(t.world.storage.data.get('rolesubagents')?.get('roles')?.size ?? 0).toBe(0)
        expect(activeTool(t.root, 'delegate')).toBeUndefined()
      } finally {
        blocked.release()
        await outcome
        await closing
        await t.world.teardown()
      }
    },
  )

  it('preserves an already-admitted native role through catalog refresh without canceling its model validation', async () => {
    const oldModel = { provider: 'old-provider', model: 'old-model', reasoningEffort: 'low' }
    const newModel = { provider: 'new-provider', model: 'new-model', reasoningEffort: 'high' }
    const oldInstructions = 'ADMITTED_OLD_INSTRUCTIONS'
    const newInstructions = 'FUTURE_NEW_INSTRUCTIONS'
    const roles = DEFAULT_ROLES.map(role =>
      role.id === 'worker' ? { ...role, model: oldModel, instructions: oldInstructions } : role,
    )
    const t = await setup(true, undefined, roles)
    const oldDelegate = tool(t.root, 'delegate')
    const entered = barrier(),
      blocked = barrier()
    const llm = t.world.services.llm!
    llm.resolveCallConfig.mockImplementationOnce(async () => {
      entered.release()
      await blocked.promise
      return {}
    })
    const admitted = oldDelegate.execute(delegateArgs, execContext(t.root))
    try {
      await entered.promise
      const oldSignal = llm.resolveCallConfig.mock.calls[0]?.[1]
      expect(oldSignal?.aborted).toBe(false)
      await save(t, [create, { op: 'update', id: 'worker', patch: { model: newModel, instructions: newInstructions } }])
      expect(await refresh(t.root)).toMatchObject({ ok: true, currentApplied: true, sessionDurable: true })
      expect(llm.resolveCallConfig).toHaveBeenCalledTimes(1)
      expect(oldSignal?.aborted).toBe(false)
      const current = tool(t.root, 'delegate')
      expect(enumOf(current)).toContain('fresh_worker')
      await expect(oldDelegate.execute(delegateArgs, execContext(t.root))).rejects.toThrow(/catalog.*changed|refreshed/)
      expect(llm.resolveCallConfig).toHaveBeenCalledTimes(1)
      expect(t.world.subagents.startActivation).not.toHaveBeenCalled()
      blocked.release()
      expect(await admitted).toMatchObject({ kind: 'activation' })
      expect(t.world.subagents.startActivation.mock.calls[0]?.[0].request.agentOptions).toEqual(oldModel)
      const oldChild = t.world.children[0]!
      await t.world.settle()
      expect(t.world.runtimeContext(oldChild)).toContain(oldInstructions)
      expect(t.world.runtimeContext(oldChild)).not.toContain(newInstructions)
      expect(enumOf(tool(oldChild, 'delegate'))).not.toContain('fresh_worker')
      expect(snapshotHasFresh(t.world.storedSnapshot(oldChild.session.id))).toBe(false)
      expect(t.world.storedRole(oldChild.session.id)).toMatchObject({
        role: { id: 'worker', model: oldModel, instructions: oldInstructions },
      })
      expect(t.world.storedSnapshot(oldChild.session.id)).toMatchObject({
        settings: {
          roles: expect.arrayContaining([
            expect.objectContaining({ id: 'worker', model: oldModel, instructions: oldInstructions }),
          ]),
        },
      })
      expect(snapshotHasFresh(t.world.storedSnapshot(t.root.session.id))).toBe(true)
      await current.execute(delegateArgs, execContext(t.root))
      expect(t.world.subagents.startActivation.mock.calls[1]?.[0].request.agentOptions).toEqual(newModel)
      const newChild = t.world.children[1]!
      await t.world.settle()
      expect(t.world.runtimeContext(newChild)).toContain(newInstructions)
      expect(enumOf(tool(newChild, 'delegate'))).toContain('fresh_worker')
      expect(snapshotHasFresh(t.world.storedSnapshot(newChild.session.id))).toBe(true)
      expect(t.world.storedRole(newChild.session.id)).toMatchObject({
        role: { id: 'worker', model: newModel, instructions: newInstructions },
      })
      expect(t.world.runtimeContext(oldChild)).toContain(oldInstructions)
      expect(snapshotHasFresh(t.world.storedSnapshot(oldChild.session.id))).toBe(false)
    } finally {
      blocked.release()
      await admitted
      await t.world.teardown()
    }
  })

  it('acknowledges a candidate write failure so rollback and a subsequent refresh can succeed', async () => {
    const t = await setup()
    await save(t, [create])
    const previous = tool(t.root, 'delegate')
    const writes: boolean[] = []
    let failed = false
    t.snapshotHooks.before = (key, value) => {
      if (key !== t.root.session.id) return
      const candidate = snapshotHasFresh(value)
      writes.push(candidate)
      if (candidate && !failed) {
        failed = true
        throw new Error('CANDIDATE_STORAGE_SECRET')
      }
    }
    const result = await refresh(t.root)
    expect(result).toMatchObject({
      ok: false,
      globalSaved: true,
      currentApplied: false,
      sessionOutcome: 'restored',
      code: 'session-storage-failed',
    })
    expect(JSON.stringify(result)).not.toContain('CANDIDATE_STORAGE_SECRET')
    expect(writes).toEqual([true, false])
    expect(tool(t.root, 'delegate')).toBe(previous)
    expect(snapshotHasFresh(t.world.storedSnapshot(t.root.session.id))).toBe(false)
    expect(await refresh(t.root)).toMatchObject({ ok: true, currentApplied: true, sessionDurable: true })
    expect(writes).toEqual([true, false, true])
    expect(enumOf(tool(t.root, 'delegate'))).toContain('fresh_worker')
    await t.world.teardown()
  })

  it('restores registry and Session state if registration fails after successful persistence', async () => {
    const t = await setup()
    await save(t, [create])
    t.root.register.mockImplementationOnce(() => {
      throw new Error('REGISTER_SECRET')
    })
    const result = await refresh(t.root)
    expect(result).toMatchObject({
      ok: false,
      globalSaved: true,
      currentApplied: false,
      sessionOutcome: 'restored',
      code: 'delegate-refresh-failed',
    })
    expect(JSON.stringify(result)).not.toContain('REGISTER_SECRET')
    expect(enumOf(tool(t.root, 'delegate'))).not.toContain('fresh_worker')
    expect(snapshotHasFresh(t.world.storedSnapshot(t.root.session.id))).toBe(false)
    await t.world.teardown()
  })

  it('does not require a full-access parent for default Pi/Grok workspace roles', async () => {
    const t = await setup()
    for (const cli of ['pi', 'grok-build']) {
      const preview = await call(t.root, {
        action: 'preview',
        expectedRevision: t.revision(),
        changes: [{ op: 'create', role: { id: `${cli}_role`, description: 'CLI role', runner: { cli } } }],
      })
      expect(preview.ok).toBe(true)
    }
    const native = await call(t.root, {
      action: 'preview',
      expectedRevision: t.revision(),
      changes: [
        {
          op: 'create',
          role: { id: 'native_role', description: 'Full-native role', runner: { cli: 'pi', permission: 'native' } },
        },
      ],
    })
    expect(native).toMatchObject({ ok: false, code: 'permission-ceiling' })
    await t.world.teardown()
  })
})
