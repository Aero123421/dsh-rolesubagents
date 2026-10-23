import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoleState } from '../src/host/state.ts'
import { buildTool, type ToolDeps } from '../src/host/tool.ts'
import type { RoleDefinition } from '../src/shared/roles.ts'
import { execContext, fakeProvider, fakeWorld, role, settingsOf } from './host-fakes.ts'

vi.mock('@deepseek-ai/dsh-tools', () => import('./host-fakes.ts').then(m => m.toolsModule()))
vi.mock('@deepseek-ai/dsh-storage-domain', () => import('./host-fakes.ts').then(m => m.storageDomainModule()))

const route = { provider: 'provider', model: 'model' }
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function delegation(patch: Partial<RoleDefinition> = {}, fences: Partial<ToolDeps> = {}) {
  const world = fakeWorld()
  const parent = world.newAgent('parent')
  const state = createRoleState(world.ctx)
  cleanups.push(() => state.close())
  const pending: ToolDeps['pending'] = new Map()
  const selected = role('worker', patch)
  const tool = buildTool(settingsOf([selected]), {
    ctx: world.ctx,
    spawnProvider: 'spawn',
    forkProvider: 'fork',
    state,
    pending,
    ...fences,
  })!
  return {
    world,
    pending,
    run: (signal?: AbortSignal) =>
      tool.execute({ role: selected.id, description: 'check policy', prompt: 'check' }, execContext(parent, signal)),
    options: () => world.subagents.startActivation.mock.calls.at(-1)?.[0].request.agentOptions,
  }
}

function holdResolution(world: ReturnType<typeof fakeWorld>) {
  let release!: () => void
  const wait = new Promise<void>(resolve => {
    release = resolve
  })
  world.services.llm!.resolveCallConfig.mockImplementation(() => wait)
  return release
}

describe('delegation model and provider policy', () => {
  it('owns undefined effort for an explicit model default, clearing same-route parent effort', async () => {
    const call = delegation({ model: route })
    await call.run()
    const options = call.options()!
    expect(options).toStrictEqual({ ...route, reasoningEffort: undefined })
    expect(Object.hasOwn(options, 'reasoningEffort')).toBe(true)
    expect({ ...route, reasoningEffort: 'high', ...options }).toStrictEqual({
      ...route,
      reasoningEffort: undefined,
    })
    expect(call.world.services.llm!.resolveCallConfig).toHaveBeenCalledWith(options, expect.any(AbortSignal))
    expect(call.pending.size).toBe(0)
  })

  it('preserves explicit effort and omits all options for an inherited route', async () => {
    const explicit = delegation({ model: { ...route, reasoningEffort: 'low' } })
    await explicit.run()
    expect(explicit.options()).toStrictEqual({ ...route, reasoningEffort: 'low' })
    const inherited = delegation()
    delete inherited.world.services.llm
    await inherited.run()
    expect(inherited.world.subagents.startActivation.mock.calls[0]![0].request).not.toHaveProperty('agentOptions')
  })

  it('refuses explicit models without llm validation and propagates route errors before admission', async () => {
    const missing = delegation({ model: route })
    delete missing.world.services.llm
    await expect(missing.run()).rejects.toThrow('`llm` service is unavailable')
    expect(missing.world.subagents.startActivation).not.toHaveBeenCalled()
    expect(missing.pending.size).toBe(0)
    const invalid = delegation({ model: route })
    invalid.world.services.llm!.resolveCallConfig.mockRejectedValue(new Error('unknown route'))
    await expect(invalid.run()).rejects.toThrow('unknown route')
    expect(invalid.world.subagents.startActivation).not.toHaveBeenCalled()
    expect(invalid.pending.size).toBe(0)
  })

  it.each(['removed', 'replaced'])('revalidates provider identity after waiting when %s', async change => {
    const call = delegation({ model: route })
    const release = holdResolution(call.world)
    const running = call.run()
    expect(call.world.services.llm!.resolveCallConfig).toHaveBeenCalledOnce()
    if (change === 'removed') call.world.providers.delete('spawn')
    else call.world.providers.set('spawn', fakeProvider('spawn'))
    release()
    await expect(running).rejects.toThrow('changed while resolving')
    expect(call.world.subagents.startActivation).not.toHaveBeenCalled()
    expect(call.pending.size).toBe(0)
  })

  it.each([false, undefined])(
    'requires affirmative history inheritance from a full-fork provider: %s',
    async inherits => {
      const call = delegation({ context: 'fork' })
      call.world.providers.set('fork', fakeProvider('fork', { inheritsParentContext: inherits }))
      await expect(call.run()).rejects.toThrow('requires the parent conversation')
      expect(call.world.subagents.startActivation).not.toHaveBeenCalled()
    },
  )

  it('allows affirmative full forks and keeps task-only forks on a fresh provider', async () => {
    const full = delegation({ context: 'fork' })
    await full.run()
    expect(full.world.subagents.startActivation.mock.calls[0]![0].provider).toBe('fork')
    const task = delegation({ context: 'fork', forkScope: 'task' })
    await task.run()
    expect(task.world.subagents.startActivation.mock.calls[0]![0].provider).toBe('spawn')
  })

  it('keeps current-owner/catalog checks at admission, not after an admitted model wait', async () => {
    let current = true
    const isCurrent = vi.fn(() => current)
    const call = delegation({ model: route }, { isCurrent })
    const release = holdResolution(call.world)
    const running = call.run()
    current = false
    release()
    await running
    expect(isCurrent).toHaveBeenCalledOnce()
    expect(call.world.subagents.startActivation).toHaveBeenCalledOnce()
    await expect(call.run()).rejects.toThrow('role catalog or calling agent changed')
    expect(call.world.subagents.startActivation).toHaveBeenCalledOnce()
  })

  it.each(['owner', 'lifetime', 'call'])('independently fences admitted work after %s revocation', async revoked => {
    let alive = true
    const lifetime = new AbortController()
    const signal = new AbortController()
    const call = delegation({ model: route }, { isAlive: () => alive, lifetime: lifetime.signal })
    const release = holdResolution(call.world)
    const running = call.run(signal.signal)
    if (revoked === 'owner') alive = false
    else if (revoked === 'lifetime') lifetime.abort(new Error('lifetime ended'))
    else signal.abort(new Error('call ended'))
    release()
    await expect(running).rejects.toThrow(revoked === 'owner' ? 'no longer active' : `${revoked} ended`)
    expect(call.world.subagents.startActivation).not.toHaveBeenCalled()
    expect(call.pending.size).toBe(0)
  })
})
