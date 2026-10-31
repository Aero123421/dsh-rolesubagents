import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { probeCli } from '../src/host/external/probe.ts'
import {
  createProbeServiceClass,
  type MethodDecoratorContextLike,
  mountProbeService,
  PROBE_SERVICE_NAME,
  type TypertModule,
} from '../src/host/external/probe-service.ts'
import { CLI_ADAPTERS } from '../src/host/external/registry.ts'
import type { CliAdapter } from '../src/host/external/types.ts'
import { apply } from '../src/host/index.ts'
import type { DomainPort, HostContext } from '../src/host/ports.ts'
import { EXTERNAL_ROLES_NOTE, toolDescription } from '../src/host/tool.ts'
import { CODEX } from '../src/shared/cli/codex.ts'
import { type RoleDefinition, roleContextText } from '../src/shared/roles.ts'
import { type FakeSubprocessOptions, fakeSubprocess, line, testAdapter } from './external-fakes.ts'
import { builtinRole, execContext, fakeWorld, registeredTool, role } from './host-fakes.ts'

vi.mock('@deepseek-ai/dsh-tools', () => import('./host-fakes.ts').then(module => module.toolsModule()))
vi.mock('@deepseek-ai/dsh-storage-domain', () => import('./host-fakes.ts').then(m => m.storageDomainModule()))

const GENERAL = builtinRole('general')
const FORK = builtinRole('fork')
const WORKER = role('worker')
const CODER = role('coder', {
  description: 'Codes in Codex.',
  instructions: 'Write tests.',
  runner: { cli: 'codex', permission: 'danger-full-access', model: 'gpt-6-sol' },
})
const SCOUT = role('scout', {
  description: 'Reads in Codex.',
  readOnly: true,
  runner: { cli: 'codex', permission: 'read-only' },
})
const READER = role('reader', { description: 'DSH reader.', readOnly: true })
const ROLES = [GENERAL, FORK, WORKER, CODER, SCOUT, READER]
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'rolesubagents-delegate-'))
  mkdirSync(join(root, 'ws', 'sub'), { recursive: true })
  mkdirSync(join(root, 'elsewhere'))
  return root
}

interface BootOptions {
  readonly roles?: RoleDefinition[]
  readonly adapter?: CliAdapter
  readonly mode?: string
  readonly clis?: unknown
  readonly onRun?: FakeSubprocessOptions['onRun']
  readonly beforeRolePut?: () => Promise<void>
}

async function boot(options: BootOptions = {}) {
  const root = workspace()
  const ws = join(root, 'ws')
  const world = fakeWorld()
  if (options.beforeRolePut) {
    const storage = world.services.storageDomain!
    world.services.storageDomain = {
      async open(spec) {
        const domain = await storage.open(spec)
        return {
          ...domain,
          table(name) {
            const table = domain.table(name)
            return {
              ...table,
              async put(key, value) {
                if (name === 'roles') await options.beforeRolePut!()
                await table.put(key, value)
              },
            }
          },
        }
      },
    }
  }
  const subprocess = fakeSubprocess({
    onRun:
      options.onRun ??
      (async p => {
        await p.stdinClosed
        p.stdout(line({ type: 'text', text: 'external answer' }))
        p.stdout(line({ type: 'done' }))
        p.exit(0)
      }),
  })
  world.services.subprocess = subprocess
  world.services.sandboxPolicy = {
    resolve: vi.fn(() => ({ mode: options.mode ?? 'danger-full-access', workspaceRoot: ws })),
  }
  const adapter = options.adapter ?? testAdapter()
  apply(
    world.ctx,
    { roles: options.roles ?? ROLES, ...(options.clis === undefined ? {} : { clis: options.clis }) },
    { adapters: () => adapter },
  )
  const parent = world.newAgent('parent')
  await world.emitCreated(parent)
  const call = (args: Record<string, unknown>, signal?: AbortSignal) =>
    registeredTool(parent).execute(
      { description: 'do it', prompt: 'the task', cwd: ws, ...args },
      execContext(parent, signal),
    )
  return { world, parent, subprocess, adapter, root, ws, call }
}

describe('delegate: external roles', () => {
  it('still closes Session role storage if external history closing fails', async () => {
    const world = fakeWorld()
    const facility = world.services.storageDomain!
    const closed: string[] = []
    world.services.storageDomain = {
      async open(spec) {
        const domain = await facility.open(spec)
        const name = (spec as { name: string }).name
        return {
          ...domain,
          close: async () => {
            closed.push(name)
            if (name === 'rolesubagents_external_runs') throw new Error('close failed')
            await domain.close()
          },
        }
      },
    }
    apply(world.ctx, { roles: ROLES })
    await world.settle()
    await world.teardown()
    expect(closed).toContain('rolesubagents_external_runs')
    expect(closed).toContain('rolesubagents')
    expect(world.ctx.logger.warn).toHaveBeenCalledWith('rolesubagents: could not close external run history storage')
    expect(world.ctx.logger.warn).not.toHaveBeenCalledWith('rolesubagents: could not close Session role storage')
  })
  it('mentions external roles in the tool description only when one is selectable', () => {
    expect(toolDescription([GENERAL, WORKER])).not.toContain(EXTERNAL_ROLES_NOTE)
    const text = toolDescription([GENERAL, CODER])
    expect(text.split('\n')).toHaveLength(5)
    expect(text.split('\n').at(-1)?.endsWith(` ${EXTERNAL_ROLES_NOTE}`)).toBe(true)
    expect(text).toContain('- coder: Codes in Codex. (runs once in Codex; cannot receive send_message)')
  })

  it('starts through a one-off provider without DSH-only start options and removes it again', async () => {
    const { world, call, adapter, ws, subprocess } = await boot()
    const value = (await call({ role: 'coder' })) as { kind: string; subagentId: string }
    expect(value).toEqual({ kind: 'activation', subagentId: expect.stringMatching(new RegExp(`^${UUID}$`)) })
    const spec = world.subagents.startActivation.mock.calls[0]?.[0]
    expect(spec?.provider).toMatch(new RegExp(`^rolesubagents:codex:coder:${UUID}$`))
    expect(spec).toMatchObject({ label: 'do it', delivery: 'parent' })
    expect(spec).not.toHaveProperty('childId')
    expect(Object.keys(spec?.request ?? {}).sort()).toEqual(['cwd', 'parent', 'prompt'])
    expect(spec?.request.prompt).toEqual([{ type: 'text', text: 'the task' }])
    expect(world.subagents.registerProvider).toHaveBeenCalledTimes(1)
    const provider = world.subagents.registerProvider.mock.calls[0]?.[0]
    expect(provider).toMatchObject({
      capabilities: { agentOptions: false, agentPreset: false, outputSchema: false, depthLimit: false },
      inheritsParentContext: false,
    })
    expect(world.externalProviders.size).toBe(0)
    // No DSH child is reserved or created.
    expect(world.children).toEqual([])
    expect(world.subagents.getProvider).not.toHaveBeenCalled()
    expect(world.services.llm?.resolveCallConfig).not.toHaveBeenCalled()
    const [planInput] = (adapter as ReturnType<typeof testAdapter>).inputs
    expect(planInput).toEqual({
      runner: CODER.runner,
      preset: 'danger-full-access',
      access: 'full-access',
      instructions: roleContextText(CODER),
      task: 'the task',
      cwd: ws,
    })
    expect(await world.externalRuns[0]?.result).toEqual({
      output: [{ type: 'text', text: 'external answer' }],
      stopReason: 'completed',
    })
    expect(subprocess.processes).toHaveLength(1)
    await world.settle()
    expect(world.storage.data.get('rolesubagents_external_runs')?.get('history')?.get('recent')).toMatchObject({
      version: 1,
      entries: [
        {
          id: value.subagentId,
          parentSessionId: 'session-parent',
          roleId: 'coder',
          cli: 'codex',
          model: 'gpt-6-sol',
          status: 'succeeded',
          resultText: 'external answer',
          resultTruncated: false,
        },
      ],
    })
    await world.teardown()
  })

  it('records the selected external role under the returned activation id, never a CLI thread id', async () => {
    const { world, call } = await boot()
    const start = world.subagents.startActivation.getMockImplementation()!
    world.subagents.startActivation.mockImplementationOnce(async spec => {
      await start(spec)
      return { childId: 'host-activation-id' }
    })
    expect(await call({ role: 'coder' })).toEqual({ kind: 'activation', subagentId: 'host-activation-id' })
    await world.settle()
    expect(world.storedRole('host-activation-id')).toEqual({ version: 1, role: CODER })
    expect(world.storedRole('cli-thread-id')).toBeUndefined()
    expect(world.storedRole(world.externalRuns[0]!.id)).toBeUndefined()
    expect(world.storedSnapshot('host-activation-id')).toBeUndefined()
    await world.teardown()
  })

  it('returns an already-started activation without waiting for role storage and lifetime handoff', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const { world, call } = await boot({ beforeRolePut: () => blocked })
    const result = (await call({ role: 'coder' })) as { subagentId: string }
    expect(world.externalRuns).toHaveLength(1)
    expect(world.storedRole(result.subagentId)).toBeUndefined()
    release()
    await world.settle()
    expect(world.storedRole(result.subagentId)).toEqual({ version: 1, role: CODER })
    await world.teardown()
  })

  it('does not report failed delegation when post-start persistence fails', async () => {
    const { world, call } = await boot({
      beforeRolePut: async () => {
        throw new Error('write failed')
      },
    })
    await expect(call({ role: 'coder' })).resolves.toMatchObject({ kind: 'activation' })
    await world.settle()
    expect(world.externalRuns).toHaveLength(1)
    expect(world.logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not persist roles state'))
    await world.teardown()
  })

  it('keeps the owner liveness fence immediately before an external start', async () => {
    const { world, parent, call, ws } = await boot()
    world.services.sandboxPolicy = {
      resolve: () => {
        world.emitDisposed(parent)
        return { mode: 'danger-full-access', workspaceRoot: ws }
      },
    }
    await expect(call({ role: 'coder' })).rejects.toThrow(/aborted|no longer active/)
    expect(world.subagents.startActivation).not.toHaveBeenCalled()
    expect(world.subagents.registerProvider).not.toHaveBeenCalled()
    await world.teardown()
  })

  it('records an already-started activation even if its caller was disposed during handoff', async () => {
    const { world, parent, call } = await boot()
    const start = world.subagents.startActivation.getMockImplementation()!
    world.subagents.startActivation.mockImplementationOnce(async spec => {
      const result = await start(spec)
      world.emitDisposed(parent)
      return result
    })
    const result = (await call({ role: 'coder' })) as { subagentId: string }
    await world.settle()
    expect(world.storedRole(result.subagentId)).toEqual({ version: 1, role: CODER })
    await world.teardown()
  })

  it('does not undo a started activation if state closes before post-start recording', async () => {
    const { world, call } = await boot()
    const start = world.subagents.startActivation.getMockImplementation()!
    world.subagents.startActivation.mockImplementationOnce(async spec => {
      const result = await start(spec)
      await world.teardown()
      return result
    })
    await expect(call({ role: 'coder' })).resolves.toMatchObject({ kind: 'activation' })
    expect(world.externalRuns).toHaveLength(1)
    expect(world.logger.warn).toHaveBeenCalledWith('rolesubagents: could not record the started external child role')
  })

  it('renders the CLI name in the start line', async () => {
    const { parent } = await boot()
    const tool = registeredTool(parent)
    const render = tool.output?.render as (args: unknown, value: { subagentId: string }) => { text: string }[]
    const receipt = render({ role: 'coder' }, { subagentId: 'id-1' })[0]?.text
    expect(receipt).toMatch(/^started Codex subagent id-1\n/)
    expect(receipt).toContain('start receipt, not a completion result')
    expect(receipt).toContain('final result will return to this parent conversation')
    expect(receipt).toContain('External CLI runs do not accept follow-up messages')
    expect(render({ role: 'worker' }, { subagentId: 'id-2' })[0]?.text).toBe('started subagent id-2')
  })

  it.each([
    ['read-only', 'read-only', 'read-only'],
    ['workspace-write', 'workspace-write', 'workspace-write'],
    ['auto', 'workspace-write', 'workspace-write'],
    ['danger-full-access', 'danger-full-access', 'full-access'],
  ])('lowers the role preset to a %s parent', async (mode, preset, access) => {
    const { call, adapter } = await boot({ mode })
    await call({ role: 'coder' })
    expect((adapter as ReturnType<typeof testAdapter>).inputs[0]).toMatchObject({ preset, access })
  })

  it('keeps a read-only parent read-only: only read-only roles, always the read-only preset', async () => {
    const { world, call, adapter } = await boot()
    // Record the parent as a read-only DSH child by delegating to the read-only DSH role first.
    await call({ role: 'reader' })
    const readOnlyChild = world.children.at(-1)
    if (readOnlyChild === undefined) throw new Error('no child')
    const tool = registeredTool(readOnlyChild)
    const run = (roleId: string) =>
      tool.execute({ description: 'd', prompt: 'p', role: roleId, cwd: join(tmpdir()) }, execContext(readOnlyChild))
    await expect(run('coder')).rejects.toThrow(
      /read-only role: `delegate` was refused \(role "coder" is not read-only\)/,
    )
    world.services.sandboxPolicy = { resolve: () => ({ mode: 'danger-full-access' }) }
    await run('scout')
    expect((adapter as ReturnType<typeof testAdapter>).inputs.at(-1)).toMatchObject({
      preset: 'read-only',
      access: 'read-only',
    })
  })

  it('refuses beyond the delegation depth before registering anything', async () => {
    const { world, parent } = await boot()
    world.subagents.resolveMaxDepth.mockReturnValue(0)
    await expect(
      registeredTool(parent).execute({ description: 'd', prompt: 'p', role: 'coder' }, execContext(parent)),
    ).rejects.toThrow(/delegation depth limit reached \(current 0, maximum 0\)/)
    expect(world.subagents.registerProvider).not.toHaveBeenCalled()
  })

  it('keeps the child inside the parent workspace below full access', async () => {
    const { world, call, root, ws } = await boot({ mode: 'workspace-write' })
    await expect(call({ role: 'coder', cwd: join(root, 'elsewhere') })).rejects.toThrow(
      /outside the parent's workspace/,
    )
    expect(world.externalProviders.size).toBe(0)
    await call({ role: 'coder', cwd: join(ws, 'sub') })
    const full = await boot({ mode: 'danger-full-access' })
    await full.call({ role: 'coder', cwd: join(full.root, 'elsewhere') })
  })

  it.each([
    ['no sandboxPolicy service', undefined],
    ['a throwing sandboxPolicy service', 'throws'],
    ['a policy without a workspace root', 'no-root'],
  ] as const)(
    'refuses an explicit cwd below full access when the workspace root is unknown (%s)',
    async (_name, kind) => {
      const { world, call, ws, adapter, parent } = await boot({ mode: 'workspace-write' })
      if (kind === undefined) delete world.services.sandboxPolicy
      else if (kind === 'throws')
        world.services.sandboxPolicy = {
          resolve: () => {
            throw new Error('boom')
          },
        }
      else world.services.sandboxPolicy = { resolve: () => ({ mode: 'workspace-write' }) }
      await expect(call({ role: 'coder', cwd: join(ws, 'sub') })).rejects.toThrow(
        /a cwd cannot be given here: the parent's workspace is unknown/,
      )
      expect(world.subagents.registerProvider).not.toHaveBeenCalled()
      // Without an explicit cwd, DSH's default (the parent's directory) is kept.
      await registeredTool(parent).execute({ description: 'd', prompt: 'p', role: 'coder' }, execContext(parent))
      expect((adapter as ReturnType<typeof testAdapter>).inputs.at(-1)).toMatchObject({ access: 'workspace-write' })
      // A read-only run may still name a directory.
      await call({ role: 'scout', cwd: join(ws, 'sub') })
      expect((adapter as ReturnType<typeof testAdapter>).inputs.at(-1)).toMatchObject({
        access: 'read-only',
        cwd: join(ws, 'sub'),
      })
    },
  )

  it('keeps an explicit cwd at full access when the policy names no workspace root', async () => {
    const { world, call, root, adapter } = await boot()
    world.services.sandboxPolicy = { resolve: () => ({ mode: 'danger-full-access' }) }
    await call({ role: 'coder', cwd: join(root, 'elsewhere') })
    expect((adapter as ReturnType<typeof testAdapter>).inputs.at(-1)).toMatchObject({ access: 'full-access' })
  })

  it('handles an asynchronous or failing provider disposer without failing the delegation', async () => {
    const cases: [() => unknown, RegExp | undefined][] = [
      [() => Promise.reject(new Error('async removal failed')), /could not remove provider .*: async removal failed/],
      [
        () => {
          throw new Error('sync removal failed')
        },
        /could not remove provider .*: sync removal failed/,
      ],
      [() => Promise.resolve(), undefined],
    ]
    for (const [disposer, warning] of cases) {
      const { world, call } = await boot()
      world.subagents.registerProvider.mockImplementation(provider => {
        world.externalProviders.set(provider.name, provider)
        return disposer
      })
      await expect(call({ role: 'coder' })).resolves.toBeDefined()
      await world.settle()
      const warned = world.logger.warn.mock.calls.map(([text]) => text).filter(t => /could not remove provider/.test(t))
      if (warning === undefined) expect(warned).toEqual([])
      else expect(warned).toEqual([expect.stringMatching(warning)])
    }
  })

  it('reports failing adapters, missing CLIs and a missing subprocess service safely', async () => {
    const failing: CliAdapter = {
      descriptor: CODEX,
      plan() {
        throw new Error('Codex runner is not implemented yet')
      },
      createSession() {
        throw new Error('Codex runner is not implemented yet')
      },
    }
    const stub = await boot({ adapter: failing })
    await expect(stub.call({ role: 'coder' })).rejects.toThrow(/^Codex runner is not implemented yet$/)
    expect(stub.world.externalProviders.size).toBe(0)

    const missing = await boot({ clis: { codex: { executable: '/nowhere/codex' } } })
    missing.world.services.subprocess = fakeSubprocess({ executables: {} })
    await expect(missing.call({ role: 'coder' })).rejects.toThrow(
      /^Codex was not found \(set its path in the plugin settings\)$/,
    )

    const none = await boot()
    delete none.world.services.subprocess
    await expect(none.call({ role: 'coder' })).rejects.toThrow(/subprocess service/)
    // DSH roles keep working without it.
    await none.call({ role: 'worker' })
    expect(none.world.children).toHaveLength(1)
  })

  it('reads the live CLI settings at each delegation', async () => {
    const { call, subprocess } = await boot({ clis: { codex: { executable: '/opt/codex' } } })
    await call({ role: 'coder' })
    expect(subprocess.resolveCalls[0]?.command).toBe('/opt/codex')
  })

  it('disposes live external runs when the plugin unloads', async () => {
    const { world, call } = await boot({ onRun: () => {} })
    await call({ role: 'coder' })
    const run = world.externalRuns[0]
    if (run === undefined) throw new Error('no run')
    world.teardown()
    expect((await run.result).stopReason).toBe('aborted')
  })

  it('never spawns a run that was still starting when the plugin unloaded', async () => {
    const { world, call, subprocess } = await boot({ onRun: () => {} })
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const original = subprocess.resolveExecutable.bind(subprocess)
    subprocess.resolveExecutable = async (command, env, sig) => {
      await gate
      return original(command, env, sig)
    }
    const pending = call({ role: 'coder' })
    await new Promise(resolve => setTimeout(resolve, 10))
    world.teardown()
    release()
    await expect(pending).rejects.toThrow(/unloaded/)
    expect(subprocess.processes).toHaveLength(0)
  })

  it('aborts a run when DSH aborts its signal (interrupt_agent)', async () => {
    const { world, call } = await boot({ onRun: () => {} })
    const controller = new AbortController()
    world.subagents.startActivation.mockImplementationOnce(async spec => {
      const provider = world.externalProviders.get(spec.provider)
      if (provider === undefined) throw new Error('no provider')
      const run = await provider.start({ ...spec.request, cwd: spec.request.cwd ?? '/', signal: controller.signal })
      world.externalRuns.push(run)
      return { childId: run.id }
    })
    await call({ role: 'coder' })
    controller.abort()
    expect((await world.externalRuns[0]?.result)?.stopReason).toBe('aborted')
  })
})

describe('plugin start and unload', () => {
  it('does not touch the context when unloaded before the storage domain opens', async () => {
    const world = fakeWorld()
    let open!: (domain: DomainPort) => void
    world.services.storageDomain = { open: () => new Promise<DomainPort>(resolve => (open = resolve)) }
    const list = vi.fn(() => {
      throw new Error('cannot get required service "agents" in inactive context')
    })
    ;(world.ctx as { agents: HostContext['agents'] }).agents = { list }
    apply(world.ctx, { roles: ROLES })
    world.teardown()
    open({ table: () => ({ get: () => undefined, put: async () => {}, entries: () => [] }), close: async () => {} })
    await world.settle()
    await world.settle()
    expect(list).not.toHaveBeenCalled()
    expect(world.logger.warn).not.toHaveBeenCalled()
  })

  it('logs instead of rejecting when preparing existing agents fails', async () => {
    const world = fakeWorld()
    ;(world.ctx as { agents: HostContext['agents'] }).agents = {
      list: () => {
        throw new Error('agents unavailable')
      },
    }
    apply(world.ctx, { roles: ROLES })
    await world.settle()
    expect(world.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('preparing existing agents failed: agents unavailable'),
    )
  })

  it('runs adapter housekeeping once at start and logs failures', async () => {
    const original = CLI_ADAPTERS.agy.housekeeping
    const housekeeping = vi.fn(async () => {
      throw new Error('sweep failed')
    })
    ;(CLI_ADAPTERS.agy as { housekeeping?: CliAdapter['housekeeping'] }).housekeeping = housekeeping
    try {
      const world = fakeWorld()
      apply(world.ctx, { roles: ROLES })
      await world.settle()
      expect(housekeeping).toHaveBeenCalledTimes(1)
      expect(world.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Antigravity housekeeping failed: sweep failed'),
      )
    } finally {
      ;(CLI_ADAPTERS.agy as { housekeeping?: CliAdapter['housekeeping'] }).housekeeping = original
    }
  })
})

describe('probe', () => {
  const signal = new AbortController().signal

  it('validates the CLI id and reports missing services and executables', async () => {
    const adapters = () => testAdapter()
    await expect(
      probeCli({ cli: 'nope' }, { subprocess: fakeSubprocess(), adapters, settings: undefined }, signal),
    ).rejects.toThrow('unknown CLI')
    await expect(probeCli(null, { subprocess: undefined, adapters, settings: undefined }, signal)).rejects.toThrow()
    expect(await probeCli({ cli: 'codex' }, { subprocess: undefined, adapters, settings: undefined }, signal)).toEqual({
      cli: 'codex',
      found: false,
      message: 'subprocess-unavailable',
    })
    expect(
      await probeCli(
        { cli: 'codex' },
        { subprocess: fakeSubprocess({ executables: {} }), adapters, settings: undefined },
        signal,
      ),
    ).toEqual({ cli: 'codex', found: false, message: 'not-found' })
    expect(
      await probeCli({ cli: 'codex' }, { subprocess: fakeSubprocess(), adapters, settings: undefined }, signal),
    ).toEqual({
      cli: 'codex',
      found: true,
      path: '/bin/codex',
    })
  })

  it('delegates to the adapter probe with a runner, the settings and forwarded variables', async () => {
    const subprocess = fakeSubprocess({ onCollect: () => ({ code: 0, stdout: 'codex-cli 1.2.3\n' }) })
    const probe = vi.fn<NonNullable<CliAdapter['probe']>>(async (_exe, run, sig) => {
      const out = await run(['--version'], { timeoutMs: 1000 }, sig)
      return { cli: 'claude-code', found: false, version: out.stdout.trim(), auth: 'ok' }
    })
    const adapter: CliAdapter = { ...testAdapter(), probe }
    const settings = { codex: { executable: '/opt/codex', envPassthrough: ['KEY'] } }
    const result = await probeCli(
      { cli: 'codex' },
      { subprocess, adapters: () => adapter, settings, hostEnv: { KEY: 'v', HOME: '/home/u' }, cwd: '/w' },
      signal,
    )
    expect(result).toEqual({ cli: 'codex', found: true, path: '/opt/codex', version: 'codex-cli 1.2.3', auth: 'ok' })
    expect(probe.mock.calls[0]?.[0]).toBe('/opt/codex')
    expect(probe.mock.calls[0]?.[3]).toEqual(settings.codex)
    expect(subprocess.collected[0]).toMatchObject({ argv: ['/opt/codex', '--version'], cwd: '/w', env: { KEY: 'v' } })
    // The probe sees only forwarded names that are actually set in the Host environment.
    probe.mockClear()
    const listed = { codex: { envPassthrough: ['CODEX_API_KEY', 'EMPTY', 'KEY'] } }
    await probeCli(
      { cli: 'codex' },
      { subprocess, adapters: () => adapter, settings: listed, hostEnv: { KEY: 'v', EMPTY: '' }, cwd: '/w' },
      signal,
    )
    expect(probe.mock.calls[0]?.[3]).toEqual({ envPassthrough: ['KEY'] })
    const failing: CliAdapter = {
      ...testAdapter(),
      probe: async () => {
        throw new Error('raw output')
      },
    }
    expect(
      await probeCli({ cli: 'codex' }, { subprocess, adapters: () => failing, settings: undefined }, signal),
    ).toEqual({
      cli: 'codex',
      found: true,
      path: '/bin/codex',
      message: 'probe-failed',
    })
  })

  it('Codex: a listed but unset CODEX_API_KEY does not count as signed in', async () => {
    const subprocess = fakeSubprocess({
      onCollect: spec => (spec.argv.includes('login') ? { code: 1, stderr: 'Not logged in\n' } : { code: 1 }),
    })
    const deps = (hostEnv: Record<string, string>) => ({
      subprocess,
      adapters: () => CLI_ADAPTERS.codex,
      settings: { codex: { envPassthrough: ['CODEX_API_KEY'] } },
      hostEnv,
      cwd: '/w',
    })
    expect((await probeCli({ cli: 'codex' }, deps({}), signal)).auth).toBe('missing')
    expect((await probeCli({ cli: 'codex' }, deps({ CODEX_API_KEY: 'sk-x' }), signal)).auth).toBe('ok')
  })

  it('does not start the adapter after cancellation during executable resolution', async () => {
    const controller = new AbortController()
    const subprocess = fakeSubprocess()
    subprocess.resolveExecutable = async () => {
      controller.abort()
      return '/bin/codex'
    }
    const probe = vi.fn<NonNullable<CliAdapter['probe']>>(async () => ({ cli: 'codex', found: true }))
    await expect(
      probeCli(
        { cli: 'codex' },
        { subprocess, adapters: () => ({ ...testAdapter(), probe }), settings: undefined },
        controller.signal,
      ),
    ).rejects.toThrow()
    expect(probe).not.toHaveBeenCalled()
  })

  function fakeTypert() {
    const constructed: unknown[][] = []
    const marked: { method: unknown; name: string; instance: unknown }[] = []
    class TypertRemoteService {
      constructor(...args: unknown[]) {
        constructed.push(args)
      }
    }
    const Remote = (name: string) => (method: unknown, context: MethodDecoratorContextLike) => {
      context.addInitializer(function (this: unknown) {
        marked.push({ method, name: `${name}:${context.name}`, instance: this })
      })
    }
    return { module: { TypertRemoteService, Remote } as unknown as TypertModule, constructed, marked }
  }

  it('rejects and does not cache a successful adapter result received after cancellation', async () => {
    const controller = new AbortController()
    const onResult = vi.fn()
    const Service = createProbeServiceClass(fakeTypert().module, {
      subprocess: () => fakeSubprocess(),
      adapters: () => ({
        ...testAdapter(),
        probe: async () => {
          controller.abort()
          return { cli: 'codex', found: true, version: '1.2.3' }
        },
      }),
      cliSettings: () => undefined,
      isDisposed: () => false,
      onResult,
    })
    await expect(new Service({}).probe({ cli: 'codex' }, controller.signal)).rejects.toThrow()
    expect(onResult).not.toHaveBeenCalled()
  })

  it('builds a Remote service class whose probe method is marked at construction', async () => {
    const typert = fakeTypert()
    const subprocess = fakeSubprocess()
    const Service = createProbeServiceClass(typert.module, {
      subprocess: () => subprocess,
      adapters: () => testAdapter({ descriptor: CODEX }),
      cliSettings: () => undefined,
      isDisposed: () => false,
    })
    const ctx = { marker: true }
    const service = new Service(ctx)
    expect(typert.constructed).toEqual([[ctx, PROBE_SERVICE_NAME]])
    expect(typert.marked).toEqual([{ method: Service.prototype.probe, name: 'probe:probe', instance: service }])
    expect(Service.prototype.probe.toString()).toMatch(/^async probe\(request, signal\)/)
    expect(await service.probe({ cli: 'codex' }, signal)).toEqual({ cli: 'codex', found: true, path: '/bin/codex' })
  })

  it('attributes cached probe data to settings captured at admission, not completion', async () => {
    const typert = fakeTypert()
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => {
      entered = resolve
    })
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const source = { codex: { executable: 'old-codex', envPassthrough: ['OLD_NAME'] } }
    const seen = vi.fn()
    const adapter: CliAdapter = {
      ...testAdapter({ descriptor: CODEX }),
      probe: async () => {
        entered()
        await blocked
        return { cli: 'codex', found: true, models: [{ id: 'old-model' }] }
      },
    }
    const Service = createProbeServiceClass(typert.module, {
      subprocess: () => fakeSubprocess(),
      adapters: () => adapter,
      cliSettings: () => source,
      isDisposed: () => false,
      onResult: seen,
    })
    const running = new Service({}).probe({ cli: 'codex' }, signal)
    await started
    source.codex.executable = 'new-codex'
    source.codex.envPassthrough.push('NEW_NAME')
    release()
    await running
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ cli: 'codex', models: [{ id: 'old-model' }] }), {
      codex: { executable: 'old-codex', envPassthrough: ['OLD_NAME'] },
    })
  })

  it('mounts only when the Host can load Typert and the plugin is still loaded', async () => {
    const world = fakeWorld()
    const plugin = vi.fn()
    const ctx = Object.assign(Object.create(world.ctx) as HostContext, { plugin })
    const options = { subprocess: () => undefined, adapters: () => testAdapter(), cliSettings: () => undefined }
    await mountProbeService(ctx, { ...options, isDisposed: () => false }, async () => fakeTypert().module)
    expect(plugin).toHaveBeenCalledTimes(1)
    await mountProbeService(ctx, { ...options, isDisposed: () => true }, async () => fakeTypert().module)
    expect(plugin).toHaveBeenCalledTimes(1)
    const failing = async () => {
      throw new Error('Cannot find package')
    }
    await mountProbeService(ctx, { ...options, isDisposed: () => false }, failing)
    await mountProbeService(ctx, { ...options, isDisposed: () => false }, failing)
    expect(
      world.logger.info.mock.calls.filter(([text]) => String(text).includes('connection test is unavailable')),
    ).toHaveLength(1)
    plugin.mockImplementationOnce(() => {
      throw new Error('duplicate service')
    })
    await mountProbeService(ctx, { ...options, isDisposed: () => false }, async () => fakeTypert().module)
    expect(world.logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not mount the CLI connection test'))
    // Without ctx.plugin (tests, older Hosts) nothing is attempted.
    const load = vi.fn(async () => fakeTypert().module)
    await mountProbeService(world.ctx, { ...options, isDisposed: () => false }, load)
    expect(load).not.toHaveBeenCalled()
  })
})
