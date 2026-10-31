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

async function run(script: string, args: unknown = { text: 'from args' }) {
  const calls: { prompt: unknown; options: unknown }[] = []
  const agent = (prompt: unknown, options?: unknown) => {
    calls.push({ prompt, options })
    return Promise.resolve(prompt)
  }
  const parallel = (items: (() => unknown)[]) => Promise.all(items.map(item => item()))
  const pipeline = (items: unknown[], stage: (item: unknown) => unknown) => Promise.all(items.map(stage))
  const context = vm.createContext({ agent, parallel, pipeline, args, phase() {}, log() {} })
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
      await agent('undefined provider', {provider:undefined});
      await agent('undefined model', {model:undefined});
    `)
    expect(calls.map(c => c.options)).toEqual([
      { provider: 'explicit', model: 'explicit-model' },
      { model: 'explicit-model' },
      { provider: 'explicit' },
      { model: null },
      { provider: '' },
      { provider: undefined },
      { model: undefined },
    ])
  })

  it.each([Object.freeze({ label: 'from JSON' }), Object.assign(Object.create(null), { label: 'from JSON' })])(
    'applies defaults to cross-realm plain options without mutating them',
    async options => {
      const { calls } = await run('return await agent("task", args.options);', { options })
      expect(calls[0]?.options).toEqual({ ...route, label: 'from JSON' })
      expect(options).toEqual({ label: 'from JSON' })
      expect(Object.hasOwn(options, 'provider')).toBe(false)
    },
  )

  it('leaves accessors, non-enumerable and symbol properties for native materialization', async () => {
    const { calls, value } = await run(`
      let reads = 0;
      const options = {get label() { reads++; if (this !== options) throw Error('changed receiver'); return 'label'; }};
      await agent('accessor', options);
      await agent('throwing accessor', {get label() { throw Error('invalid option'); }});
      await agent('symbol', Object.defineProperty({}, Symbol('invalid'), {value: true}));
      await agent('hidden', Object.defineProperty({}, 'unexpected', {get() { throw Error('hidden'); }}));
      return reads;
    `)
    expect(value).toBe(0)
    expect((calls[0]!.options as { label: string }).label).toBe('label')
    expect(() => (calls[1]!.options as { label: string }).label).toThrow('invalid option')
    expect(Object.getOwnPropertySymbols(calls[2]!.options as object)).toHaveLength(1)
    expect(Object.getOwnPropertyDescriptor(calls[3]!.options, 'unexpected')?.enumerable).toBe(false)
    expect(Object.keys(calls[3]!.options as object)).toEqual(['provider', 'model'])
  })

  it('keeps throwing proxy reads native and passes introspection failures through unchanged', async () => {
    const { calls, value } = await run(`
      const prototype = new Proxy({}, {getPrototypeOf() { throw Error('prototype'); }});
      const keys = new Proxy({}, {ownKeys() { throw Error('keys'); }});
      await agent('prototype', prototype);
      await agent('keys', keys);
      await agent('read', new Proxy({label:'label'}, {get() { throw Error('read'); }}));
      return [prototype, keys];
    `)
    expect(calls[0]!.options).toBe(value[0])
    expect(calls[1]!.options).toBe(value[1])
    expect(() => (calls[2]!.options as { label: string }).label).toThrow('read')
  })

  it.each(['null', 'Object.prototype'])('preserves array identity with a %s prototype', async prototype => {
    const { calls, value } = await run(`
      const options = Object.setPrototypeOf([], ${prototype});
      await agent('array', options);
      return options;
    `)
    expect(calls[0]!.options).toBe(value)
    expect(Array.isArray(calls[0]!.options)).toBe(true)
    expect(Object.hasOwn(value, 'provider')).toBe(false)
    expect(Object.hasOwn(value, 'model')).toBe(false)
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
    await world.emitCreated(agent)
    expect(agent.ctx.tools.get).toHaveBeenCalledWith('workflow', agent)
    const wrapped = agent.registered.find(tool => tool.name === 'workflow')
    expect(wrapped).toBeDefined()
    await wrapped?.execute({ script: 'return await agent("task")' }, execContext(agent))
    expect(original.execute).toHaveBeenCalledTimes(1)
    expect(world.subagents.startActivation).not.toHaveBeenCalled()
    const child = world.newAgent('workflow-child', { parentSession: agent.session.id })
    await world.emitCreated(child)
    expect(world.runtimeContext(child)).toBe('')
    expect(world.storedRole(child.session.id)).toBeUndefined()
    expect(child.guards).toEqual([])
    expect(child.session.log).toEqual([])
    world.emitDisposed(agent)
    expect(agent.disposers.every(dispose => dispose.mock.calls.length === 1)).toBe(true)
    await world.teardown()
  })

  it.each([true, false])(
    'honors host executable eligibility %j without falling back to visible definitions',
    async eligible => {
      const world = fakeWorld()
      apply(world.ctx, { workflowModel: route })
      const { agent, original } = enableWorkflow(world, 'conditional')
      const executable = vi.fn(() => (eligible ? original : undefined))
      Object.assign(agent.ctx.tools, { executable })
      await world.emitCreated(agent)
      expect(executable).toHaveBeenCalledWith('workflow', agent)
      expect(agent.ctx.tools.get).not.toHaveBeenCalled()
      const wrapped = agent.registered.find(tool => tool.name === 'workflow')
      if (eligible) {
        expect(wrapped).toBeDefined()
        const args = { script: 'return agent("task")' }
        await wrapped?.execute(args, execContext(agent))
        expect(original.execute).toHaveBeenCalledWith({ script: workflowScript(args.script, route) }, expect.anything())
      } else {
        expect(wrapped).toBeUndefined()
        expect(original.execute).not.toHaveBeenCalled()
      }
      await world.teardown()
    },
  )

  it.each([undefined, null])('does not decorate with an unset setting %j', async workflowModel => {
    const world = fakeWorld()
    apply(world.ctx, { workflowModel })
    const { agent } = enableWorkflow(world, 'root')
    await world.emitCreated(agent)
    expect(agent.registered.map(tool => tool.name)).toEqual(['delegate'])
    await world.teardown()
  })

  it('keeps workflow absent in a preset without it and honors the master switch', async () => {
    const world = fakeWorld()
    apply(world.ctx, { workflowModel: route })
    const agent = world.newAgent('no-workflow')
    agent.ctx.tools.get = () => undefined
    await world.emitCreated(agent)
    expect(agent.registered.map(tool => tool.name)).toEqual(['delegate'])
    await world.teardown()
    const disabled = fakeWorld()
    apply(disabled.ctx, { enabled: false, workflowModel: route })
    const { agent: off } = enableWorkflow(disabled, 'off')
    await disabled.emitCreated(off)
    expect(off.registered).toEqual([])
    await disabled.teardown()
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
    await world.emitCreated(agent)
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
    await world.teardown()
  })

  it('logs a same-layer collision without losing delegate or its cleanup', async () => {
    const world = fakeWorld()
    apply(world.ctx, { workflowModel: route })
    const { agent } = enableWorkflow(world, 'collision')
    const register = agent.ctx.tools.register
    agent.ctx.tools.register = tool => {
      if (tool.name === 'workflow') throw new Error('duplicate workflow')
      return register(tool)
    }
    await world.emitCreated(agent)
    expect(agent.registered.map(tool => tool.name)).toEqual(['delegate'])
    expect(world.logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not decorate workflow'))
    world.emitDisposed(agent)
    expect(agent.disposers[0]).toHaveBeenCalledOnce()
    await world.teardown()
  })

  it('snapshots settings per session, including resume, and keeps new sessions independent', async () => {
    const world = fakeWorld()
    let configured = route
    apply(world.ctx, { workflowModel: { get: () => configured } })
    const { agent } = enableWorkflow(world, 'root')
    await world.emitCreated(agent)
    configured = { provider: 'new-provider', model: 'new-model' }
    const { agent: next } = enableWorkflow(world, 'next')
    await world.emitCreated(next)
    const first = agent.registered.find(tool => tool.name === 'workflow')
    const second = next.registered.find(tool => tool.name === 'workflow')
    const args = { script: 'return agent("task")' }
    expect(await first?.execute(args, execContext(agent))).toEqual({ script: workflowScript(args.script, route) })
    expect(await second?.execute(args, execContext(next))).toEqual({ script: workflowScript(args.script, configured) })
    await world.settle()
    await world.teardown()
    const resumed = fakeWorld(world.storage)
    apply(resumed.ctx, { workflowModel: configured })
    const { agent: restored } = enableWorkflow(resumed, 'root')
    await resumed.settle()
    await resumed.emitCreated(restored, 'resume')
    const tool = restored.registered.find(tool => tool.name === 'workflow')
    expect(await tool?.execute(args, execContext(restored))).toEqual({ script: workflowScript(args.script, route) })
    await resumed.teardown()
  })
})
