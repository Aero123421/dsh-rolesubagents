#!/usr/bin/env node
/** Installed DSH settings/Loader/tool integration. Disposable profile, metadata stubs, no models/CLIs/server. */
import assert from 'node:assert/strict'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isolateCheckEnvironment } from './check-environment.mjs'
import { hostResolveHook } from './host-resolve-hook.mjs'
import { mountNativeTools, executeHostTool } from './host-tools.mjs'

// Isolation MUST precede any installed runtime or source-plugin import.
const isolated = isolateCheckEnvironment()
const checkout = resolve(process.env.DSH_CHECKOUT || '/usr/lib/node_modules/@deepseek-ai/dsh')
const hook = registerHooks(hostResolveHook(createRequire(join(checkout, 'package.json'))))
let live
let passes = 0
const pass = label => {
  passes++
  console.log(`PASS ${label}`)
}
const deferred = () => {
  let resolve
  const promise = new Promise(yes => {
    resolve = yes
  })
  return { promise, resolve }
}
try {
  const manifest = JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8'))
  console.log(`RUNTIME DSH ${manifest.version}; Node ${process.versions.node}; ${process.platform}/${process.arch}`)
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader')
  const { default: Include } = await import('@deepseek-ai/cordis-plugin-include')
  const { default: ConfigEditor } = await import('@deepseek-ai/dsh-config-editor')
  const { default: Settings } = await import('@deepseek-ai/dsh-settings')
  const { default: ToolRuntime } = await import('@deepseek-ai/dsh-tools')
  const { createScope, bindScopeParent } = await import('@deepseek-ai/dsh-scope')
  const { mountRootInclude, readProfilePatches } = await import('@deepseek-ai/dsh-app-boot')
  // Preload the actual protocol so the source Remote service can mount before readiness assertions.
  await import('@deepseek-ai/dsh-typert-protocol')
  const source = await import('../src/host/index.ts')
  const { ownManagementNamespace, ownManagementRawConfig, managementSettings } = await import(
    '../src/host/management/settings.ts'
  )
  const { createController } = await import('../src/client/controller.ts')
  const { DEFAULT_ROLES } = await import('../src/shared/roles.ts')
  const profile = join(isolated.home, 'profile')
  const basePath = join(profile, 'cordis.yml')
  const patchPath = join(profile, 'cordis.patch.yml')
  await mkdir(profile, { recursive: true })
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'role-management-host-fixture',
      private: true,
      type: 'module',
      dsh: { profile: { bundles: [] } },
    }),
  )
  await writeFile(basePath, '[]\n')
  await writeFile(
    patchPath,
    JSON.stringify(
      [
        {
          insert: [
            {
              id: 'rolesubagents',
              name: 'cordis:role-management-fixture',
              config: {
                enabled: true,
                allowAiRoleManagement: false,
                roles: structuredClone(DEFAULT_ROLES),
                workflowModel: { provider: 'saved-workflow', model: 'saved-workflow-model' },
                clis: {},
                fixtureUnrelated: 'KEEP',
              },
            },
          ],
        },
      ],
      null,
      2,
    ),
  )

  const fixtureRuns = []
  async function fixture(parentId = 'fixture-root') {
    const root = new Context()
    // If startup fails before the full fixture is returned, still quiesce its real runtime before HOME cleanup.
    live = { dispose: () => root.fiber.dispose() }
    const warnings = []
    root.provide('profileContext', {
      name: 'management-check',
      dir: profile,
      patchPath,
      installAnchor: checkout,
      cwd: profile,
      home: process.env.DSH_HOME,
      startedBundles: [],
      overlays: [],
      telemetryDisabledEnv: '1',
    })
    const logger = {
      warn: message => warnings.push(String(message)),
      info() {},
      error: message => warnings.push(String(message)),
    }
    // Fixtures provide identity/lifecycle, not an inference loop or child process.
    const agents = []
    const scopes = []
    const sessions = new Map()
    const contexts = []
    const starts = []
    const tables = new Map()
    const domains = new Map()
    root.provide('systemPrompt', {
      tools() {},
      context(provider) {
        contexts.push(provider)
      },
    })
    root.provide('agents', { list: () => agents })
    root.provide('sessions', { get: id => sessions.get(id) })
    root.provide('sandboxPolicy', {
      resolve: ({ session }) => ({ mode: session.mode ?? 'workspace-write', workspaceRoot: profile }),
    })
    root.provide('storageDomain', {
      async open(spec) {
        if (domains.has(spec.name)) throw new Error('Fixture duplicate domain')
        const domain = {
          table(name) {
            const key = `${spec.name}/${name}`
            if (!tables.has(key)) tables.set(key, new Map())
            const values = tables.get(key)
            return {
              entries: () => values.entries(),
              get: key => values.get(key),
              put: async (key, value) => {
                values.set(key, structuredClone(value))
              },
            }
          },
          async close() {
            domains.delete(spec.name)
          },
        }
        domains.set(spec.name, domain)
        return domain
      },
    })
    const metadata = { providers: 0, models: 0, info: 0, inference: 0 }
    fixtureRuns.push({ metadata, starts })
    root.provide('llm', {
      listProviders() {
        metadata.providers++
        return [{ id: 'fixture-provider', name: 'Fixture Provider' }]
      },
      async listModels(provider) {
        assert.equal(provider, 'fixture-provider')
        metadata.models++
        return [{ id: 'fixture-model', name: 'Fixture Model' }]
      },
      async resolveModelInfo(provider, model) {
        assert.equal(provider, 'fixture-provider')
        assert.equal(model, 'fixture-model')
        metadata.info++
        return { reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }
      },
      resolveCallConfig() {
        throw new Error('No inference/secret configuration allowed')
      },
      generate() {
        metadata.inference++
        throw new Error('Inference forbidden')
      },
    })
    // Scheduling barrier only; settings/configEditor/CAS/file locking remain real.
    let barrier
    root.provide('hmr', {
      async runExclusive(run) {
        const held = barrier
        barrier = undefined
        if (held) {
          held.entered.resolve()
          await held.release.promise
        }
        return run()
      },
    })
    await mountNativeTools(root, ToolRuntime)
    let inheritChildScope = true
    const makeAgent = (id, header = {}, inheritScope = true) => {
      const events = []
      const session = {
        id,
        header,
        mode: 'workspace-write',
        snapshotEvents: () => events,
        append(type, data) {
          events.push({ type, data })
          if (type === 'sandbox/mode') this.mode = data.mode
        },
      }
      const agent = { id, session }
      const scope = createScope(root, agent)
      agent.ctx = scope.ctx
      const enclosing = header.parentSession
        ? agents.find(value => value.session.id === header.parentSession)
        : undefined
      const binding = enclosing && inheritScope ? bindScopeParent(agent, enclosing) : undefined
      scopes.push({ scope, agent, binding })
      agents.push(agent)
      sessions.set(id, session)
      return agent
    }
    root.provide('subagents', {
      resolveMaxDepth: () => 4,
      getProvider: name =>
        ['spawn', 'fork'].includes(name)
          ? { name, capabilities: { agentOptions: true, agentPreset: false }, inheritsParentContext: name === 'fork' }
          : undefined,
      async startActivation(spec) {
        starts.push(spec)
        const child = makeAgent(
          spec.childId,
          {
            origin: 'subagent',
            parentSession: spec.request.parent.session.id,
            delegationDepth: (spec.request.parent.session.header.delegationDepth ?? 0) + 1,
          },
          inheritChildScope,
        )
        await root.serial('agent/created', { agent: child, source: 'subagent' })
        return { childId: child.id }
      },
    })
    const parent = makeAgent(parentId, { origin: 'web', delegationDepth: 0 })
    const loader = new Loader(root, { baseUrl: pathToFileURL(`${profile}/`).href })
    loader.builtins.include = Include
    let mounts = 0
    let pluginContext
    loader.builtins['role-management-fixture'] = {
      name: 'role-management-fixture',
      Config: source.Config,
      inject: source.inject,
      apply(ctx, config) {
        mounts++
        pluginContext = ctx
        source.apply(ctx.extend({ logger }), config)
      },
    }
    new ConfigEditor(root)
    new Settings(root)
    // Loader's internal isolation plugin must observe entry-init before the first Include is created.
    for (const runtime of root.registry.values()) for (const fiber of runtime.fibers) await fiber.await()
    await mountRootInclude(
      root,
      basePath,
      readProfilePatches('dsh', root.profileContext),
      pathToFileURL(`${checkout}/`).href,
    )
    await loader.await()
    for (let index = 0; index < 20; index++) await Promise.resolve()
    const entry = [...loader.entries()].find(value => value.options.id === 'rolesubagents')
    assert(entry?.fiber?.state === 2, `source plugin failed to activate: ${JSON.stringify(warnings)}`)
    const descriptor = () => {
      const values = root.settings.describe().filter(value => value.ns === 'rolesubagents')
      assert.equal(values.length, 1)
      return values[0]
    }
    const definition = (agent, name) => agent.ctx.tools.get(name, agent)
    let callId = 0
    const call = async (agent, args) => {
      const result = await executeHostTool(root.tools, {
        callId: `manage-check-${++callId}`,
        name: 'manage_roles',
        arguments: args,
        agent,
        signal: new AbortController().signal,
      })
      assert.equal(result.isError, false, `runtime management failure ${JSON.stringify(result)}`)
      return result.value
    }
    const set = async (path, value) => {
      await root.settings.mutate('rolesubagents', [{ op: 'set', path: [path], value }], descriptor().revision)
      for (let index = 0; index < 10; index++) await Promise.resolve()
    }
    const preview = async changes => {
      const result = await call(parent, { action: 'preview', expectedRevision: descriptor().revision, changes })
      assert.equal(result.ok, true, JSON.stringify(result))
      return result
    }
    const save = async changes => {
      const plan = await preview(changes)
      const result = await call(parent, { action: 'apply', planId: plan.planId })
      assert.equal(result.ok, true, JSON.stringify(result))
      return result
    }
    const refresh = async (agent = parent) => {
      const current = await call(agent, { action: 'list' })
      return call(agent, {
        action: 'apply_current',
        expectedRevision: current.revision,
        expectedSessionRevision: current.currentSession.revision,
      })
    }
    const catalog = agent => definition(agent, 'delegate').parameters.properties.role.enum
    const runtimeContext = agent => contexts.map(provider => provider.text({ agent })).join('\n')
    return {
      root,
      parent,
      entry,
      pluginContext,
      descriptor,
      definition,
      call,
      set,
      preview,
      save,
      refresh,
      catalog,
      runtimeContext,
      snapshot: agent => structuredClone(tables.get('rolesubagents/snapshots')?.get(agent.session.id)?.settings),
      agents,
      makeAgent,
      starts,
      setChildScopeInheritance(value) {
        inheritChildScope = value
      },
      metadata,
      warnings,
      mounts: () => mounts,
      hold() {
        assert.equal(barrier, undefined)
        barrier = { entered: deferred(), release: deferred() }
        return barrier
      },
      async dispose() {
        for (const { scope, agent, binding } of scopes.reverse()) {
          await root.serial('agent/disposed', { agent })
          binding?.dispose?.()
          await scope.dispose()
        }
        await root.fiber.dispose()
        assert.equal(metadata.inference, 0, 'every fixture must complete without inference')
      },
    }
  }

  function rawReader(host, onSettingsRead = () => {}) {
    const namespace = ownManagementNamespace(host.pluginContext)
    return managementSettings({
      settings: () => {
        onSettingsRead()
        return host.root.settings
      },
      namespace,
      rawConfig: ownManagementRawConfig(host.pluginContext, namespace),
    })
  }
  async function sourceWriteSafety(host, expectedRevision) {
    const service = host.root.get('rolesubagentsManagement')
    assert.equal(
      typeof service?.writeSafety,
      'function',
      'source Typert Remote service must mount (invoked locally, no wire server)',
    )
    return service.writeSafety({ expectedRevision })
  }
  function uiController(host) {
    const snapshot = () => {
      const current = host.descriptor()
      return { status: 'ready', value: current.value, writable: true, revision: current.revision }
    }
    let accepted = snapshot()
    let writes = 0
    let safetyCalls = 0
    const listeners = new Set()
    const controller = createController({
      locale: 'en',
      remote: undefined,
      form: {
        getSnapshot: () => accepted,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        async mutate(ops, expectedRevision) {
          writes++
          await host.root.settings.mutate('rolesubagents', ops, expectedRevision)
          accepted = snapshot()
          for (const listener of listeners) listener()
          return true
        },
      },
      roleWriteSafety: async expectedRevision => {
        safetyCalls++
        return { ok: true, value: await sourceWriteSafety(host, expectedRevision) }
      },
    })
    return { controller, writes: () => writes, safetyCalls: () => safetyCalls }
  }
  async function replaceFixtureConfig(config) {
    await live.dispose()
    live = undefined
    await writeFile(
      patchPath,
      JSON.stringify([{ insert: [{ id: 'rolesubagents', name: 'cordis:role-management-fixture', config }] }], null, 2),
    )
    live = await fixture('expression-safety-root')
  }

  live = await fixture()
  console.log(
    'SCOPE: actual installed Loader/Include/settings/ConfigEditor/file lock/atomic profile write/ToolRuntime/scopes; fixture agents, child backend, KV acknowledgement and LLM metadata only.',
  )
  assert.equal(ownManagementNamespace(live.pluginContext)(), 'rolesubagents')
  assert.equal(live.pluginContext.fiber.entry, live.entry)
  assert.equal(live.entry.options.id, 'rolesubagents')
  assert.equal(live.definition(live.parent, 'manage_roles'), undefined)
  pass('real Loader owner entry resolves standard namespace; management starts OFF')
  const literalReader = rawReader(live)
  const initialRevision = live.descriptor().revision
  const literalSafety = { safe: true, revision: initialRevision, reason: 'literal-role-settings' }
  assert.deepEqual(literalReader.writeSafety(initialRevision), literalSafety)
  assert.deepEqual(await sourceWriteSafety(live, initialRevision), literalSafety)
  assert.equal(live.definition(live.parent, 'manage_roles'), undefined)
  const literalUi = uiController(live)
  const literalWorker = literalUi.controller.getSnapshot().draft.rows.find(row => row.role.id === 'worker')
  literalUi.controller.patchRole(literalWorker.uid, { description: 'SAFE_LITERAL_UI_UPDATE' })
  await literalUi.controller.save()
  assert.equal(literalUi.controller.getSnapshot().save, 'saved')
  assert.equal(literalUi.writes(), 1)
  assert.equal(literalUi.safetyCalls(), 1)
  assert.equal(live.descriptor().value.roles.find(role => role.id === 'worker').description, 'SAFE_LITERAL_UI_UPDATE')
  assert.equal(live.descriptor().value.allowAiRoleManagement, false)
  literalUi.controller.dispose()
  pass('Gate-OFF literal safety uses real raw owner + local source Remote and permits guarded UI persistence')
  await live.set('allowAiRoleManagement', true)
  const manager = live.definition(live.parent, 'manage_roles')
  assert(manager)
  assert.equal((await live.call(live.parent, { action: 'list' })).ok, true)
  assert.equal(live.mounts(), 1)
  pass('canonical settings ON exposes management without reloading source plugin')

  const helpProfile = await readFile(patchPath, 'utf8')
  const helpRevision = live.descriptor().revision
  const helpMetadata = { ...live.metadata }
  const helpAgents = live.agents.length
  const help = await live.call(live.parent, { action: 'help' })
  assert.equal(help.ok, true)
  assert.equal(help.kind, 'help')
  assert.equal(typeof help.promptFields['role.description'], 'string')
  assert.equal(typeof help.promptFields['delegate.prompt'], 'string')
  assert.equal(help.examples.create.action, 'preview')
  assert.equal(help.examples.delegate.role, 'code_reviewer')
  assert.equal(live.descriptor().revision, helpRevision)
  assert.equal(await readFile(patchPath, 'utf8'), helpProfile)
  assert.deepEqual(live.metadata, helpMetadata)
  assert.equal(live.agents.length, helpAgents)
  pass('real ToolRuntime help returns prompt guidance without profile writes, metadata lookup or child launch')

  const modelList = await live.call(live.parent, { action: 'models', target: 'dsh' })
  assert.equal(modelList.ok, true)
  assert.equal(live.metadata.models, 0)
  const providerModels = await live.call(live.parent, { action: 'models', target: 'dsh', provider: 'fixture-provider' })
  assert.equal(providerModels.ok, true)
  assert.equal(live.metadata.models, 1)
  assert.equal(live.metadata.inference, 0)
  pass('real scoped tool uses only stub registry metadata, no inference or CLI')

  const oldDelegate = live.definition(live.parent, 'delegate')
  const oldEnum = [...live.catalog(live.parent)]
  await oldDelegate.execute(
    { role: 'worker', description: 'fixture child', prompt: 'No inference' },
    { agent: live.parent, signal: new AbortController().signal },
  )
  const child = live.agents.at(-1)
  const childEnum = [...live.catalog(child)]
  const childContext = live.runtimeContext(child)
  assert.equal(live.definition(child, 'manage_roles'), undefined)
  assert.equal(
    (await manager.execute({ action: 'list' }, { agent: child, signal: new AbortController().signal })).ok,
    false,
  )
  await assert.rejects(
    oldDelegate.execute(
      { role: 'worker', description: 'forged caller', prompt: 'No inference' },
      { agent: child, signal: new AbortController().signal },
    ),
    /catalog|calling agent|refreshed/,
  )
  pass('actual inherited tool scopes hide child manager and direct captured calls cannot bypass caller guard')
  for (const inherited of [false, true]) {
    live.setChildScopeInheritance(inherited)
    const warningsBefore = live.warnings.length
    await live
      .definition(live.parent, 'delegate')
      .execute(
        { role: 'reviewer', description: 'strict read-only child', prompt: 'No inference' },
        { agent: live.parent, signal: new AbortController().signal },
      )
    const strictChild = live.agents.at(-1)
    assert.equal(strictChild.session.mode, 'read-only')
    assert.equal(live.definition(strictChild, 'manage_roles'), undefined)
    if (!inherited) {
      assert.throws(
        () => strictChild.ctx.tools.restrict({ deny: ['manage_roles'] }),
        /names unknown global tool "manage_roles"/,
      )
    }
    assert(live.definition(strictChild, 'delegate'))
    assert.match(live.runtimeContext(strictChild), /read.only/i)
    assert.equal(live.warnings.length, warningsBefore)
    assert.equal(
      (
        await manager.execute(
          { action: 'list' },
          {
            agent: strictChild,
            signal: new AbortController().signal,
          },
        )
      ).ok,
      false,
    )
    assert.throws(() => strictChild.ctx.tools.restrict({ deny: ['missing_management_fixture'] }), /unknown global tool/)
    pass(
      `actual ToolRuntime strict read-only child activates with inherited scope=${inherited}; management hidden and unknown names rejected`,
    )
  }
  live.setChildScopeInheritance(true)
  const otherRoot = live.makeAgent('other-existing-root', { origin: 'web', delegationDepth: 0 })
  await live.root.serial('agent/created', { agent: otherRoot, source: 'startup' })
  const otherEnum = [...live.catalog(otherRoot)]

  const created = {
    op: 'create',
    role: { id: 'catalog_worker', description: 'Fixture-created worker', instructions: 'NEW_ROLE_INSTRUCTIONS' },
  }
  await live.save([
    created,
    { op: 'update', id: 'worker', patch: { instructions: 'UPDATED_WORKER_INSTRUCTIONS' } },
    { op: 'delete', id: 'reviewer' },
  ])
  assert.deepEqual(live.catalog(live.parent), oldEnum)
  assert(live.descriptor().value.roles.some(role => role.id === 'catalog_worker'))
  assert.equal(
    live.descriptor().value.fixtureUnrelated,
    undefined,
    'ordinary field is not exposed as volatile form data',
  )
  const persisted = await readFile(patchPath, 'utf8')
  assert.match(persisted, /catalog_worker/)
  assert.match(persisted, /fixtureUnrelated: KEEP/)
  assert.equal((await stat(patchPath)).mode & 0o777, 0o600)
  pass('CRUD uses real atomic0600 profile persistence and does not silently refresh current delegate')
  const previousSnapshot = live.snapshot(live.parent)
  await live.set('workflowModel', { provider: 'future-workflow', model: 'future-model' })
  const updated = await live.refresh()
  assert.equal(updated.ok, true, JSON.stringify(updated))
  assert.equal(updated.currentApplied, true)
  assert.deepEqual(live.snapshot(live.parent).workflowModel, previousSnapshot.workflowModel)
  assert.equal(live.snapshot(live.parent).enabled, previousSnapshot.enabled)
  assert(live.catalog(live.parent).includes('catalog_worker'))
  assert(!live.catalog(live.parent).includes('reviewer'))
  assert.deepEqual(live.catalog(child), childEnum)
  assert.deepEqual(live.catalog(otherRoot), otherEnum)
  assert.equal(live.runtimeContext(child), childContext)
  await assert.rejects(
    oldDelegate.execute(
      { role: 'worker', description: 'stale tool', prompt: 'No inference' },
      { agent: live.parent, signal: new AbortController().signal },
    ),
    /catalog|refreshed/,
  )
  await live
    .definition(live.parent, 'delegate')
    .execute(
      { role: 'worker', description: 'new child', prompt: 'No inference' },
      { agent: live.parent, signal: new AbortController().signal },
    )
  assert.match(live.runtimeContext(live.agents.at(-1)), /UPDATED_WORKER_INSTRUCTIONS/)
  assert(live.catalog(live.agents.at(-1)).includes('catalog_worker'))
  const newRoleExecution = await executeHostTool(live.root.tools, {
    callId: 'delegate-new-role',
    name: 'delegate',
    arguments: { role: 'catalog_worker', description: 'new role task', prompt: 'No inference' },
    agent: live.parent,
    signal: new AbortController().signal,
  })
  assert.equal(newRoleExecution.isError, false, JSON.stringify(newRoleExecution))
  assert.match(live.runtimeContext(live.agents.at(-1)), /NEW_ROLE_INSTRUCTIONS/)
  pass('explicit current refresh changes new enum, revokes old capture and leaves admitted children unchanged')

  const offPlan = await live.preview([
    { op: 'create', role: { id: 'off_race', description: 'Must not commit after OFF' } },
  ])
  const offBarrier = live.hold()
  const pendingOffRace = live.call(live.parent, { action: 'apply', planId: offPlan.planId })
  await offBarrier.entered.promise
  await live.set('allowAiRoleManagement', false)
  offBarrier.release.resolve()
  const offRace = await pendingOffRace
  assert.equal(offRace.ok, false)
  assert.equal(offRace.code, 'revision-conflict')
  assert(!live.descriptor().value.roles.some(role => role.id === 'off_race'))
  assert.equal(live.definition(live.parent, 'manage_roles'), undefined)
  assert.equal(
    (await manager.execute({ action: 'list' }, { agent: live.parent, signal: new AbortController().signal })).ok,
    false,
  )
  assert.equal(live.mounts(), 1)
  pass('OFF wins actual locked CAS after writer admission; stale manager cannot commit or execute')

  await live.set('allowAiRoleManagement', true)
  const uiPlan = await live.preview([{ op: 'create', role: { id: 'ui_race', description: 'Must not overwrite UI' } }])
  const uiBarrier = live.hold()
  const pendingUiRace = live.call(live.parent, { action: 'apply', planId: uiPlan.planId })
  await uiBarrier.entered.promise
  const uiRoles = structuredClone(live.descriptor().value.roles)
  uiRoles.find(role => role.id === 'worker').description = 'UI_WINS_CONFLICT'
  await live.set('roles', uiRoles)
  uiBarrier.release.resolve()
  const uiRace = await pendingUiRace
  assert.equal(uiRace.ok, false)
  assert.equal(uiRace.code, 'revision-conflict')
  assert.equal(live.descriptor().value.roles.find(role => role.id === 'worker').description, 'UI_WINS_CONFLICT')
  assert(!live.descriptor().value.roles.some(role => role.id === 'ui_race'))
  pass('actual profile CAS preserves concurrent UI edit rather than retrying or overwriting')

  const first = await live.preview([{ op: 'create', role: { id: 'same_rev_a', description: 'First contender' } }])
  const second = await live.preview([{ op: 'create', role: { id: 'same_rev_b', description: 'Second contender' } }])
  const simultaneous = await Promise.all([
    live.call(live.parent, { action: 'apply', planId: first.planId }),
    live.call(live.parent, { action: 'apply', planId: second.planId }),
  ])
  assert.equal(simultaneous.filter(result => result.ok).length, 1)
  assert.equal(simultaneous.filter(result => result.code === 'revision-conflict').length, 1)
  assert.equal(live.descriptor().value.roles.filter(role => ['same_rev_a', 'same_rev_b'].includes(role.id)).length, 1)
  pass('two AI plans at the same real revision admit exactly one atomic profile change')

  const readonly = live.makeAgent('readonly-root', { origin: 'web', delegationDepth: 0 })
  readonly.session.mode = 'read-only'
  await live.root.serial('agent/created', { agent: readonly, source: 'startup' })
  const denied = await live.call(readonly, {
    action: 'preview',
    expectedRevision: live.descriptor().revision,
    changes: [{ op: 'create', role: { id: 'forbidden', description: 'No write' } }],
  })
  assert.equal(denied.code, 'read-only-caller')
  const userFork = live.makeAgent('user-fork', {
    origin: 'fork',
    parentSession: live.parent.session.id,
    delegationDepth: 0,
  })
  await live.root.serial('agent/created', { agent: userFork, source: 'fork' })
  assert.equal((await live.call(userFork, { action: 'list' })).ok, true)
  pass('real scoped runtime rejects read-only writes but permits user fork lineage at depth zero')

  const savedIds = live.descriptor().value.roles.map(role => role.id)
  const beforeReopen = await readFile(patchPath, 'utf8')
  await live.dispose()
  live = undefined
  live = await fixture('fresh-root-after-profile-reopen')
  assert.deepEqual(
    live.descriptor().value.roles.map(role => role.id),
    savedIds,
  )
  assert.equal(await readFile(patchPath, 'utf8'), beforeReopen)
  assert(live.catalog(live.parent).includes('catalog_worker'))
  assert.equal(live.metadata.inference, 0)
  pass('fresh real Loader/profile open recovers saved roles and starts a new root catalog')
  assert.throws(
    () => literalReader.read(),
    error => error?.code === 'settings-unavailable',
  )
  pass('old owner-bound reader cannot address a fresh Loader instance with the same namespace')

  function expressionConfig(kind, allowed) {
    const marker = `SYNTHETIC_${kind.toUpperCase()}_RESOLVED`
    const roles = structuredClone(DEFAULT_ROLES)
    const worker = roles.find(role => role.id === 'worker')
    worker.instructions = marker
    const config = {
      enabled: true,
      allowAiRoleManagement: allowed,
      roles,
      workflowModel: null,
      clis: {},
      fixtureUnrelated: 'KEEP',
    }
    if (kind === 'opaque') worker.futureOpaque = { __jsExpr: JSON.stringify(marker) }
    if (kind === 'roles-root') config.roles = { __jsExpr: JSON.stringify(roles) }
    return { marker, config: kind === 'config-root' ? { __jsExpr: `(${JSON.stringify(config)})` } : config }
  }
  for (const kind of ['opaque', 'roles-root', 'config-root']) {
    const off = expressionConfig(kind, false)
    await replaceFixtureConfig(off.config)
    const raw = live.entry.options.config
    const described = live.descriptor()
    assert(Array.isArray(described.value.roles), 'SDK must expose evaluated literal role arrays')
    assert.equal(described.value.roles.find(role => role.id === 'worker').instructions, off.marker)
    assert(JSON.stringify(raw).includes('__jsExpr'), 'own raw Loader config must retain executable syntax')
    assert(
      !JSON.stringify(described.value).includes('__jsExpr'),
      'SDK volatile descriptor must hide raw executable syntax in this fixture',
    )
    let sdkReads = 0
    const offReader = rawReader(live, () => sdkReads++)
    const before = await readFile(patchPath, 'utf8')
    const unsafe = { safe: false, reason: 'expression-backed-role-settings' }
    assert.deepEqual(offReader.writeSafety(described.revision), unsafe)
    assert.equal(sdkReads, 0, 'syntax rejection must precede SDK projection of settings')
    assert.deepEqual(await sourceWriteSafety(live, described.revision), unsafe)
    assert.equal(live.definition(live.parent, 'manage_roles'), undefined)
    const ui = uiController(live)
    const worker = ui.controller.getSnapshot().draft.rows.find(row => row.role.id === 'worker')
    ui.controller.patchRole(worker.uid, { description: 'KEEP_UNSAVED_UI_INPUT' })
    assert.equal(ui.controller.getSnapshot().canSave, true, 'resolved SDK values alone cannot detect raw expressions')
    await ui.controller.save()
    assert.equal(ui.controller.getSnapshot().save, 'failed')
    assert.equal(ui.controller.getSnapshot().saveIssue, 'expression-backed-role-settings')
    assert.equal(ui.controller.getSnapshot().dirty, true)
    assert.equal(
      ui.controller.getSnapshot().draft.rows.find(row => row.role.id === 'worker').role.description,
      'KEEP_UNSAVED_UI_INPUT',
    )
    assert.equal(ui.safetyCalls(), 1)
    assert.equal(ui.writes(), 0, 'whole-array UI mutation must never reach the real settings API')
    assert.equal(
      await readFile(patchPath, 'utf8'),
      before,
      'read-only safety checks must not materialize expressions as literals',
    )
    assert(!JSON.stringify(unsafe).includes(off.marker))
    ui.controller.dispose()
    pass(
      `Gate-OFF ${kind} raw/resolved mismatch is rejected by local Remote + actual UI controller without writes or source disclosure`,
    )

    const on = expressionConfig(kind, true)
    await replaceFixtureConfig(on.config)
    const onReader = rawReader(live)
    const state = onReader.read()
    assert.equal(state.allowed, true)
    assert.equal(state.literalRolesSupported, false)
    const unchanged = await readFile(patchPath, 'utf8')
    const denied = await live.call(live.parent, {
      action: 'preview',
      expectedRevision: state.revision,
      changes: [{ op: 'create', role: { id: 'no_expression_write', description: 'Must remain unapplied' } }],
    })
    assert.equal(denied.ok, false)
    assert.equal(denied.code, 'expression-backed-role-settings')
    await assert.rejects(
      onReader.writeRoles(state, structuredClone(DEFAULT_ROLES)),
      error => error?.code === 'expression-backed-role-settings',
    )
    assert.equal(await readFile(patchPath, 'utf8'), unchanged)
    assert.equal(live.metadata.inference, 0)
    pass(`Gate-ON ${kind} blocks AI mutation and canonical role writer without materializing evaluated values`)
  }
  // A real profile bundle contributes the expression, while the writable user patch contains no role values.
  await live.dispose()
  live = undefined
  const bundleName = 'role-management-inherited-fixture'
  const bundleDir = join(profile, 'node_modules', bundleName)
  await mkdir(bundleDir, { recursive: true })
  await writeFile(
    join(bundleDir, 'package.json'),
    JSON.stringify({ name: bundleName, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  )
  const inherited = expressionConfig('opaque', true)
  const bundlePatch = join(bundleDir, 'cordis.patch.yml')
  const inheritedBytes = JSON.stringify(
    [{ insert: [{ id: 'rolesubagents', name: 'cordis:role-management-fixture', config: inherited.config }] }],
    null,
    2,
  )
  await writeFile(bundlePatch, inheritedBytes)
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({
      name: 'role-management-host-fixture',
      private: true,
      type: 'module',
      dsh: { profile: { bundles: [bundleName] } },
    }),
  )
  await writeFile(patchPath, '[]\n')
  live = await fixture('bundle-inherited-safety-root')
  const inheritedDescriptor = live.descriptor()
  const inheritedLayer = live.root.configEditor.configuration().find(row => row.entry === live.entry).inherited
  assert(JSON.stringify(inheritedLayer).includes('__jsExpr'))
  assert.equal(inheritedDescriptor.value.roles.find(role => role.id === 'worker').futureOpaque, inherited.marker)
  assert(!JSON.stringify(inheritedDescriptor.value).includes('__jsExpr'))
  assert.deepEqual(await sourceWriteSafety(live, inheritedDescriptor.revision), {
    safe: false,
    reason: 'expression-backed-role-settings',
  })
  const inheritedUi = uiController(live)
  const inheritedWorker = inheritedUi.controller.getSnapshot().draft.rows.find(row => row.role.id === 'worker')
  inheritedUi.controller.patchRole(inheritedWorker.uid, { description: 'DO_NOT_MATERIALIZE_INHERITED_SOURCE' })
  await inheritedUi.controller.save()
  assert.equal(inheritedUi.writes(), 0)
  assert.equal(inheritedUi.controller.getSnapshot().saveIssue, 'expression-backed-role-settings')
  inheritedUi.controller.dispose()
  const inheritedDenied = await live.call(live.parent, {
    action: 'preview',
    expectedRevision: inheritedDescriptor.revision,
    changes: [{ op: 'create', role: { id: 'no_inherited_write', description: 'Must not persist' } }],
  })
  assert.equal(inheritedDenied.code, 'expression-backed-role-settings')
  assert.equal(await readFile(patchPath, 'utf8'), '[]\n')
  assert.equal(await readFile(bundlePatch, 'utf8'), inheritedBytes)
  pass(
    'real bundle-inherited opaque expression is detected despite a literal empty user patch; UI and AI leave both layers unchanged',
  )
  const metadataTotals = fixtureRuns.reduce(
    (total, run) => ({
      providers: total.providers + run.metadata.providers,
      models: total.models + run.metadata.models,
      info: total.info + run.metadata.info,
      inference: total.inference + run.metadata.inference,
      fixtureChildActivations: total.fixtureChildActivations + run.starts.length,
    }),
    { providers: 0, models: 0, info: 0, inference: 0, fixtureChildActivations: 0 },
  )
  console.log(
    `REPORT ${JSON.stringify({ schemaVersion: 1, recordedAt: new Date().toISOString(), runtime: { dsh: manifest.version, node: process.versions.node, platform: process.platform, arch: process.arch }, passes, metadata: metadataTotals, syntaxCases: ['opaque', 'roles-root', 'config-root', 'bundle-inherited-opaque'], scope: 'real Loader/settings/configEditor/fileLock/atomicProfile/ToolRuntime/scopes; local source Remote and actual UI controller', fixtures: ['agents', 'child-backend', 'in-memory-KV-ack', 'LLM-metadata', 'HMR-scheduling-barrier', 'UI-form-transport-adapter'], notVerified: ['network-RPC-transport', 'KV-disk-durability', 'live-model-backend', 'CLI-file-enforcement', 'production-deployment'] })}`,
  )
  console.log(
    `Completed ${passes} installed-Host management checks; no network/server/CLI/inference/installed profile changes.`,
  )
} finally {
  await live?.dispose()
  hook.deregister()
  isolated.dispose()
}
