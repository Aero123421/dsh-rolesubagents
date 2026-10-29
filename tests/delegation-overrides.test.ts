import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/host/index.ts'
import { readOnlyCallDenial } from '../src/host/readonly.ts'
import { createRoleState } from '../src/host/state.ts'
import { buildTool, type PendingChild } from '../src/host/tool.ts'
import { resolveDelegationOverrides, validateDelegationArgs } from '../src/shared/delegation-overrides.ts'
import { normalizeSettings } from '../src/shared/roles.ts'
import { fakeSubprocess, line, testAdapter } from './external-fakes.ts'
import { builtinRole, execContext, fakeProvider, fakeWorld, registeredTool, role, settingsOf } from './host-fakes.ts'

vi.mock('@deepseek-ai/dsh-tools', () => import('./host-fakes.ts').then(module => module.toolsModule()))
vi.mock('@deepseek-ai/dsh-storage-domain', () => import('./host-fakes.ts').then(module => module.storageDomainModule()))

const ARGS = { description: 'check one task', prompt: 'Check this task.' }
const configured = () =>
  builtinRole('general', { model: { provider: 'old', model: 'old-model', reasoningEffort: 'high' } })

function setup(base = configured()) {
  const world = fakeWorld()
  const parent = world.newAgent('parent')
  const state = createRoleState(world.ctx)
  const pending = new Map<string, PendingChild>()
  const snapshot = settingsOf([base])
  const tool = buildTool(snapshot, { ctx: world.ctx, state, pending, spawnProvider: 'spawn', forkProvider: 'fork' })!
  const run = (args: Record<string, unknown> = {}) => tool.execute({ ...ARGS, ...args }, execContext(parent))
  return { world, parent, state, pending, snapshot, tool, run }
}

describe('one-shot role override validation', () => {
  it('clones and normalizes a replacement without mutating the selected role', () => {
    const base = configured()
    const before = structuredClone(base)
    const selected = resolveDelegationOverrides(base, { provider: ' new ', model: ' terra-max ', readOnly: true })
    expect(selected.model).toEqual({ provider: 'new', model: 'terra-max' })
    expect(selected.readOnly).toBe(true)
    expect(selected).not.toBe(base)
    expect(base).toEqual(before)
    expect(resolveDelegationOverrides(base, {}).model).toEqual(before.model)
  })

  it('requires explicit provider/model pairing and never guesses the parent route', () => {
    for (const args of [{ model: 'terra-max' }, { provider: 'new' }]) {
      expect(() => resolveDelegationOverrides(configured(), args)).toThrow('supplied together')
    }
    expect(() => resolveDelegationOverrides(builtinRole('general'), { effort: 'high' })).toThrow(
      'requires a configured role model',
    )
    expect(resolveDelegationOverrides(configured(), { effort: 'low' }).model).toEqual({
      provider: 'old',
      model: 'old-model',
      reasoningEffort: 'low',
    })
  })

  it.each([null, false, 3, '', '  ', 'x'.repeat(129), 'bad\nvalue'])('rejects invalid route strings: %j', value => {
    for (const field of ['model', 'provider', 'effort']) {
      expect(() => validateDelegationArgs({ ...ARGS, [field]: value })).toThrow()
    }
  })

  it.each(['runner', 'runtime', 'permission', 'agentPreset', 'context', 'reasoningEffort'])(
    'rejects unknown or permission-changing argument %s',
    field => {
      expect(() => validateDelegationArgs({ ...ARGS, [field]: 'anything' })).toThrow('unknown delegate argument')
    },
  )

  it('checks arguments even outside schema validation', () => {
    for (const args of [null, [], { ...ARGS, role: 42 }, { ...ARGS, cwd: false }, { prompt: 'only' }]) {
      expect(() => validateDelegationArgs(args)).toThrow()
    }
    for (const readOnly of [false, 'true', null, 1])
      expect(() => validateDelegationArgs({ ...ARGS, readOnly })).toThrow('may only be true')
  })

  it('preserves preset/context restrictions and rejects fork route overrides', () => {
    const base = role('preset', { agentPreset: 'review', readOnly: true })
    expect(resolveDelegationOverrides(base, { provider: 'new', model: 'terra-max' })).toMatchObject({
      agentPreset: 'review',
      readOnly: true,
      context: 'spawn',
    })
    for (const forkScope of ['full', 'task'] as const) {
      expect(() =>
        resolveDelegationOverrides(builtinRole('fork', { forkScope }), { provider: 'new', model: 'terra-max' }),
      ).toThrow('fork roles inherit')
    }
  })

  it('explicitly rejects CLI route fields but strengthens its native read-only preset', () => {
    const base = role('cli', { runner: { cli: 'codex', permission: 'workspace-write' } })
    for (const args of [{ model: 'new' }, { provider: 'new' }, { effort: 'high' }]) {
      expect(() => resolveDelegationOverrides(base, args)).toThrow('supported only for DSH roles')
    }
    const selected = resolveDelegationOverrides(base, { readOnly: true })
    expect(selected.runner).toMatchObject({ cli: 'codex', permission: 'read-only' })
    expect(selected.readOnly).toBe(true)
    expect(base.runner?.permission).toBe('workspace-write')
    expect(normalizeSettings({ roles: [selected] }).problems.filter(p => p.code !== 'builtin-missing')).toEqual([])
  })

  it('lets the parent read-only guard see the strengthened role, without weakening fork protection', () => {
    expect(readOnlyCallDenial('delegate', { ...ARGS, readOnly: true }, [builtinRole('general')])).toBeUndefined()
    expect(readOnlyCallDenial('delegate', ARGS, [builtinRole('general')])).toContain('not read-only')
    expect(readOnlyCallDenial('delegate', { ...ARGS, role: 'fork', readOnly: true }, [builtinRole('fork')])).toContain(
      'copy the parent',
    )
    expect(
      readOnlyCallDenial('delegate', { ...ARGS, readOnly: false }, [builtinRole('general', { readOnly: true })]),
    ).toContain('cannot be weakened')
  })
})

describe('delegate one-shot execution', () => {
  it('runs external read-only strengthening through the existing adapter and does not persist role changes', async () => {
    const base = role('cli', { runner: { cli: 'codex', permission: 'danger-full-access', model: 'configured-model' } })
    const before = structuredClone(base)
    const world = fakeWorld()
    world.services.subprocess = fakeSubprocess({
      onRun: async process => {
        await process.stdinClosed
        process.stdout(line({ type: 'done' }))
        process.exit(0)
      },
    })
    world.services.sandboxPolicy = { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: process.cwd() }) }
    const adapter = testAdapter()
    apply(world.ctx, { roles: [base] }, { adapters: () => adapter })
    const parent = world.newAgent('external-parent')
    await world.emitCreated(parent)
    const tool = registeredTool(parent)
    try {
      await expect(tool.execute({ ...ARGS, role: 'cli', model: 'ignored' }, execContext(parent))).rejects.toThrow(
        'supported only for DSH roles',
      )
      expect(world.subagents.startActivation).not.toHaveBeenCalled()
      await tool.execute({ ...ARGS, role: 'cli', cwd: process.cwd(), readOnly: true }, execContext(parent))
      expect(adapter.inputs[0]).toMatchObject({
        preset: 'read-only',
        access: 'read-only',
        runner: { model: 'configured-model' },
      })
      await world.externalRuns[0]?.result
      expect(base).toEqual(before)
      await tool.execute({ ...ARGS, role: 'cli', cwd: process.cwd() }, execContext(parent))
      expect(adapter.inputs[1]).toMatchObject({ preset: 'danger-full-access', access: 'full-access' })
      await world.externalRuns[1]?.result
      expect(world.services.llm?.resolveCallConfig).not.toHaveBeenCalled()
    } finally {
      await world.teardown()
    }
  })

  it('validates through the native resolver, clears old effort, and keeps the snapshot for later calls', async () => {
    const { world, pending, snapshot, run } = setup()
    const before = structuredClone(snapshot)
    const captured: PendingChild[] = []
    world.ctx.on('agent/created', () => {
      captured.push(...pending.values())
    })
    await run({ provider: 'new', model: 'terra-max', readOnly: true })
    expect(world.services.llm?.resolveCallConfig).toHaveBeenCalledWith(
      { provider: 'new', model: 'terra-max', reasoningEffort: undefined },
      expect.any(AbortSignal),
    )
    const options = world.subagents.startActivation.mock.calls[0]?.[0].request.agentOptions
    expect(options).toEqual({ provider: 'new', model: 'terra-max', reasoningEffort: undefined })
    expect(Object.hasOwn(options!, 'reasoningEffort')).toBe(true)
    expect(captured[0]?.role).toMatchObject({ readOnly: true, model: { model: 'terra-max' } })
    expect(captured[0]?.snapshot).toBe(snapshot)
    expect(snapshot).toEqual(before)
    await run()
    expect(world.subagents.startActivation.mock.calls[1]?.[0].request.agentOptions).toEqual(before.roles[0]?.model)
    expect(pending.size).toBe(0)
  })

  it('rejects native resolution failure before spawning or reserving a child', async () => {
    const { world, run, pending } = setup()
    world.services.llm!.resolveCallConfig.mockRejectedValue(new Error('unknown model or unsupported effort'))
    await expect(run({ provider: 'new', model: 'missing', effort: 'impossible' })).rejects.toThrow('unknown model')
    expect(world.subagents.startActivation).not.toHaveBeenCalled()
    expect(pending.size).toBe(0)
  })

  it('retains provider capability and preset checks', async () => {
    const { world, run } = setup(role('preset', { agentPreset: 'review' }))
    world.providers.set('spawn', fakeProvider('spawn', { capabilities: { agentOptions: true, agentPreset: false } }))
    await expect(run({ role: 'preset', provider: 'new', model: 'terra-max' })).rejects.toThrow(
      'cannot mount agent preset',
    )
    expect(world.subagents.startActivation).not.toHaveBeenCalled()
  })

  it('allows explicit read-only strengthening under a read-only parent; still refuses a writable child', async () => {
    const { state, parent, run, world } = setup()
    state.writeRole(parent.session, role('parent', { readOnly: true }))
    await expect(run()).rejects.toThrow('not read-only')
    await run({ readOnly: true })
    expect(world.subagents.startActivation).toHaveBeenCalledTimes(1)
  })

  it('errors on unknown role or invalid override before native resolution/spawn', async () => {
    const { run, world } = setup()
    await expect(run({ role: 'missing' })).rejects.toThrow(/unknown role|must be one of/)
    await expect(run({ permission: 'danger-full-access' })).rejects.toThrow()
    await expect(run({ readOnly: false })).rejects.toThrow('may only be true')
    expect(world.services.llm?.resolveCallConfig).not.toHaveBeenCalled()
    expect(world.subagents.startActivation).not.toHaveBeenCalled()
  })

  it('labels the receipt as a configured request, not confirmed execution, without changing its ID contract', async () => {
    const { run, tool } = setup()
    const args = { ...ARGS, provider: 'new', model: 'terra-max', effort: 'max', readOnly: true }
    const value = await run(args)
    expect(Object.keys(value as object).sort()).toEqual(['kind', 'subagentId'])
    const rendered = tool.output?.render?.(args, value as never)
    expect(JSON.stringify(rendered)).toContain('Configured request: new/terra-max; effort: max')
    expect(JSON.stringify(rendered)).toContain('not confirmed')
    expect(JSON.stringify(rendered)).toContain('Read-only:')
  })
})
