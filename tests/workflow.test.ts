import vm from 'node:vm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/host/index.ts'
import { workflowScript, workflowTool } from '../src/host/workflow.ts'
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/shared/roles.ts'
import { execContext, fakeWorld } from './host-fakes.ts'

vi.mock('@deepseek-ai/dsh-tools', () => import('./host-fakes.ts').then(m => m.toolsModule()))
vi.mock('@deepseek-ai/dsh-storage-domain', () => import('./host-fakes.ts').then(m => m.storageDomainModule()))

const route = { provider: 'configured-provider', model: 'configured-model' }

async function run(script: string) {
  const calls: { prompt: unknown; options: unknown }[] = []
  const agent = (prompt: unknown, options?: unknown) => {
    calls.push({ prompt, options })
    return Promise.resolve(prompt)
  }
  const parallel = (items: (() => unknown)[]) => Promise.all(items.map(item => item()))
  const pipeline = (items: unknown[], stage: (item: unknown) => unknown) => Promise.all(items.map(stage))
  const context = vm.createContext({ agent, parallel, pipeline, args: { text: 'from args' }, phase() {}, log() {} })
  const value = await new vm.Script(`(async () => {${workflowScript(script, route)}\n})()`).runInContext(context)
  return { calls, value }
}

function nativeTool(): ToolDefinition {
  return { name: 'workflow', execute: vi.fn(async (args: unknown) => args) } as unknown as ToolDefinition
}

function enableWorkflow(world: ReturnType<typeof fakeWorld>, id: string, original = nativeTool()) {
  const agent = world.newAgent(id)
  agent.ctx.tools.get = vi.fn(() => original)
  return { agent, original }
}

describe('workflow model settings', () => {
  it('keeps old settings and null unchanged, and normalizes a detached model-only route', () => {
    expect(normalizeSettings(DEFAULT_SETTINGS).settings).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, workflowModel: null }).settings).toEqual(DEFAULT_SETTINGS)
    const result = normalizeSettings({
      ...DEFAULT_SETTINGS,
      workflowModel: { provider: ' p ', model: ' m ', instructions: 'never', reasoningEffort: 'high' },
    })
    expect(result.settings.workflowModel).toEqual({ provider: 'p', model: 'm' })
    expect(result.problems).toEqual([])
  })

  it.each([
    {},
    [],
    'model',
    5,
    { provider: 'p' },
    { model: 'm' },
    { provider: 'p', model: ' ' },
    { provider: 'p', model: 'm'.repeat(129) },
  ])('rejects malformed stored defaults: %j', workflowModel => {
    const result = normalizeSettings({ ...DEFAULT_SETTINGS, workflowModel })
    expect(result.settings.workflowModel).toBeUndefined()
    expect(result.problems.map(p => p.code)).toEqual(['invalid-workflow-model'])
  })
})

describe('workflow script adapter', () => {
  it('sets only model defaults and preserves arguments, hooks, return, parallel and pipeline', async () => {
    const { calls, value } = await run(`
      phase('test'); log('running');
      const a = await parallel([() => agent(args.text), () => agent('two', {label:'label', phase:'test', schema:{type:'object'}})]);
      const b = await pipeline(['three'], prompt => agent(prompt));
      return [...a, ...b];
    `)
    expect(Array.from(value)).toEqual(['from args', 'two', 'three'])
    expect(calls.map(c => c.options)).toEqual([
      route,
      { ...route, label: 'label', phase: 'test', schema: { type: 'object' } },
      route,
    ])
  })

  it('leaves either explicit routing field to native resolution, including invalid values', async () => {
    const { calls } = await run(`
      await agent('both', {provider:'explicit', model:'explicit-model'});
      await agent('model only', {model:'explicit-model'});
      await agent('provider only', {provider:'explicit'});
      await agent('invalid model', {model:null});
      await agent('empty provider', {provider:''});
    `)
    expect(calls.map(c => c.options)).toEqual([
      { provider: 'explicit', model: 'explicit-model' },
      { model: 'explicit-model' },
      { provider: 'explicit' },
      { model: null },
      { provider: '' },
    ])
  })

  it('passes malformed options through and retains unknown keys for native rejection', async () => {
    const { calls } = await run(`
      await agent('null', null); await agent('array', []); await agent('primitive', 1);
      class Options { constructor() { this.foo = 'class'; } }
      await agent('class', new Options()); await agent('unknown', {foo:'unknown'});
    `)
    expect(calls[0]?.options).toBeNull()
    expect(Array.isArray(calls[1]?.options)).toBe(true)
    expect(calls[2]?.options).toBe(1)
    expect(calls[3]?.options).toEqual({ foo: 'class' })
    expect(Object.getPrototypeOf(calls[3]?.options).constructor.name).toBe('Options')
    expect(calls[4]?.options).toEqual({ ...route, foo: 'unknown' })
  })

  it('does not collide with declarations, comments or model IDs containing script syntax', async () => {
    const weird = { provider: 'p"\\\n', model: 'm`); throw Error("oops"); //' }
    const calls: unknown[] = []
    const context = vm.createContext({ agent: (_p: unknown, opts: unknown) => calls.push(opts) })
    const script = workflowScript('const original = 1; const options = 2; await agent("ok"); return 42; // end', weird)
    expect(await new vm.Script(`(async()=>{${script}})()`).runInContext(context)).toBe(42)
    expect(calls).toEqual([weird])
  })

  it('keeps scripts free to shadow agent themselves', async () => {
    const { calls, value } = await run('const agent = () => 7; return agent();')
    expect(value).toBe(7)
    expect(calls).toEqual([])
  })
})

describe('official workflow tool decoration', () => {
  it('copies metadata, forwards exec and args immutably including background, and unwraps inherited decorators', async () => {
    const original = nativeTool()
    const decorated = workflowTool(original, route)
    const args = Object.freeze({
      script: 'return await agent("task")',
      run_in_background: true,
      meta: { name: 'test' },
    })
    const exec = execContext(undefined)
    await decorated.execute(args, exec)
    expect(original.execute).toHaveBeenCalledWith({ ...args, script: workflowScript(args.script, route) }, exec)
    expect(args.script).toBe('return await agent("task")')
    const secondRoute = { provider: 'next', model: 'next' }
    await workflowTool(decorated, secondRoute).execute(args, exec)
    expect(original.execute).toHaveBeenLastCalledWith(
      { ...args, script: workflowScript(args.script, secondRoute) },
      exec,
    )
  })

  it('does not hide malformed tool args from the original', async () => {
    const original = nativeTool()
    const wrapped = workflowTool(original, route)
    await wrapped.execute(null, execContext(undefined))
    expect(original.execute).toHaveBeenCalledWith(null, expect.anything())
  })

  it('decorates only an existing visible workflow and never applies a role to its children', async () => {
    const world = fakeWorld()
    apply(world.ctx, { workflowModel: route })
    const { agent, original } = enableWorkflow(world, 'root')
    world.emitCreated(agent)
    expect(agent.ctx.tools.get).toHaveBeenCalledWith('workflow', agent)
    const wrapped = agent.registered.find(tool => tool.name === 'workflow')
    expect(wrapped).toBeDefined()
    await wrapped?.execute({ script: 'return await agent("task")' }, execContext(agent))
    expect(original.execute).toHaveBeenCalledTimes(1)
    expect(world.subagents.startActivation).not.toHaveBeenCalled()
    const child = world.newAgent('workflow-child', { parentSession: agent.session.id })
    world.emitCreated(child)
    expect(world.runtimeContext(child)).toBe('')
    expect(world.storedRole(child.session.id)).toBeUndefined()
    expect(child.guards).toEqual([])
    expect(child.session.log).toEqual([])
    world.emitDisposed(agent)
    expect(agent.disposers.every(dispose => dispose.mock.calls.length === 1)).toBe(true)
    world.teardown()
  })

  it.each([undefined, null])('does not decorate with an unset setting %j', workflowModel => {
    const world = fakeWorld()
    apply(world.ctx, { workflowModel })
    const { agent } = enableWorkflow(world, 'root')
    world.emitCreated(agent)
    expect(agent.registered.map(tool => tool.name)).toEqual(['delegate'])
    world.teardown()
  })

  it('keeps workflow absent in a preset without it and honors the master switch', () => {
    const world = fakeWorld()
    apply(world.ctx, { workflowModel: route })
    const agent = world.newAgent('no-workflow')
    agent.ctx.tools.get = () => undefined
    world.emitCreated(agent)
    expect(agent.registered.map(tool => tool.name)).toEqual(['delegate'])
    world.teardown()
    const disabled = fakeWorld()
    apply(disabled.ctx, { enabled: false, workflowModel: route })
    const { agent: off } = enableWorkflow(disabled, 'off')
    disabled.emitCreated(off)
    expect(off.registered).toEqual([])
    disabled.teardown()
  })

  it('lazily refreshes external changes and makes captured wrappers fail closed', async () => {
    const world = fakeWorld()
    apply(world.ctx, { workflowModel: route })
    const agent = world.newAgent('switching')
    let inherited: ToolDefinition | undefined = nativeTool()
    let shadow: ToolDefinition | undefined
    let registrations = 0
    agent.ctx.tools.get = () => shadow ?? inherited
    const register = agent.ctx.tools.register
    agent.ctx.tools.register = tool => {
      if (tool.name !== 'workflow') return register(tool)
      if (shadow !== undefined) throw new Error('duplicate workflow')
      registrations++
      shadow = tool
      world.emitToolsChange()
      return () => {
        if (shadow !== tool) return
        shadow = undefined
        world.emitToolsChange()
      }
    }
    world.emitCreated(agent)
    expect(registrations).toBe(1)
    const captured = shadow
    const first = inherited
    inherited = nativeTool()
    world.emitToolsChange()
    expect(registrations).toBe(1)
    const args = { script: 'return agent("task")' }
    await captured?.execute(args, execContext(agent))
    expect(registrations).toBe(2)
    expect(first?.execute).not.toHaveBeenCalled()
    expect(inherited.execute).toHaveBeenCalledExactlyOnceWith(
      { script: workflowScript(args.script, route) },
      expect.anything(),
    )
    inherited = undefined
    world.emitToolsChange()
    expect(() => captured?.execute(args, execContext(agent))).toThrow('no longer available')
    expect(shadow).toBeUndefined()
    inherited = nativeTool()
    world.emitToolsChange()
    world.runtimeContext(agent)
    expect(registrations).toBe(3)
    world.emitDisposed(agent)
    expect(shadow).toBeUndefined()
    expect(() => captured?.execute(args, execContext(agent))).toThrow('no longer available')
    world.teardown()
  })

  it('logs a same-layer collision without losing delegate or its cleanup', () => {
    const world = fakeWorld()
    apply(world.ctx, { workflowModel: route })
    const { agent } = enableWorkflow(world, 'collision')
    const register = agent.ctx.tools.register
    agent.ctx.tools.register = tool => {
      if (tool.name === 'workflow') throw new Error('duplicate workflow')
      return register(tool)
    }
    world.emitCreated(agent)
    expect(agent.registered.map(tool => tool.name)).toEqual(['delegate'])
    expect(world.logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not decorate workflow'))
    world.emitDisposed(agent)
    expect(agent.disposers[0]).toHaveBeenCalledOnce()
    world.teardown()
  })

  it('snapshots settings per session, including resume, and keeps new sessions independent', async () => {
    const world = fakeWorld()
    let configured = route
    apply(world.ctx, { workflowModel: { get: () => configured } })
    const { agent } = enableWorkflow(world, 'root')
    world.emitCreated(agent)
    configured = { provider: 'new-provider', model: 'new-model' }
    const { agent: next } = enableWorkflow(world, 'next')
    world.emitCreated(next)
    const first = agent.registered.find(tool => tool.name === 'workflow')
    const second = next.registered.find(tool => tool.name === 'workflow')
    const args = { script: 'return agent("task")' }
    expect(await first?.execute(args, execContext(agent))).toEqual({ script: workflowScript(args.script, route) })
    expect(await second?.execute(args, execContext(next))).toEqual({ script: workflowScript(args.script, configured) })
    await world.settle()
    world.teardown()
    const resumed = fakeWorld(world.storage)
    apply(resumed.ctx, { workflowModel: configured })
    const { agent: restored } = enableWorkflow(resumed, 'root')
    await resumed.settle()
    resumed.emitCreated(restored, 'resume')
    const tool = restored.registered.find(tool => tool.name === 'workflow')
    expect(await tool?.execute(args, execContext(restored))).toEqual({ script: workflowScript(args.script, route) })
    resumed.teardown()
  })
})
