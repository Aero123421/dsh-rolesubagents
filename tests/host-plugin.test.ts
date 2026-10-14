import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, name } from '../src/host/index.ts'
import {
  ROLE_RECORD,
  ROLES_RECORD,
  readRole,
  readRolesSnapshot,
  writeRole,
  writeRolesSnapshot,
} from '../src/host/records.ts'
import {
  buildTool,
  type PendingChild,
  resolveRole,
  TOOL_NAME,
  type ToolDeps,
  toolDescription,
} from '../src/host/tool.ts'
import {
  DEFAULT_ROLES,
  DEFAULT_SETTINGS,
  normalizeSettings,
  type RoleDefinition,
  type RoleSettings,
  roleContextText,
  roleListLine,
  selectableRoles,
} from '../src/shared/roles.ts'
import {
  appendRecord,
  builtinRole,
  execContext,
  type FakeAgent,
  type FakeWorld,
  fakeAgent,
  fakeProvider,
  fakeSession,
  fakeWorld,
  recordsOf,
  registeredTool,
  role,
  settingsOf,
  typesOf,
} from './host-fakes.ts'

// `dsh-session` and the `dsh-tools` entry point load services that are not installed here, so both are replaced
// (see host-fakes.ts): records go to an in-memory log, and defineTool is the real one from the package's schema module.
vi.mock('@deepseek-ai/dsh-session', () => import('./host-fakes.ts').then(module => module.sessionModule()))
vi.mock('@deepseek-ai/dsh-tools', () => import('./host-fakes.ts').then(module => module.toolsModule()))

const GENERAL = builtinRole('general')
const FORK = builtinRole('fork')
const WORKER = role('worker', {
  description: 'Implements one change.',
  instructions: 'Change only what you were given.',
})
const REVIEWER = role('reviewer', {
  description: 'Reads and judges.',
  instructions: 'Judge the target.',
  readOnly: true,
})
const ROLES = [GENERAL, FORK, WORKER, REVIEWER]

const ARGS = { description: 'check things', prompt: 'please check the things' }

const SANDBOX_RECORD = 'sandbox/mode'

interface ParamsView {
  properties: Record<string, { type?: string; enum?: string[]; description?: string }>
  required?: string[]
}

const paramsOf = (tool: ToolDefinition) => tool.parameters as unknown as ParamsView
const roleEnum = (tool: ToolDefinition) => paramsOf(tool).properties.role?.enum

function depsFor(world: FakeWorld, patch: Partial<ToolDeps> = {}): ToolDeps {
  return { ctx: world.ctx, spawnProvider: 'spawn', forkProvider: 'fork', pending: new Map(), ...patch }
}

function mustBuild(settings: RoleSettings, deps: ToolDeps): ToolDefinition {
  const tool = buildTool(settings, deps)
  if (tool === undefined) throw new Error('buildTool returned no tool')
  return tool
}

function lastSpec(world: FakeWorld) {
  const spec = world.subagents.startActivation.mock.calls.at(-1)?.[0]
  if (spec === undefined) throw new Error('startActivation was not called')
  return spec
}

/** A world, a parent Agent and the tool for `settings`, with the parent as the calling Agent. */
function delegation(settings: RoleSettings = settingsOf(ROLES), patch: Partial<ToolDeps> = {}) {
  const world = fakeWorld()
  const parent = world.newAgent('parent')
  const deps = depsFor(world, patch)
  const tool = mustBuild(settings, deps)
  const exec = execContext(parent)
  const run = (args: Record<string, unknown> = {}) => tool.execute({ ...ARGS, ...args }, exec)
  return { world, parent, deps, tool, exec, run, settings }
}

describe('module exports', () => {
  it('names the plugin and injects the services it uses', () => {
    expect(name).toBe('dsh-rolesubagents')
    expect(inject).toEqual(['tools', 'subagents', 'systemPrompt', 'agents'])
    expect(TOOL_NAME).toBe('delegate')
  })

  it('has a config schema whose defaults are the default roles and the stock providers', () => {
    const config = Config({})
    expect(config.spawnProvider).toBe('spawn')
    expect(config.forkProvider).toBe('fork')
    expect(config.enabled.get()).toBe(true)
    expect(config.roles.get()).toEqual(DEFAULT_ROLES)
  })

  it('runs end to end on a parsed config, whose live fields are read through get()', () => {
    const world = fakeWorld()
    // The loader hands `apply` this parsed value untyped; schemastery's `Volatile<readonly any[]>` is only
    // structurally close to the `{ get(): unknown[] }` the plugin declares, hence the cast.
    apply(world.ctx, Config({}) as unknown as Partial<Config>)
    const agent = world.newAgent('main')
    world.emitCreated(agent)
    expect(roleEnum(registeredTool(agent))).toEqual(['general', 'fork', 'worker', 'explorer', 'reviewer'])
  })
})

describe('toolDescription', () => {
  const lines = (roles: RoleDefinition[]) => toolDescription(roles).split('\n')

  it('lists each role line in the configured order, between the introduction and the closing lines', () => {
    const roles = [WORKER, GENERAL, REVIEWER, FORK]
    const text = lines(roles)
    expect(text[0]).toMatch(/^Delegate a task to a subagent/)
    expect(text.slice(1, 1 + roles.length)).toEqual(roles.map(roleListLine))
    expect(text).toHaveLength(roles.length + 3)
    expect(text.at(-1)).toContain('send_message')
  })

  it('marks fork roles in their line', () => {
    expect(toolDescription([GENERAL, FORK])).toContain(
      `- fork: ${FORK.description} (fork: inherits this conversation's completed turns)`,
    )
  })

  it('says "Omit `role` to use `general`." only when the built-in general role is selectable', () => {
    const text = lines([GENERAL, WORKER])
    expect(text[3]).toBe('Omit `role` to use `general`.')
    expect(toolDescription([GENERAL, WORKER])).not.toContain('A `role` is required.')
  })

  it('says "A `role` is required." when general is not selectable', () => {
    const text = lines([WORKER, FORK])
    expect(text[3]).toBe('A `role` is required.')
    expect(toolDescription([WORKER, FORK])).not.toContain('Omit `role`')
  })

  it('does not count a custom role named general as the default role', () => {
    const impostor = role('general', { description: 'custom' })
    expect(toolDescription([impostor, WORKER])).toContain('A `role` is required.')
  })

  it('lists the roles of a real selection: disabled roles never appear', () => {
    const selection = selectableRoles(settingsOf([GENERAL, FORK, { ...WORKER, enabled: false }, REVIEWER]))
    const text = toolDescription(selection)
    expect(text).toContain('- reviewer: ')
    expect(text).not.toContain('- worker: ')
  })
})

describe('resolveRole', () => {
  it('returns the built-in general role when the role is omitted', () => {
    expect(resolveRole(ROLES, undefined)).toBe(GENERAL)
  })

  it('treats an empty role like an omitted one', () => {
    expect(resolveRole(ROLES, '')).toBe(GENERAL)
  })

  it('finds a role by id, including general by name', () => {
    expect(resolveRole(ROLES, 'reviewer')).toBe(REVIEWER)
    expect(resolveRole(ROLES, 'general')).toBe(GENERAL)
    expect(resolveRole(ROLES, 'fork')).toBe(FORK)
  })

  it('throws, listing the choices in order, when the role is omitted and general is not selectable', () => {
    expect(() => resolveRole([WORKER, FORK, REVIEWER], undefined)).toThrow(
      'role is required; choose one of: worker, fork, reviewer',
    )
    expect(() => resolveRole([WORKER], '')).toThrow('role is required; choose one of: worker')
  })

  it('throws on an unknown role, naming it and listing the choices', () => {
    expect(() => resolveRole(ROLES, 'nobody')).toThrow(
      'unknown role "nobody"; choose one of: general, fork, worker, reviewer',
    )
  })

  it('matches ids exactly', () => {
    expect(() => resolveRole(ROLES, 'Worker')).toThrow('unknown role "Worker"')
    expect(() => resolveRole(ROLES, ' worker')).toThrow('unknown role " worker"')
  })

  it('does not take a custom role named general as the default', () => {
    expect(() => resolveRole([role('general'), WORKER], undefined)).toThrow('role is required')
    expect(resolveRole([role('general'), WORKER], 'general').id).toBe('general')
  })

  it('only knows the roles it is given (a role switched off is unknown)', () => {
    const selection = selectableRoles(settingsOf([GENERAL, { ...REVIEWER, enabled: false }]))
    expect(() => resolveRole(selection, 'reviewer')).toThrow('unknown role "reviewer"; choose one of: general')
  })
})

describe('buildTool', () => {
  it('returns undefined when nothing is selectable', () => {
    const deps = depsFor(fakeWorld())
    expect(buildTool(settingsOf(ROLES, false), deps)).toBeUndefined()
    expect(buildTool(settingsOf(ROLES.map(entry => ({ ...entry, enabled: false }))), deps)).toBeUndefined()
    expect(buildTool(settingsOf([]), deps)).toBeUndefined()
  })

  it('names the tool `delegate` and describes the selectable roles', () => {
    const { tool, settings } = delegation()
    expect(tool.name).toBe('delegate')
    expect(tool.name).toBe(TOOL_NAME)
    expect(tool.description).toBe(toolDescription(selectableRoles(settings)))
  })

  it('offers exactly the selectable role ids, in order, as the `role` enum', () => {
    expect(roleEnum(delegation().tool)).toEqual(['general', 'fork', 'worker', 'reviewer'])
    const tool = mustBuild(settingsOf([GENERAL, { ...FORK, enabled: false }, REVIEWER, WORKER]), depsFor(fakeWorld()))
    expect(roleEnum(tool)).toEqual(['general', 'reviewer', 'worker'])
  })

  it('makes `role` optional while general is selectable', () => {
    const params = paramsOf(delegation().tool)
    expect(params.required).toEqual(expect.arrayContaining(['description', 'prompt']))
    expect(params.required).not.toContain('role')
    expect(params.properties.role?.description).toContain('Omit to use `general`')
  })

  it('makes `role` required when general is switched off', () => {
    const tool = mustBuild(settingsOf([{ ...GENERAL, enabled: false }, FORK, WORKER]), depsFor(fakeWorld()))
    const params = paramsOf(tool)
    expect(params.required).toEqual(expect.arrayContaining(['description', 'prompt', 'role']))
    expect(params.properties.role?.enum).toEqual(['fork', 'worker'])
    expect(params.properties.role?.description).not.toContain('Omit')
    expect(tool.description).toContain('A `role` is required.')
  })

  it('makes `role` required when only custom roles are selectable', () => {
    const tool = mustBuild(settingsOf([WORKER, REVIEWER]), depsFor(fakeWorld()))
    expect(paramsOf(tool).required).toContain('role')
    expect(roleEnum(tool)).toEqual(['worker', 'reviewer'])
  })

  it('keeps `cwd` optional and declares description and prompt as strings', () => {
    const params = paramsOf(delegation().tool)
    expect(params.required).not.toContain('cwd')
    for (const key of ['description', 'prompt', 'role', 'cwd']) expect(params.properties[key]?.type).toBe('string')
  })

  it('rejects arguments outside the schema before running anything', async () => {
    const { run, world } = delegation()
    await expect(run({ role: 'nobody' })).rejects.toThrow(/invalid arguments/)
    await expect(run({ description: undefined })).rejects.toThrow(/invalid arguments/)
    await expect(run({ prompt: 3 })).rejects.toThrow(/invalid arguments/)
    expect(world.subagents.startActivation).not.toHaveBeenCalled()
  })

  it('rejects a call without `role` when general is not selectable', async () => {
    const { run, world } = delegation(settingsOf([WORKER, FORK]))
    await expect(run()).rejects.toThrow(/invalid arguments/)
    expect(world.subagents.startActivation).not.toHaveBeenCalled()
  })

  it('declares a concurrency-safe call that renders the started id', () => {
    const { tool } = delegation()
    expect(tool.isConcurrencySafe?.({ ...ARGS })).toBe(true)
    expect(tool.output.render({ ...ARGS }, { kind: 'activation', subagentId: 'abc' })).toEqual([
      { type: 'text', text: 'started subagent abc' },
    ])
  })
})

describe('delegate: execute', () => {
  it('starts a general child through the spawn provider and returns the activation', async () => {
    const { run, world, parent, exec } = delegation()
    const result = await run()
    const spec = lastSpec(world)
    expect(spec.provider).toBe('spawn')
    expect(spec.label).toBe('check things')
    expect(spec.request.prompt).toEqual([{ type: 'text', text: 'please check the things' }])
    expect(spec.request.parent).toBe(parent)
    expect(spec.signal).toBe(exec.signal)
    expect(spec.delivery).toBe('parent')
    expect(result).toEqual({ kind: 'activation', subagentId: spec.childId })
  })

  it('sends nothing optional for a plain call', async () => {
    const { run, world } = delegation()
    await run()
    expect(Object.keys(lastSpec(world).request).sort()).toEqual(['parent', 'prompt'])
    expect(world.services.llm?.resolveCallConfig).not.toHaveBeenCalled()
  })

  it('passes cwd through', async () => {
    const { run, world } = delegation()
    await run({ cwd: 'packages/app' })
    expect(lastSpec(world).request.cwd).toBe('packages/app')
  })

  it('reserves a fresh uuid for each child', async () => {
    const { run, world } = delegation()
    await run()
    await run()
    const [first, second] = world.subagents.startActivation.mock.calls.map(([spec]) => spec.childId)
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(second).toMatch(/^[0-9a-f]{8}-/)
    expect(first).not.toBe(second)
  })

  it('returns the id the service reports', async () => {
    const { run, world } = delegation()
    world.subagents.startActivation.mockResolvedValue({ childId: 'from-the-service' })
    expect(await run()).toEqual({ kind: 'activation', subagentId: 'from-the-service' })
  })

  describe('provider choice', () => {
    it('uses the spawn provider for fresh roles and the fork provider for fork roles', async () => {
      const { run, world } = delegation()
      await run({ role: 'worker' })
      expect(lastSpec(world).provider).toBe('spawn')
      await run({ role: 'fork' })
      expect(lastSpec(world).provider).toBe('fork')
      await run({ role: 'general' })
      expect(lastSpec(world).provider).toBe('spawn')
      expect(world.subagents.getProvider.mock.calls.map(([providerName]) => providerName)).toEqual([
        'spawn',
        'fork',
        'spawn',
      ])
    })

    it('uses the configured provider names', async () => {
      const { run, world } = delegation(settingsOf(ROLES), { spawnProvider: 'my-spawn', forkProvider: 'my-fork' })
      world.providers.set('my-spawn', fakeProvider('my-spawn'))
      world.providers.set('my-fork', fakeProvider('my-fork', { inheritsParentContext: true }))
      await run({ role: 'reviewer' })
      expect(lastSpec(world).provider).toBe('my-spawn')
      await run({ role: 'fork' })
      expect(lastSpec(world).provider).toBe('my-fork')
    })

    it('fails clearly when the provider is not registered', async () => {
      const { run, world } = delegation()
      world.providers.delete('fork')
      await expect(run({ role: 'fork' })).rejects.toThrow('subagent provider "fork" is not available')
      expect(world.subagents.startActivation).not.toHaveBeenCalled()
    })

    it('needs a calling agent', async () => {
      const { tool, world } = delegation()
      await expect(tool.execute({ ...ARGS }, execContext(undefined))).rejects.toThrow(
        'subagent tool requires a calling agent',
      )
      expect(world.subagents.startActivation).not.toHaveBeenCalled()
    })
  })

  describe('role model', () => {
    const THINKER = role('thinker', {
      model: { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
    })
    const PLAIN_MODEL = role('quick', { model: { provider: 'deepseek', model: 'deepseek-chat' } })
    const withModels = () => delegation(settingsOf([GENERAL, FORK, THINKER, PLAIN_MODEL]))

    it('passes agentOptions only for roles that have a model', async () => {
      const { run, world } = withModels()
      await run({ role: 'general' })
      expect(lastSpec(world).request).not.toHaveProperty('agentOptions')
      await run({ role: 'thinker' })
      expect(lastSpec(world).request.agentOptions).toEqual({
        provider: 'deepseek',
        model: 'deepseek-reasoner',
        reasoningEffort: 'high',
      })
    })

    it('leaves reasoningEffort out when the role has none', async () => {
      const { run, world } = withModels()
      await run({ role: 'quick' })
      const options = lastSpec(world).request.agentOptions
      expect(options).toStrictEqual({ provider: 'deepseek', model: 'deepseek-chat' })
      expect(options).not.toHaveProperty('reasoningEffort')
    })

    it('validates the model with llm.resolveCallConfig, passing the options and the call signal', async () => {
      const { run, world, exec } = withModels()
      await run({ role: 'thinker' })
      const resolve = world.services.llm?.resolveCallConfig
      expect(resolve).toHaveBeenCalledTimes(1)
      expect(resolve).toHaveBeenCalledWith(
        { provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'high' },
        exec.signal,
      )
    })

    it('resolves the model before the child is started', async () => {
      const { run, world } = withModels()
      const order: string[] = []
      world.services.llm?.resolveCallConfig.mockImplementation(async () => {
        order.push('resolve')
      })
      world.subagents.startActivation.mockImplementation(async spec => {
        order.push('start')
        return { childId: spec.childId ?? 'x' }
      })
      await run({ role: 'thinker' })
      expect(order).toEqual(['resolve', 'start'])
    })

    it('does not call llm.resolveCallConfig for roles without a model', async () => {
      const { run, world } = withModels()
      await run({ role: 'general' })
      await run({ role: 'fork' })
      expect(world.services.llm?.resolveCallConfig).not.toHaveBeenCalled()
    })

    it('does not start the child when the model does not resolve, and leaves nothing pending', async () => {
      const { run, world, deps } = withModels()
      world.services.llm?.resolveCallConfig.mockRejectedValue(new Error('unknown model deepseek-reasoner'))
      await expect(run({ role: 'thinker' })).rejects.toThrow('unknown model deepseek-reasoner')
      expect(world.subagents.startActivation).not.toHaveBeenCalled()
      expect(deps.pending.size).toBe(0)
    })

    it('still starts the child when the Host has no llm service', async () => {
      const { run, world } = withModels()
      delete world.services.llm
      await run({ role: 'thinker' })
      expect(lastSpec(world).request.agentOptions).toMatchObject({ model: 'deepseek-reasoner' })
    })

    it.each([
      ['reports no agentOptions capability', { name: 'spawn', capabilities: {} }],
      ['reports agentOptions as false', fakeProvider('spawn', { capabilities: { agentOptions: false } })],
    ])('rejects a model role when the provider %s', async (_label, provider) => {
      const { run, world, deps } = withModels()
      world.providers.set('spawn', provider)
      await expect(run({ role: 'thinker' })).rejects.toThrow(
        'role "thinker": provider "spawn" cannot set the child model',
      )
      expect(world.subagents.startActivation).not.toHaveBeenCalled()
      expect(world.services.llm?.resolveCallConfig).not.toHaveBeenCalled()
      expect(deps.pending.size).toBe(0)
    })

    it('does not need the capability for roles without a model', async () => {
      const { run, world } = withModels()
      world.providers.set('spawn', { name: 'spawn', capabilities: {} })
      await run({ role: 'general' })
      expect(world.subagents.startActivation).toHaveBeenCalledTimes(1)
    })
  })

  describe('agent preset', () => {
    const CODER = role('coder', { agentPreset: 'coder-preset' })
    const withPreset = () => delegation(settingsOf([GENERAL, FORK, CODER]))

    it('passes agentPreset only for roles that have one', async () => {
      const { run, world } = withPreset()
      await run({ role: 'coder' })
      expect(lastSpec(world).request.agentPreset).toBe('coder-preset')
      await run({ role: 'general' })
      expect(lastSpec(world).request).not.toHaveProperty('agentPreset')
    })

    it('sends a preset and a model together', async () => {
      const both = role('both', { agentPreset: 'p', model: { provider: 'a', model: 'b' } })
      const { run, world } = delegation(settingsOf([GENERAL, both]))
      await run({ role: 'both' })
      expect(lastSpec(world).request).toMatchObject({ agentPreset: 'p', agentOptions: { provider: 'a', model: 'b' } })
    })

    it.each([
      ['reports no agentPreset capability', { name: 'spawn', capabilities: {} }],
      ['reports agentPreset as false', fakeProvider('spawn', { capabilities: { agentPreset: false } })],
      ['inherits the parent context', fakeProvider('spawn', { inheritsParentContext: true })],
    ])('rejects a preset role when the provider %s', async (_label, provider) => {
      const { run, world, deps } = withPreset()
      world.providers.set('spawn', provider)
      await expect(run({ role: 'coder' })).rejects.toThrow(
        'role "coder": provider "spawn" cannot mount agent preset "coder-preset"',
      )
      expect(world.subagents.startActivation).not.toHaveBeenCalled()
      expect(deps.pending.size).toBe(0)
    })

    it('accepts a provider that declares the capability and does not inherit context', async () => {
      const { run, world } = withPreset()
      world.providers.set(
        'spawn',
        fakeProvider('spawn', { capabilities: { agentPreset: true }, inheritsParentContext: false }),
      )
      await run({ role: 'coder' })
      expect(world.subagents.startActivation).toHaveBeenCalledTimes(1)
    })
  })

  describe('depth', () => {
    it('passes the maximum depth from resolveMaxDepth, asked with no configured value', async () => {
      const { run, world } = delegation()
      world.subagents.resolveMaxDepth.mockReturnValue(3)
      await run()
      expect(world.subagents.resolveMaxDepth).toHaveBeenCalledWith(undefined)
      expect(lastSpec(world).request.maxDepth).toBe(3)
    })

    it('passes a maximum depth of zero', async () => {
      const { run, world } = delegation()
      world.subagents.resolveMaxDepth.mockReturnValue(0)
      await run()
      expect(lastSpec(world).request.maxDepth).toBe(0)
    })

    it('sends no maxDepth when the service has none', async () => {
      const { run, world } = delegation()
      world.subagents.resolveMaxDepth.mockReturnValue(undefined)
      await run()
      expect(lastSpec(world).request).not.toHaveProperty('maxDepth')
    })
  })

  describe('pending children', () => {
    it('reserves the child id with its role and the role list while startActivation runs, then releases it', async () => {
      const { run, world, deps, settings } = delegation()
      let seen: PendingChild | undefined
      let during = -1
      world.subagents.startActivation.mockImplementation(async spec => {
        const childId = spec.childId ?? ''
        seen = deps.pending.get(childId)
        during = deps.pending.size
        return { childId }
      })
      await run({ role: 'reviewer' })
      expect(during).toBe(1)
      expect(seen?.role).toBe(REVIEWER)
      expect(seen?.snapshot).toBe(settings)
      expect(deps.pending.size).toBe(0)
    })

    it('reserves the same id it passes to startActivation', async () => {
      const { run, world, deps } = delegation()
      let reserved: string[] = []
      world.subagents.startActivation.mockImplementation(async spec => {
        reserved = [...deps.pending.keys()]
        return { childId: spec.childId ?? '' }
      })
      await run()
      expect(reserved).toEqual([lastSpec(world).childId])
    })

    it('releases the reservation when startActivation rejects, and rethrows', async () => {
      const { run, world, deps } = delegation()
      world.subagents.startActivation.mockRejectedValue(new Error('provider exploded'))
      await expect(run()).rejects.toThrow('provider exploded')
      expect(deps.pending.size).toBe(0)
    })

    it('releases the reservation when startActivation throws synchronously', async () => {
      const { run, world, deps } = delegation()
      world.subagents.startActivation.mockImplementation(() => {
        throw new Error('sync failure')
      })
      await expect(run()).rejects.toThrow('sync failure')
      expect(deps.pending.size).toBe(0)
    })

    it('keeps parallel delegations apart: each has its own id and releases only its own', async () => {
      const { run, world, deps } = delegation()
      const gates: (() => void)[] = []
      world.subagents.startActivation.mockImplementation(
        spec =>
          new Promise(resolve => {
            gates.push(() => resolve({ childId: spec.childId ?? '' }))
          }),
      )
      const first = run({ role: 'worker' })
      const second = run({ role: 'reviewer' })
      await vi.waitFor(() => expect(gates).toHaveLength(2))
      expect(deps.pending.size).toBe(2)
      expect([...deps.pending.values()].map(child => child.role.id).sort()).toEqual(['reviewer', 'worker'])
      gates[0]?.()
      await first
      expect(deps.pending.size).toBe(1)
      expect([...deps.pending.values()].map(child => child.role.id)).toEqual(['reviewer'])
      gates[1]?.()
      await second
      expect(deps.pending.size).toBe(0)
    })
  })
})

describe('session records', () => {
  const stored = (settings: unknown) => ({ version: 1, settings })

  it('keeps the persisted record names stable, since existing Session logs carry them', () => {
    expect(ROLES_RECORD).toBe('plugin:dsh-rolesubagents/roles')
    expect(ROLE_RECORD).toBe('plugin:dsh-rolesubagents/role')
  })

  describe('the roles snapshot', () => {
    it('is absent from a Session that has none', () => {
      expect(readRolesSnapshot(fakeSession('s'))).toBeUndefined()
    })

    it('round-trips through the log as a plugin record', () => {
      const session = fakeSession('s')
      const settings = normalizeSettings({ enabled: false, roles: ROLES }).settings
      writeRolesSnapshot(session, settings)
      expect(typesOf(session)).toEqual([ROLES_RECORD])
      expect(session.log[0]?.ignorable).toBe(true)
      expect(recordsOf(session, ROLES_RECORD)).toEqual([{ version: 1, settings }])
      expect(readRolesSnapshot(session)).toEqual(settings)
    })

    it('reads the newest record', () => {
      const session = fakeSession('s')
      writeRolesSnapshot(session, settingsOf([GENERAL, FORK, role('old')]))
      writeRolesSnapshot(session, settingsOf([GENERAL, FORK, role('new')]))
      expect(readRolesSnapshot(session)?.roles.map(entry => entry.id)).toEqual(['general', 'fork', 'new'])
    })

    it('normalizes what it reads, so a hand-edited log cannot yield a role the tool would mishandle', () => {
      const session = fakeSession('s')
      appendRecord(session, ROLES_RECORD, stored({ enabled: true, roles: [{ id: 'Bad id' }, { id: 'ok' }, null] }))
      const snapshot = readRolesSnapshot(session)
      expect(snapshot?.roles.map(entry => [entry.id, entry.enabled])).toEqual([
        ['general', false],
        ['fork', false],
        ['ok', true],
      ])
    })

    it.each([
      ['an unknown version', { version: 2, settings: DEFAULT_SETTINGS }],
      ['no version', { settings: DEFAULT_SETTINGS }],
      ['null', null],
      ['a string', 'roles'],
      ['a number', 3],
    ])('ignores a record with %s', (_label, data) => {
      const session = fakeSession('s')
      appendRecord(session, ROLES_RECORD, data)
      expect(readRolesSnapshot(session)).toBeUndefined()
    })

    it('ignores other records, other events and look-alike events that are not ignorable records', () => {
      const session = fakeSession('s')
      appendRecord(session, 'plugin:other-plugin/roles', stored(DEFAULT_SETTINGS))
      appendRecord(session, ROLE_RECORD, { version: 1, role: WORKER })
      session.append('sandbox/mode', { mode: 'read-only' })
      session.log.push({ type: ROLES_RECORD, seq: session.log.length, time: 0, data: stored(DEFAULT_SETTINGS) })
      expect(readRolesSnapshot(session)).toBeUndefined()
    })
  })

  describe('the child role', () => {
    it('is absent from a Session without one', () => {
      expect(readRole(fakeSession('s'))).toBeUndefined()
    })

    it('round-trips through the log as a plugin record', () => {
      const session = fakeSession('s')
      const reviewer = normalizeSettings({ enabled: true, roles: ROLES }).settings.roles.find(
        entry => entry.id === 'reviewer',
      )
      if (reviewer === undefined) throw new Error('no reviewer')
      writeRole(session, reviewer)
      expect(typesOf(session)).toEqual([ROLE_RECORD])
      expect(session.log[0]?.ignorable).toBe(true)
      expect(recordsOf(session, ROLE_RECORD)).toEqual([{ version: 1, role: reviewer }])
      expect(readRole(session)).toEqual(reviewer)
    })

    it('reads a built-in role as the built-in', () => {
      const session = fakeSession('s')
      writeRole(session, FORK)
      expect(readRole(session)).toEqual(FORK)
    })

    it('reads the newest record', () => {
      const session = fakeSession('s')
      writeRole(session, WORKER)
      writeRole(session, REVIEWER)
      expect(readRole(session)?.id).toBe('reviewer')
    })

    it('normalizes what it reads (a bad model is dropped, an over-long description is cut)', () => {
      const session = fakeSession('s')
      appendRecord(session, ROLE_RECORD, {
        version: 1,
        role: { ...WORKER, model: { provider: 'only-provider' }, description: 'd'.repeat(1500) },
      })
      const read = readRole(session)
      expect(read?.id).toBe('worker')
      expect(read).not.toHaveProperty('model')
      expect(read?.description).toHaveLength(1000)
    })

    it.each([
      ['an unknown version', { version: 2, role: WORKER }],
      ['no role', { version: 1 }],
      ['a role that is a string', { version: 1, role: 'worker' }],
      ['a role that is null', { version: 1, role: null }],
      ['a role that is a list', { version: 1, role: [WORKER] }],
      ['a role without an id', { version: 1, role: { description: 'nameless' } }],
      ['a role with an invalid id', { version: 1, role: { ...WORKER, id: 'Not Valid' } }],
      ['null', null],
    ])('ignores a record with %s', (_label, data) => {
      const session = fakeSession('s')
      appendRecord(session, ROLE_RECORD, data)
      expect(readRole(session)).toBeUndefined()
    })

    it('ignores the roles snapshot record', () => {
      const session = fakeSession('s')
      writeRolesSnapshot(session, settingsOf(ROLES))
      expect(readRole(session)).toBeUndefined()
    })
  })
})

describe('apply: top-level agents', () => {
  function boot(config: Partial<Config> = {}) {
    const world = fakeWorld()
    apply(world.ctx, config)
    return world
  }

  it('records a roles snapshot when the Session has none and registers the tool in the agent scope', () => {
    const world = boot()
    const agent = world.newAgent('main')
    world.emitCreated(agent)
    expect(recordsOf(agent.session, ROLES_RECORD)).toEqual([{ version: 1, settings: DEFAULT_SETTINGS }])
    expect(typesOf(agent.session)).toEqual([ROLES_RECORD])
    expect(agent.register).toHaveBeenCalledTimes(1)
    expect(registeredTool(agent).name).toBe('delegate')
    expect(roleEnum(registeredTool(agent))).toEqual(['general', 'fork', 'worker', 'explorer', 'reviewer'])
    expect(readRolesSnapshot(agent.session)).toEqual(DEFAULT_SETTINGS)
    expect(readRole(agent.session)).toBeUndefined()
  })

  it('snapshots the normalized configured roles, not the raw config', () => {
    const world = boot({
      roles: [GENERAL, FORK, { ...WORKER, description: ' '.repeat(2) + 'd'.repeat(2000) }, { id: 'Bad id' }],
    })
    const agent = world.newAgent('main')
    world.emitCreated(agent)
    const snapshot = readRolesSnapshot(agent.session)
    expect(snapshot?.roles.map(entry => entry.id)).toEqual(['general', 'fork', 'worker'])
    expect(snapshot?.roles[2]?.description).toHaveLength(1000)
  })

  it('registers the tool through the configured provider names', async () => {
    const world = boot({ spawnProvider: 'my-spawn', forkProvider: 'my-fork' })
    world.providers.set('my-spawn', fakeProvider('my-spawn'))
    world.providers.set('my-fork', fakeProvider('my-fork', { inheritsParentContext: true }))
    const agent = world.newAgent('main')
    world.emitCreated(agent)
    await registeredTool(agent).execute({ ...ARGS, role: 'fork' }, execContext(agent))
    expect(lastSpec(world).provider).toBe('my-fork')
  })

  it('registers the tool once per agent, however often agent/created repeats', () => {
    const world = boot()
    const agent = world.newAgent('main')
    world.emitCreated(agent)
    world.emitCreated(agent, 'resume')
    expect(agent.register).toHaveBeenCalledTimes(1)
    expect(recordsOf(agent.session, ROLES_RECORD)).toHaveLength(1)
  })

  it('keeps the recorded roles of a Session even when the config changed (the next-session rule)', () => {
    const live = { enabled: true, roles: ROLES as unknown[] }
    const world = boot({ enabled: { get: () => live.enabled }, roles: { get: () => live.roles } })
    const first = world.newAgent('first')
    world.emitCreated(first)
    expect(roleEnum(registeredTool(first))).toEqual(['general', 'fork', 'worker', 'reviewer'])

    live.enabled = false
    live.roles = [GENERAL, FORK, role('other')]

    // The same Session meets the plugin again (a resumed Agent object): it keeps what it recorded.
    const resumed = fakeAgent('first-again', first.session)
    world.emitCreated(resumed, 'resume')
    expect(roleEnum(registeredTool(resumed))).toEqual(['general', 'fork', 'worker', 'reviewer'])
    expect(registeredTool(resumed).description).toBe(registeredTool(first).description)
    expect(recordsOf(first.session, ROLES_RECORD)).toHaveLength(1)

    // A Session created after the change gets the new settings: the master switch is off, so no tool at all.
    const later = world.newAgent('later')
    world.emitCreated(later)
    expect(later.register).not.toHaveBeenCalled()
    expect(recordsOf(later.session, ROLES_RECORD)).toEqual([
      { version: 1, settings: expect.objectContaining({ enabled: false }) },
    ])
  })

  it('gives a later Session the new roles when the config changes', () => {
    const live = { roles: ROLES as unknown[] }
    const world = boot({ roles: { get: () => live.roles } })
    const first = world.newAgent('first')
    world.emitCreated(first)
    live.roles = [GENERAL, FORK, role('only-new')]
    const second = world.newAgent('second')
    world.emitCreated(second)
    expect(roleEnum(registeredTool(first))).toEqual(['general', 'fork', 'worker', 'reviewer'])
    expect(roleEnum(registeredTool(second))).toEqual(['general', 'fork', 'only-new'])
  })

  it('registers no tool when the master switch is off, but still records the snapshot', () => {
    const world = boot({ enabled: false })
    const agent = world.newAgent('main')
    world.emitCreated(agent)
    expect(agent.register).not.toHaveBeenCalled()
    expect(recordsOf(agent.session, ROLES_RECORD)).toEqual([
      { version: 1, settings: expect.objectContaining({ enabled: false }) },
    ])
  })

  it('reads the master switch from a live reference too', () => {
    const world = boot({ enabled: { get: () => false } })
    const agent = world.newAgent('main')
    world.emitCreated(agent)
    expect(agent.register).not.toHaveBeenCalled()
  })

  it('registers no tool when every role is switched off', () => {
    const world = boot({ roles: ROLES.map(entry => ({ ...entry, enabled: false })) })
    const agent = world.newAgent('main')
    world.emitCreated(agent)
    expect(agent.register).not.toHaveBeenCalled()
  })

  it('builds the tool from the recorded snapshot when a Session already has one, without recording another', () => {
    const world = boot({ roles: [GENERAL, FORK, role('from-config')] })
    const agent = world.newAgent('main')
    const first = fakeAgent('seed', agent.session)
    world.emitCreated(first)
    const recorded = recordsOf(agent.session, ROLES_RECORD)
    const second = fakeAgent('second', agent.session)
    world.emitCreated(second)
    expect(recordsOf(agent.session, ROLES_RECORD)).toEqual(recorded)
    expect(roleEnum(registeredTool(second))).toEqual(['general', 'fork', 'from-config'])
  })

  it('installs the tool for agents that already exist when the plugin is applied', () => {
    const world = fakeWorld()
    const existing = world.newAgent('existing')
    world.agents = [existing]
    apply(world.ctx)
    expect(existing.register).toHaveBeenCalledTimes(1)
    expect(recordsOf(existing.session, ROLES_RECORD)).toHaveLength(1)
  })

  it('registers the role runtime context before the first agent exists', () => {
    const world = boot()
    expect(world.contexts).toHaveLength(1)
    expect(world.contexts[0]).toMatchObject({
      name: 'rolesubagents:role',
      order: 121,
      interpolate: false,
      required: true,
    })
  })
})

describe('apply: settings problems', () => {
  it('logs adjusted settings once, not again for the same problem, and again after the config was clean in between', () => {
    const bad = [GENERAL, FORK, WORKER, { ...WORKER, description: 'copy' }]
    const live = { roles: bad as unknown[] }
    const world = fakeWorld()
    apply(world.ctx, { roles: { get: () => live.roles } })
    const open = (id: string) => world.emitCreated(world.newAgent(id))

    open('a')
    expect(world.logger.warn).toHaveBeenCalledTimes(1)
    expect(world.logger.warn).toHaveBeenCalledWith(
      'rolesubagents: settings adjusted: role id "worker" is used more than once',
    )
    open('b')
    expect(world.logger.warn).toHaveBeenCalledTimes(1)

    live.roles = ROLES
    open('c')
    expect(world.logger.warn).toHaveBeenCalledTimes(1)

    live.roles = bad
    open('d')
    expect(world.logger.warn).toHaveBeenCalledTimes(2)
  })

  it('does not log anything for clean settings', () => {
    const world = fakeWorld()
    apply(world.ctx)
    world.emitCreated(world.newAgent('main'))
    expect(world.logger.warn).not.toHaveBeenCalled()
    expect(world.logger.info).not.toHaveBeenCalled()
  })

  it('joins several problems into one message', () => {
    const world = fakeWorld()
    apply(world.ctx, { roles: [WORKER] })
    world.emitCreated(world.newAgent('main'))
    expect(world.logger.warn).toHaveBeenCalledTimes(1)
    const message = String(world.logger.warn.mock.calls[0]?.[0])
    expect(message).toContain('built-in role "general" was missing')
    expect(message).toContain('; built-in role "fork" was missing')
  })
})

describe('apply: child agents started by the tool', () => {
  function boot(config: Partial<Config> = {}) {
    const world = fakeWorld()
    apply(world.ctx, { roles: ROLES, ...config })
    const parent = world.newAgent('parent')
    world.emitCreated(parent)
    const delegate = async (roleId: string | undefined, extra: Record<string, unknown> = {}) => {
      const args = { ...ARGS, ...(roleId === undefined ? {} : { role: roleId }), ...extra }
      const result = await registeredTool(parent).execute(args, execContext(parent))
      return result
    }
    const lastChild = (): FakeAgent => {
      const child = world.children.at(-1)
      if (child === undefined) throw new Error('no child was started')
      return child
    }
    return { world, parent, delegate, lastChild }
  }

  const normalized = (roles: RoleDefinition[]) => normalizeSettings({ enabled: true, roles }).settings
  const roleOfSettings = (id: string) => {
    const found = normalized(ROLES).roles.find(entry => entry.id === id)
    if (found === undefined) throw new Error(`no role ${id}`)
    return found
  }

  it('pins the read-only sandbox first, then writes the role record and the roles snapshot', async () => {
    const { delegate, lastChild } = boot()
    const result = await delegate('reviewer')
    const child = lastChild()
    expect(result).toEqual({ kind: 'activation', subagentId: child.id })
    expect(typesOf(child.session)).toEqual([SANDBOX_RECORD, ROLE_RECORD, ROLES_RECORD])
    expect(recordsOf(child.session, ROLE_RECORD)).toEqual([{ version: 1, role: roleOfSettings('reviewer') }])
    expect(recordsOf(child.session, ROLES_RECORD)).toEqual([{ version: 1, settings: normalized(ROLES) }])
    expect(child.session.log[0]?.data).toEqual({ mode: 'read-only' })
    expect(readRole(child.session)).toEqual(roleOfSettings('reviewer'))
  })

  it('does not touch the sandbox for roles that are not read-only', async () => {
    const { delegate, lastChild } = boot()
    for (const roleId of ['worker', 'general', 'fork']) {
      await delegate(roleId)
      expect(typesOf(lastChild().session)).toEqual([ROLE_RECORD, ROLES_RECORD])
    }
  })

  it('treats an omitted role as the built-in general role', async () => {
    const { delegate, lastChild } = boot()
    await delegate(undefined)
    expect(readRole(lastChild().session)).toMatchObject({ id: 'general', builtin: 'general' })
  })

  it('registers the same tool in the child scope as in the parent scope', async () => {
    const { delegate, lastChild, parent } = boot()
    await delegate('worker')
    const child = lastChild()
    expect(child.register).toHaveBeenCalledTimes(1)
    expect(registeredTool(child).name).toBe('delegate')
    expect(registeredTool(child).description).toBe(registeredTool(parent).description)
    expect(registeredTool(child).parameters).toEqual(registeredTool(parent).parameters)
    expect(parent.register).toHaveBeenCalledTimes(1)
  })

  it('gives the child the parent Session roles even after the config changed', async () => {
    const live = { roles: ROLES as unknown[] }
    const world = fakeWorld()
    apply(world.ctx, { roles: { get: () => live.roles } })
    const parent = world.newAgent('parent')
    world.emitCreated(parent)
    live.roles = [GENERAL, FORK, role('other')]
    await registeredTool(parent).execute({ ...ARGS, role: 'reviewer' }, execContext(parent))
    const child = world.children[0]
    expect(child).toBeDefined()
    if (child === undefined) return
    expect(roleEnum(registeredTool(child))).toEqual(['general', 'fork', 'worker', 'reviewer'])
    expect(recordsOf(child.session, ROLES_RECORD)).toEqual([{ version: 1, settings: normalized(ROLES) }])
  })

  it('does not apply a reservation unless the agent is created at startup', async () => {
    const { world, delegate } = boot()
    world.subagents.startActivation.mockImplementation(async spec => {
      const childId = spec.childId ?? ''
      const child = world.newAgent(childId, {
        origin: 'subagent',
        parentSession: spec.request.parent.session.id,
        delegationDepth: 1,
      })
      world.children.push(child)
      world.emitCreated(child, 'resume')
      return { childId }
    })
    await delegate('reviewer')
    const child = world.children[0]
    expect(child).toBeDefined()
    if (child === undefined) return
    expect(typesOf(child.session)).toEqual([ROLES_RECORD])
    expect(readRole(child.session)).toBeUndefined()
  })

  function failingChildBoot(failOn: 'sandbox' | 'record') {
    const booted = boot()
    booted.world.subagents.startActivation.mockImplementation(async spec => {
      const childId = spec.childId ?? ''
      const child = booted.world.newAgent(childId, {
        origin: 'subagent',
        parentSession: spec.request.parent.session.id,
        delegationDepth: 1,
      })
      if (failOn === 'sandbox') {
        child.session.append = () => {
          throw new Error('log closed')
        }
      } else {
        child.ctx.tools.register = () => {
          throw new Error('registry closed')
        }
      }
      booted.world.children.push(child)
      booted.world.emitCreated(child, 'startup')
      return { childId }
    })
    return booted
  }

  it('aborts a read-only child whose sandbox cannot be pinned instead of letting it run writable', async () => {
    const { delegate } = failingChildBoot('sandbox')
    await expect(delegate('reviewer')).rejects.toThrow('log closed')
  })

  it('keeps other preparation failures from aborting a child, and logs them', async () => {
    const { world, delegate } = failingChildBoot('record')
    await expect(delegate('worker')).resolves.toMatchObject({ kind: 'activation' })
    expect(world.logger.warn).toHaveBeenCalledTimes(1)
    expect(world.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/^rolesubagents: could not prepare agent [0-9a-f-]{36}: registry closed$/),
    )
  })
})

describe('apply: children not started by the tool', () => {
  it('lets a child of a recorded Session inherit the parent roles instead of the current config', () => {
    const live = { roles: ROLES as unknown[] }
    const world = fakeWorld()
    apply(world.ctx, { roles: { get: () => live.roles } })
    const parent = world.newAgent('parent')
    world.emitCreated(parent)
    live.roles = [GENERAL, FORK, role('other')]

    const child = world.newAgent('official-child', {
      origin: 'subagent',
      parentSession: parent.session.id,
      delegationDepth: 1,
    })
    world.emitCreated(child, 'startup')
    expect(roleEnum(registeredTool(child))).toEqual(['general', 'fork', 'worker', 'reviewer'])
    expect(recordsOf(child.session, ROLES_RECORD)).toEqual(recordsOf(parent.session, ROLES_RECORD))
    expect(recordsOf(child.session, ROLE_RECORD)).toEqual([])
  })

  it('falls back to the current config when the parent Session is unknown or has no snapshot', () => {
    const world = fakeWorld()
    apply(world.ctx, { roles: [GENERAL, FORK, role('current')] })
    const orphan = world.newAgent('orphan', { origin: 'subagent', parentSession: 'no-such-session' })
    world.emitCreated(orphan)
    expect(roleEnum(registeredTool(orphan))).toEqual(['general', 'fork', 'current'])

    const bare = world.newAgent('bare-parent')
    const child = world.newAgent('child-of-bare', { origin: 'subagent', parentSession: bare.session.id })
    world.emitCreated(child)
    expect(roleEnum(registeredTool(child))).toEqual(['general', 'fork', 'current'])
  })

  it('falls back to the current config when the Host has no sessions service', () => {
    const world = fakeWorld()
    delete world.services.sessions
    apply(world.ctx, { roles: [GENERAL, FORK, role('current')] })
    const child = world.newAgent('child', { origin: 'subagent', parentSession: 'whatever' })
    world.emitCreated(child)
    expect(roleEnum(registeredTool(child))).toEqual(['general', 'fork', 'current'])
  })
})

describe('apply: runtime context', () => {
  function boot(maxDepth?: number) {
    const world = fakeWorld()
    world.subagents.resolveMaxDepth.mockReturnValue(maxDepth)
    apply(world.ctx, { roles: ROLES })
    const parent = world.newAgent('parent')
    world.emitCreated(parent)
    const child = async (roleId?: string) => {
      await registeredTool(parent).execute(
        { ...ARGS, ...(roleId === undefined ? {} : { role: roleId }) },
        execContext(parent),
      )
      const started = world.children.at(-1)
      if (started === undefined) throw new Error('no child was started')
      return started
    }
    return { world, parent, child }
  }

  const DEPTH_LINE = (current: number, maximum: number, remaining: number) =>
    `Delegation depth for \`delegate\`: current ${current}, maximum ${maximum}, remaining levels ${remaining}.`

  it('returns the role text for a child and nothing for the parent', async () => {
    const { world, parent, child } = boot()
    const reviewer = await child('reviewer')
    expect(world.runtimeContext(reviewer)).toBe(roleContextText(REVIEWER))
    expect(world.runtimeContext(reviewer)).toContain('Your role: reviewer.')
    expect(world.runtimeContext(reviewer)).toContain('Judge the target.')
    expect(world.runtimeContext(reviewer)).toContain('This role is read-only')
    expect(world.runtimeContext(parent)).toBe('')
  })

  it('returns the role text for a role that is not read-only, without the read-only sentence', async () => {
    const { world, child } = boot()
    expect(world.runtimeContext(await child('worker'))).toBe('Your role: worker.\nChange only what you were given.')
  })

  it('returns an empty text for a built-in child without instructions', async () => {
    const { world, child } = boot()
    expect(world.runtimeContext(await child('general'))).toBe('')
    expect(world.runtimeContext(await child('fork'))).toBe('')
  })

  it('returns an empty text when there is no agent', () => {
    expect(boot().world.runtimeContext()).toBe('')
  })

  it('tells each child its own role', async () => {
    const { world, child } = boot()
    const first = await child('worker')
    const second = await child('reviewer')
    expect(world.runtimeContext(first)).toContain('Your role: worker.')
    expect(world.runtimeContext(second)).toContain('Your role: reviewer.')
    expect(world.runtimeContext(first)).not.toContain('reviewer')
  })

  it('reads a child role back from its log when the Agent is created again (resume), without writing again', async () => {
    const { child } = boot()
    const original = await child('reviewer')
    const length = original.session.log.length

    const fresh = fakeWorld()
    apply(fresh.ctx, { roles: [GENERAL, FORK] })
    const resumed = fakeAgent('resumed-child', original.session)
    fresh.emitCreated(resumed, 'resume')
    expect(fresh.runtimeContext(resumed)).toBe(roleContextText(REVIEWER))
    expect(original.session.log).toHaveLength(length)
    expect(roleEnum(registeredTool(resumed))).toEqual(['general', 'fork', 'worker', 'reviewer'])
  })

  it('adds the depth line after the role text for a delegated child when the service has a maximum', async () => {
    const { world, child } = boot(3)
    const reviewer = await child('reviewer')
    expect(reviewer.session.header.delegationDepth).toBe(1)
    expect(world.runtimeContext(reviewer)).toBe(`${roleContextText(REVIEWER)}\n\n${DEPTH_LINE(1, 3, 2)}`)
  })

  it('gives a child with no role text only the depth line', async () => {
    const { world, child } = boot(3)
    expect(world.runtimeContext(await child('general'))).toBe(DEPTH_LINE(1, 3, 2))
  })

  it('only tells a child not to delegate once no levels remain, not while one is left', () => {
    const { world } = boot(3)
    const near = world.newAgent('near', { origin: 'subagent', delegationDepth: 2 })
    world.emitCreated(near, 'resume')
    expect(world.runtimeContext(near)).toBe(DEPTH_LINE(2, 3, 1))
  })

  it('tells a child at the maximum depth not to delegate further', () => {
    const { world } = boot(3)
    const deep = world.newAgent('deep', { origin: 'subagent', delegationDepth: 3 })
    world.emitCreated(deep, 'resume')
    expect(world.runtimeContext(deep)).toBe(
      `${DEPTH_LINE(3, 3, 0)} Do not call \`delegate\` at this depth; carry out the work directly.`,
    )
  })

  it('reports zero remaining levels, not a negative number, below the maximum', () => {
    const { world } = boot(2)
    const deep = world.newAgent('deeper', { origin: 'subagent', delegationDepth: 5 })
    world.emitCreated(deep, 'resume')
    expect(world.runtimeContext(deep)).toContain(DEPTH_LINE(5, 2, 0))
  })

  it('has no depth line for the top-level agent, even with a maximum', () => {
    const { world, parent } = boot(3)
    expect(parent.session.header.delegationDepth).toBeUndefined()
    expect(world.runtimeContext(parent)).toBe('')
  })

  it('has no depth line when the service reports no maximum', async () => {
    const { world, child } = boot(undefined)
    const reviewer = await child('reviewer')
    expect(world.runtimeContext(reviewer)).toBe(roleContextText(REVIEWER))
    expect(world.subagents.resolveMaxDepth).toHaveBeenCalledWith(undefined)
  })

  it('has no depth line where the tool is not installed, since the agent cannot delegate anyway', () => {
    const world = fakeWorld()
    world.subagents.resolveMaxDepth.mockReturnValue(3)
    apply(world.ctx, { enabled: false })
    const child = world.newAgent('child', { origin: 'subagent', delegationDepth: 1 })
    world.emitCreated(child)
    expect(world.runtimeContext(child)).toBe('')
  })
})

describe('apply: lifecycle', () => {
  function boot(config: Partial<Config> = {}) {
    const world = fakeWorld()
    apply(world.ctx, config)
    return world
  }

  it('calls the registration disposer when the agent is disposed, once', () => {
    const world = boot()
    const agent = world.newAgent('main')
    world.emitCreated(agent)
    expect(agent.disposers[0]).not.toHaveBeenCalled()
    world.emitDisposed(agent)
    expect(agent.disposers[0]).toHaveBeenCalledTimes(1)
    world.emitDisposed(agent)
    expect(agent.disposers[0]).toHaveBeenCalledTimes(1)
  })

  it('ignores the disposal of an agent that never got a tool', () => {
    const world = boot({ enabled: false })
    const agent = world.newAgent('main')
    world.emitCreated(agent)
    expect(() => world.emitDisposed(agent)).not.toThrow()
    expect(() => world.emitDisposed(world.newAgent('stranger'))).not.toThrow()
  })

  it('registers again when a disposed agent is created again', () => {
    const world = boot()
    const agent = world.newAgent('main')
    world.emitCreated(agent)
    world.emitDisposed(agent)
    world.emitCreated(agent, 'resume')
    expect(agent.register).toHaveBeenCalledTimes(2)
  })

  it('disposes the child registration with the child', async () => {
    const world = boot()
    const parent = world.newAgent('parent')
    world.emitCreated(parent)
    await registeredTool(parent).execute({ ...ARGS }, execContext(parent))
    const child = world.children[0]
    expect(child?.disposers[0]).not.toHaveBeenCalled()
    if (child !== undefined) world.emitDisposed(child)
    expect(child?.disposers[0]).toHaveBeenCalledTimes(1)
    expect(parent.disposers[0]).not.toHaveBeenCalled()
  })

  it('removes every remaining registration when the plugin is unloaded, skipping those already disposed', () => {
    const world = boot()
    const kept = world.newAgent('kept')
    const gone = world.newAgent('gone')
    world.emitCreated(kept)
    world.emitCreated(gone)
    world.emitDisposed(gone)
    world.teardown()
    expect(kept.disposers[0]).toHaveBeenCalledTimes(1)
    expect(gone.disposers[0]).toHaveBeenCalledTimes(1)
  })
})

describe('apply: failures while an agent is prepared', () => {
  it('catches a throwing step in the agent/created handler and logs it with logger.warn', () => {
    const world = fakeWorld()
    apply(world.ctx)
    const agent = world.newAgent('main')
    agent.register.mockImplementation(() => {
      throw new Error('registry closed')
    })
    expect(() => world.emitCreated(agent)).not.toThrow()
    expect(world.logger.warn).toHaveBeenCalledTimes(1)
    expect(world.logger.warn).toHaveBeenCalledWith('rolesubagents: could not prepare agent main: registry closed')
  })

  it('logs a thrown non-Error value as text', () => {
    const world = fakeWorld()
    apply(world.ctx)
    const agent = world.newAgent('main')
    agent.session.snapshotEvents = () => {
      throw 'plain failure'
    }
    expect(() => world.emitCreated(agent)).not.toThrow()
    expect(world.logger.warn).toHaveBeenCalledWith('rolesubagents: could not prepare agent main: plain failure')
  })

  it('does not install a tool for the agent whose preparation failed, and later agents still work', () => {
    const world = fakeWorld()
    apply(world.ctx)
    const broken = world.newAgent('broken')
    broken.session.snapshotEvents = () => {
      throw new Error('unreadable log')
    }
    world.emitCreated(broken)
    expect(broken.register).not.toHaveBeenCalled()
    const healthy = world.newAgent('healthy')
    world.emitCreated(healthy)
    expect(healthy.register).toHaveBeenCalledTimes(1)
  })

  it('does not let one failing existing agent stop the plugin from being applied', () => {
    const world = fakeWorld()
    const broken = world.newAgent('broken')
    broken.register.mockImplementation(() => {
      throw new Error('cannot register')
    })
    const fine = world.newAgent('fine')
    world.agents = [broken, fine]
    expect(() => apply(world.ctx)).not.toThrow()
    expect(world.logger.warn).toHaveBeenCalledWith('rolesubagents: could not prepare agent broken: cannot register')
    expect(fine.register).toHaveBeenCalledTimes(1)
  })

  it('does not swallow errors raised when the tool itself runs', async () => {
    const world = fakeWorld()
    apply(world.ctx)
    const agent = world.newAgent('main')
    world.emitCreated(agent)
    world.providers.delete('spawn')
    await expect(registeredTool(agent).execute({ ...ARGS }, execContext(agent))).rejects.toThrow(
      'subagent provider "spawn" is not available',
    )
  })
})
