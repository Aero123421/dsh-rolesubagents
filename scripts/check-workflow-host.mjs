#!/usr/bin/env node
/**
 * Optional integration check against a real installed DSH host (no network; disposable HOME).
 * Run with Node 24: node scripts/check-workflow-host.mjs
 * Node 22 also works with --experimental-strip-types.
 * Override the installation root with DSH_CHECKOUT=/path/to/dsh.
 *
 * The actual PTC engine and its native guest SDK run through an in-memory PTC
 * transport and fake child backend. This checks orchestration contracts, not
 * process sandbox enforcement or live model credentials.
 */
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { hostResolveHook } from './host-resolve-hook.mjs'
import { isolateCheckEnvironment } from './check-environment.mjs'

const checkout = resolve(process.env.DSH_CHECKOUT || '/usr/lib/node_modules/@deepseek-ai/dsh')
const checkEnvironment = isolateCheckEnvironment()
const hostRequire = createRequire(resolve(checkout, 'package.json'))
// Resolve host peers from one installation, as DSH does when loading a plugin.
// This also avoids accidentally testing different dev-dependency service classes.
const resolutionHook = registerHooks(hostResolveHook(hostRequire))

const { Context } = await import('@deepseek-ai/cordis')
const { default: ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const { createScope, bindScopeParent } = await import('@deepseek-ai/dsh-scope')
const { default: PtcWorkflowEngine } = await import('@deepseek-ai/dsh-workflow-ptc')
const { workflowScript } = await import('../src/host/workflow.ts')
const { apply } = await import('../src/host/index.ts')

const configured = { provider: 'configured-provider', model: 'configured-model' }
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
let assertions = 0
function pass(label) {
  assertions++
  console.log(`PASS ${label}`)
}

async function checkNativeWorkflow() {
  const ctx = new Context()
  const starts = []
  let disposals = 0
  ctx.provide('ptcRuntime', {
    language: 'typescript',
    programFormat: 'function',
    resolve: value => value,
    async run(spec) {
      try {
        // Execute the real host PROGRAM, which dynamically imports DSH's real
        // guest source. Do not replace its agent/schema/combinator validators.
        return { value: await new AsyncFunction('workflowHost', spec.program)(spec.bindings[0].functions) }
      } catch (error) {
        return { error: { kind: 'execution', message: String(error) } }
      }
    },
  })
  ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'danger-full-access' }) })
  ctx.provide('workingDirectory', { ensure: async () => process.cwd() })
  ctx.provide('subagents', {
    getProvider: name => (name === 'spawn' ? {} : undefined),
    async startActivation(spec) {
      starts.push(spec)
      return {
        childId: `child-${starts.length}`,
        result: Promise.resolve({
          output: [{ type: 'text', text: 'answer' }],
          stopReason: 'completed',
          ...(spec.request.outputSchema ? { structured: { ok: true } } : {}),
        }),
        async dispose() {
          disposals++
        },
      }
    },
  })
  const engine = new PtcWorkflowEngine(ctx, {
    provider: 'spawn',
    maxConcurrentAgents: 2,
    maxTotalAgents: 20,
    maxItemsPerCall: 50,
    syncTimeoutMs: 5000,
  })
  async function run(script, extra = {}, adapt = true) {
    starts.length = 0
    disposals = 0
    const live = engine.start({
      script: adapt ? workflowScript(script, configured) : script,
      meta: { name: 'plugin-host-check', description: 'Optional real DSH guest integration check' },
      parent: { id: 'parent', session: {} },
      ...extra,
    })
    const result = await live.result
    await live.dispose()
    assert.equal(disposals, starts.length, 'every admitted child must be disposed')
    for (const spec of starts) {
      assert.equal(spec.provider, 'spawn')
      assert.equal(spec.delivery, 'caller')
      assert.equal(spec.request.agentPreset, undefined, 'no plugin-selected preset')
      assert.equal(spec.request.parent.id, 'parent')
    }
    return { result, options: starts.map(spec => spec.request.agentOptions), starts: [...starts] }
  }

  let test = await run('return await agent("default");')
  assert.equal(test.result.stopReason, 'completed')
  assert.equal(test.result.value, 'answer')
  assert.deepEqual(test.options, [configured])
  pass('real guest receives configured workflow route')

  test = await run('return await agent("native fallback");', {}, false)
  assert.equal(test.result.stopReason, 'completed')
  assert.deepEqual(test.options, [undefined])
  pass('native no-route request retains parent-fallback seam')

  test = await run(`return await parallel([
    () => agent('provider', {provider: 'explicit-provider'}),
    () => agent('model', {model: 'explicit-model'}),
    () => agent('both', {provider: 'p', model: 'm'})
  ]);`)
  assert.equal(test.result.stopReason, 'completed')
  assert.deepEqual(test.options, [
    { provider: 'explicit-provider' },
    { model: 'explicit-model' },
    { provider: 'p', model: 'm' },
  ])
  pass('explicit partial and full routes bypass all configured defaults')

  test = await run(`phase('build'); return await pipeline([1, 2],
    async (_, item) => agent('schema ' + item, {
      label: 'item', phase: 'build', schema: {
        type: 'object', properties: {ok: {type: 'boolean'}},
        required: ['ok'], additionalProperties: false
      }
    }), async value => value.ok);`)
  assert.equal(test.result.stopReason, 'completed')
  assert.deepEqual(test.result.value, [true, true])
  assert.deepEqual(test.options, [configured, configured])
  assert(test.starts.every(spec => spec.request.outputSchema))
  pass('phase, schema capture and pipeline preserve native behavior')

  for (const options of [
    'null',
    '[]',
    '42',
    '{unexpected: true}',
    '{provider: 42}',
    '{model: 42}',
    'new Date()',
    'new (class Options {})()',
  ]) {
    test = await run(`return await parallel([() => agent('bad', ${options})]);`)
    assert.equal(test.result.stopReason, 'error', options)
    assert.equal(test.starts.length, 0, options)
  }
  pass('malformed options remain fatal through parallel, before child admission')

  // Native guest validates string type, not non-emptiness; backend route
  // resolution may reject these later. The adapter must not silently fix them.
  for (const [field, expected] of [
    ['provider', { provider: '' }],
    ['model', { model: '' }],
  ]) {
    test = await run(`return await agent('empty explicit', {${field}: ''});`)
    assert.equal(test.result.stopReason, 'completed')
    assert.deepEqual(test.options, [expected])
  }
  pass('empty explicit strings pass through unchanged to backend validation')

  test = await run('return await parallel([() => agent("one"), () => agent("two")]);', { maxTotalAgents: 1 })
  assert.equal(test.result.stopReason, 'error')
  assert.match(test.result.error, /cap|limit|ceiling|exceeds/i)
  assert.equal(test.starts.length, 1)
  pass('native total-child cap stays fatal and admits only one child')
}

async function checkScopedRefresh() {
  const root = new Context()
  const contexts = []
  root.provide('systemPrompt', {
    tools() {},
    context(provider) {
      contexts.push(provider)
    },
  })
  const refreshPrompt = agent => {
    for (const provider of contexts) provider.text({ agent })
  }
  new ToolRuntime(root, { mode: 'native' })
  root.provide('subagents', { resolveMaxDepth: () => 1 })
  root.provide('agents', { list: () => [] })
  const warnings = []
  const pluginCtx = root.extend({ logger: { warn: message => warnings.push(String(message)) } })
  let changes = 0
  root.on('tools/change', () => {
    assert(++changes < 200, 'workflow refresh must not recurse indefinitely')
  })
  const scopes = []
  const disposers = []
  const invoked = []
  const makeDefinition = mark => ({
    name: 'workflow',
    description: `original ${mark}`,
    parameters: {},
    output: { schema: { type: 'object', properties: {} }, render: () => [] },
    execute(args) {
      invoked.push({ mark, script: args.script })
      return { mark }
    },
  })
  function makeAgent(id, parentKey) {
    const agent = { id, session: { id, header: {}, snapshotEvents: () => [] } }
    const scope = createScope(root, agent)
    scopes.push(scope)
    agent.ctx = scope.ctx
    const binding = bindScopeParent(agent, parentKey)
    return { agent, binding }
  }
  function execute(agent, expected) {
    const tool = agent.ctx.tools.get('workflow', agent)
    assert(tool, `workflow expected for ${agent.id}`)
    tool.execute({ script: 'return 1;' }, {})
    assert.equal(invoked.at(-1).mark, expected)
    assert.match(invoked.at(-1).script, /configured-model/)
    return tool
  }
  const firstKey = {},
    secondKey = {},
    emptyKey = {}
  const first = createScope(root, firstKey)
  const second = createScope(root, secondKey)
  const empty = createScope(root, emptyKey)
  scopes.push(first, second, empty)
  let removeFirst = first.ctx.tools.register(makeDefinition('first'))
  disposers.push(() => removeFirst())
  disposers.push(second.ctx.tools.register(makeDefinition('second preset')))
  const { agent, binding } = makeAgent('scope-check', firstKey)
  apply(pluginCtx, { workflowModel: configured })
  await root.serial('agent/created', { agent, source: 'startup' })
  const firstWrapper = execute(agent, 'first')
  pass('actual host tool registry permits agent shadow over preset ancestor')

  const beforeRemoval = changes
  removeFirst()
  assert.equal(changes, beforeRemoval + 1, 'invalidation must not eagerly mutate registries')
  assert.equal(agent.ctx.tools.get('workflow', agent), firstWrapper)
  const beforeDeniedCall = invoked.length
  assert.throws(() => firstWrapper.execute({ script: 'return 1;' }, {}), /no longer available/)
  assert.equal(invoked.length, beforeDeniedCall)
  assert.equal(agent.ctx.tools.get('workflow', agent), undefined)
  pass('captured wrapper rejects removed native tool even before prompt refresh')

  removeFirst = first.ctx.tools.register(makeDefinition('replacement'))
  refreshPrompt(agent)
  const replacementWrapper = execute(agent, 'replacement')
  removeFirst()
  removeFirst = first.ctx.tools.register(makeDefinition('replacement after capture'))
  const beforeForward = invoked.length
  replacementWrapper.execute({ script: 'return 2;' }, {})
  assert.equal(invoked.length, beforeForward + 1, 'captured wrapper must execute exactly one current native tool')
  assert.equal(invoked.at(-1).mark, 'replacement after capture')
  assert.equal(invoked.at(-1).script.split('((original)').length - 1, 1, 'script must be wrapped exactly once')
  pass('captured wrapper forwards replacement native execution exactly once')

  const unrestrictedWrapper = agent.ctx.tools.get('workflow', agent)
  const liftRestriction = agent.ctx.tools.restrict({ deny: ['workflow'] })
  assert.throws(() => unrestrictedWrapper.execute({ script: 'return 3;' }, {}), /no longer available/)
  assert.equal(agent.ctx.tools.get('workflow', agent), undefined)
  liftRestriction()
  refreshPrompt(agent)
  execute(agent, 'replacement after capture')
  pass('scope restriction revokes captured shadow and lifting restriction restores it')

  binding.rebind(secondKey)
  root.emit('tools/change')
  refreshPrompt(agent)
  execute(agent, 'second preset')
  binding.rebind(emptyKey)
  root.emit('tools/change')
  refreshPrompt(agent)
  assert.equal(agent.ctx.tools.get('workflow', agent), undefined)
  binding.rebind(firstKey)
  root.emit('tools/change')
  refreshPrompt(agent)
  execute(agent, 'replacement after capture')
  pass('prompt context refresh updates or removes workflow after preset scope rebind')

  const { agent: collision } = makeAgent('same-layer-collision', firstKey)
  const local = makeDefinition('local collision')
  disposers.push(collision.ctx.tools.register(local))
  const warningCount = warnings.length
  await root.serial('agent/created', { agent: collision, source: 'startup' })
  assert.equal(collision.ctx.tools.get('workflow', collision), local)
  assert(
    warnings.slice(warningCount).some(text => /workflow/i.test(text)),
    'same-layer collision must warn',
  )
  pass('unsupported same-layer collision warns and leaves existing tool untouched')

  // External changes invalidate in O(1): no eager per-agent registry writes.
  const before = changes
  const beforeUnrelated = agent.ctx.tools.get('workflow', agent)
  root.emit('tools/change')
  assert.equal(changes, before + 1, 'one event must not trigger registry mutations')
  assert.equal(agent.ctx.tools.get('workflow', agent), beforeUnrelated)
  assert.equal(collision.ctx.tools.get('workflow', collision), local)
  execute(agent, 'replacement after capture')
  pass('unrelated tools/change performs no immediate registry writes')

  const beforeDispose = agent.ctx.tools.get('workflow', agent)
  root.emit('agent/disposed', { agent })
  const inherited = agent.ctx.tools.get('workflow', agent)
  assert.equal(inherited.description, 'original replacement after capture')
  assert.throws(() => beforeDispose.execute({ script: 'return 4;' }, {}), /no longer available/)
  root.emit('tools/change')
  refreshPrompt(agent)
  assert.equal(agent.ctx.tools.get('workflow', agent), inherited)
  root.emit('agent/disposed', { agent: collision })
  pass('agent disposal revokes captured wrapper and does not reinstall shadow')

  for (const dispose of disposers.reverse()) dispose()
  for (const scope of scopes.reverse()) await scope.dispose()
}

try {
  console.log(`Checking installed DSH host: ${checkout}`)
  await checkNativeWorkflow()
  await checkScopedRefresh()
  console.log(`Completed ${assertions} installed-host integration checks.`)
} finally {
  resolutionHook.deregister()
  checkEnvironment.dispose()
}
