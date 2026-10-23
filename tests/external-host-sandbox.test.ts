// biome-ignore-all lint/suspicious/noTemplateCurlyInString: run-plan placeholders are engine-owned literals.
import { mkdtempSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CODEX } from '../src/shared/cli/codex.ts'
import {
  PARTIAL_SANDBOX_WARNING,
  HOST_SANDBOX_NOTICE,
  startExternalRun,
  type EngineDeps,
  type ExternalRunSpec,
} from '../src/host/external/engine.ts'
import type { ConfinedArgvPort, SandboxPort, SubagentRunPort } from '../src/host/ports.ts'
import { fakeSubprocess, line, testAdapter, type FakeSubprocessOptions } from './external-fakes.ts'

const fixture = () => mkdtempSync(join(tmpdir(), 'rolesubagents-host-sandbox-'))
const wrapped = (argv: readonly string[], partial = false): ConfinedArgvPort => ({
  argv: ['/trusted/sandbox-runner', '--', ...argv],
  enforcement: partial ? 'partial' : 'full',
  denialSignatures: ['permission denied'],
  runnerFailureRules: [
    { allowedExitCodes: [125], fatalSignatures: ['runner: '], informationalLines: ['runner: partial enforcement'] },
  ],
})
const answer = async (process: Parameters<NonNullable<FakeSubprocessOptions['onRun']>>[0]) => {
  await process.stdinClosed
  process.stdout(line({ type: 'text', text: 'CLI answer' }))
  process.stdout(line({ type: 'done' }))
  process.exit(0)
}
function setup(options: { sandbox?: SandboxPort; native?: boolean; subprocess?: FakeSubprocessOptions } = {}) {
  const cwd = fixture()
  const tmp = fixture()
  const home = fixture()
  const subprocess = fakeSubprocess({ onRun: answer, ...options.subprocess })
  const adapter = testAdapter({
    descriptor: options.native
      ? CODEX
      : {
          ...CODEX,
          permissions: CODEX.permissions.map(preset =>
            preset.id === 'workspace-write' ? { ...preset, confinement: 'host-sandbox' as const } : preset,
          ),
        },
    plan: () => ({ argv: ['run', '${RUN_DIR}/role.md'], env: {}, files: { '${RUN_DIR}/role.md': 'role' } }),
  })
  const controller = new AbortController()
  const logger = { info: vi.fn(), warn: vi.fn() }
  const deps: EngineDeps = {
    subprocess: () => subprocess,
    sandbox: () => options.sandbox,
    logger,
    runs: new Set<SubagentRunPort>(),
    tmpDir: tmp,
    hostEnv: { HOME: home, PATH: '/trusted/bin' },
  }
  const spec: ExternalRunSpec = {
    adapter,
    input: {
      cwd,
      runner: { cli: 'codex', permission: 'workspace-write' },
      preset: 'workspace-write',
      access: 'workspace-write',
      instructions: 'role',
      task: 'task',
    },
    settings: {},
    timeoutMs: 10_000,
    signal: controller.signal,
  }
  return {
    cwd,
    tmp,
    home,
    adapter,
    subprocess,
    controller,
    logger,
    deps,
    spec,
    start: () => startExternalRun(spec, deps),
  }
}

describe('DSH Host sandbox execution', () => {
  it('defers private source reads and task materialization until inside the confined bootstrap', async () => {
    const confine = vi.fn(async (argv: readonly string[]) => wrapped(argv))
    const t = setup({
      sandbox: { confine },
      subprocess: {
        onRun: async process => {
          const payload = JSON.parse(process.spec.env?.DSH_ROLES_CLI_BOOT ?? '{}')
          expect(payload.kind).toBe('pi')
          expect(process.spec.argv.join(' ')).not.toContain('PRIVATE_TASK')
          expect(JSON.stringify(payload)).not.toContain('HOST_SHOULD_NOT_PARSE_SECRET')
          for (const file of Object.keys(payload.files)) expect(existsSync(file)).toBe(false)
          await answer(process)
        },
      },
    })
    mkdirSync(join(t.home, '.pi', 'agent'), { recursive: true })
    writeFileSync(join(t.home, '.pi', 'agent', 'auth.json'), 'INVALID HOST_SHOULD_NOT_PARSE_SECRET')
    const adapter = {
      ...t.adapter,
      plan: () => ({
        argv: ['run', '${RUN_DIR}/task.txt'],
        env: {},
        privateState: 'pi' as const,
        files: { '${RUN_DIR}/task.txt': 'PRIVATE_TASK' },
        cancelGraceMs: 0,
      }),
    }
    const result = await (await startExternalRun({ ...t.spec, adapter }, t.deps)).result
    expect(result.stopReason).toBe('completed')
    expect(confine.mock.calls[0]?.[0][0]).toBe(process.execPath)
    expect(readdirSync(t.tmp)).toEqual([])
  })
  it('returns actionable fixed diagnostics when the confined state bootstrap fails', async () => {
    const t = setup({
      sandbox: { confine: async argv => wrapped(argv) },
      subprocess: {
        onRun: async process => {
          await process.stdinClosed
          process.stderr(
            'rolesubagents: limited CLI state preparation failed; use API-key authentication or the native preset',
          )
          process.exit(78)
        },
      },
    })
    const adapter = {
      ...t.adapter,
      plan: () => ({
        argv: ['run', '${RUN_DIR}/task.txt'],
        env: {},
        privateState: 'pi' as const,
        files: {},
        cancelGraceMs: 0,
      }),
    }
    const result = await (await startExternalRun({ ...t.spec, adapter }, t.deps)).result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('private-cli-state-unavailable')
    expect(JSON.stringify(result.output)).toContain('static API-key authentication')
  })
  it('wraps the exact resolved command and final substituted files, with a narrower cwd policy', async () => {
    const confine = vi.fn(async (argv: readonly string[]) => wrapped(argv))
    const t = setup({ sandbox: { confine } })
    const run = await t.start()
    expect(await run.result).toEqual({
      output: [
        { type: 'text', text: 'CLI answer' },
        { type: 'text', text: HOST_SANDBOX_NOTICE },
      ],
      stopReason: 'completed',
    })
    expect(confine).toHaveBeenCalledOnce()
    expect(confine.mock.calls[0]?.[0][0]).toBe('/bin/codex')
    expect(confine.mock.calls[0]?.[0][2]).toMatch(/rolesubagents.*role\.md$/)
    expect(confine).toHaveBeenCalledWith(
      expect.any(Array),
      { mode: 'workspace-write', workspaceRoot: t.cwd },
      expect.any(AbortSignal),
    )
    expect(t.subprocess.processes[0]?.spec.argv).toEqual(wrapped(confine.mock.calls[0]![0]).argv)
    expect(readdirSync(t.tmp)).toEqual([])
  })

  it('anchors confinement to the established parent root rather than a selected child path', async () => {
    const confine = vi.fn(async (argv: readonly string[]) => wrapped(argv))
    const t = setup({ sandbox: { confine } })
    const child = join(t.cwd, 'child')
    mkdirSync(child)
    await (await startExternalRun({ ...t.spec, workspaceRoot: t.cwd, input: { ...t.spec.input, cwd: child } }, t.deps))
      .result
    expect(confine).toHaveBeenCalledWith(
      expect.any(Array),
      { mode: 'workspace-write', workspaceRoot: t.cwd },
      expect.any(AbortSignal),
    )
  })
  it('rejects a child directory outside the parent root at the engine boundary', async () => {
    const confine = vi.fn(async (argv: readonly string[]) => wrapped(argv))
    const t = setup({ sandbox: { confine } })
    await expect(startExternalRun({ ...t.spec, workspaceRoot: t.home }, t.deps)).rejects.toThrow(/outside the parent/)
    expect(confine).not.toHaveBeenCalled()
    expect(t.subprocess.processes).toEqual([])
  })

  it('does not invoke the sandbox or change results for legacy/native presets', async () => {
    const confine = vi.fn(async () => {
      throw new Error('must not call')
    })
    const t = setup({ native: true, sandbox: { confine } })
    const result = await (await t.start()).result
    expect(result.output).toEqual([{ type: 'text', text: 'CLI answer' }])
    expect(confine).not.toHaveBeenCalled()
    expect(t.subprocess.processes[0]?.spec.argv[0]).toBe('/bin/codex')
  })

  it('refuses a missing sandbox service before creating files or spawning', async () => {
    const t = setup()
    await expect(t.start()).rejects.toThrow(/needs the Host's DSH file sandbox/)
    expect(t.subprocess.processes).toEqual([])
    expect(readdirSync(t.tmp)).toEqual([])
  })

  it('does not leak a sandbox service-resolution exception', async () => {
    const t = setup()
    await expect(
      startExternalRun(t.spec, {
        ...t.deps,
        sandbox: () => {
          throw new Error('SECRET service getter')
        },
      }),
    ).rejects.toThrow(/^Codex could not obtain a usable DSH file sandbox; no unconfined process was started$/)
    expect(t.subprocess.processes).toEqual([])
    expect(readdirSync(t.tmp)).toEqual([])
  })

  it('cleans files and gives a fixed error when confinement fails', async () => {
    const t = setup({
      sandbox: {
        confine: async () => {
          throw new Error('secret provider details')
        },
      },
    })
    await expect(t.start()).rejects.toThrow(
      /^Codex could not obtain a usable DSH file sandbox; no unconfined process was started$/,
    )
    expect(t.subprocess.processes).toEqual([])
    expect(readdirSync(t.tmp)).toEqual([])
  })

  it.each([
    undefined,
    {},
    { argv: [] },
    { ...wrapped(['/bin/codex']), enforcement: 'unknown' },
    { ...wrapped(['/bin/codex']), argv: ['/runner', 'wrong-command'] },
    { ...wrapped(['/bin/codex']), argv: ['/runner\0hidden', '--', '/bin/codex'] },
  ])('refuses malformed or nonwrapping sandbox metadata %#', async metadata => {
    const t = setup({ sandbox: { confine: vi.fn(async () => metadata) as unknown as SandboxPort['confine'] } })
    await expect(t.start()).rejects.toThrow(/could not obtain a usable DSH file sandbox/)
    expect(t.subprocess.processes).toEqual([])
    expect(readdirSync(t.tmp)).toEqual([])
  })

  it('never spawns after cancellation during asynchronous wrapping', async () => {
    let enter!: () => void
    let release!: (value: ConfinedArgvPort) => void
    const entered = new Promise<void>(resolve => {
      enter = resolve
    })
    const t = setup({
      sandbox: {
        confine: async () => {
          enter()
          return new Promise(resolve => {
            release = resolve
          })
        },
      },
    })
    const pending = t.start()
    await entered
    t.controller.abort(new Error('cancelled startup'))
    release(wrapped(['/bin/codex', 'run', 'not-relevant']))
    await expect(pending).rejects.toThrow('cancelled startup')
    expect(t.subprocess.processes).toEqual([])
    expect(readdirSync(t.tmp)).toEqual([])
  })

  it.each([0, 1])(
    'preserves answer/failure and surfaces the fixed partial-enforcement caveat for exit %i',
    async code => {
      const t = setup({
        sandbox: { confine: async argv => wrapped(argv, true) },
        subprocess: {
          onRun: async process => {
            await process.stdinClosed
            process.stdout(line({ type: 'text', text: 'partial answer' }))
            if (code === 0) process.stdout(line({ type: 'done' }))
            process.exit(code)
          },
        },
      })
      const result = await (await t.start()).result
      expect(result.stopReason).toBe(code === 0 ? 'completed' : 'error')
      expect(result.output).toEqual([
        { type: 'text', text: 'partial answer' },
        { type: 'text', text: HOST_SANDBOX_NOTICE },
        { type: 'text', text: PARTIAL_SANDBOX_WARNING },
      ])
      expect(t.logger.warn).toHaveBeenCalledWith(expect.stringContaining(PARTIAL_SANDBOX_WARNING))
    },
  )

  it('confines preflight and main CLI separately; preflight never executes raw', async () => {
    const confine = vi.fn(async (argv: readonly string[]) => wrapped(argv))
    const t = setup({ sandbox: { confine } })
    const adapter = {
      ...t.adapter,
      plan: (input: Parameters<typeof t.adapter.plan>[0], nonce: string) => ({
        ...t.adapter.plan(input, nonce),
        preflight: { argv: ['auth', 'status'], timeoutMs: 1000, category: 'auth' as const },
      }),
    }
    await (await startExternalRun({ ...t.spec, adapter }, t.deps)).result
    expect(confine).toHaveBeenCalledTimes(2)
    expect(confine.mock.calls[0]?.[0]).toEqual(['/bin/codex', 'auth', 'status'])
    expect(t.subprocess.collected[0]?.argv).toEqual(['/trusted/sandbox-runner', '--', '/bin/codex', 'auth', 'status'])
    expect(t.subprocess.processes[0]?.spec.argv[0]).toBe('/trusted/sandbox-runner')
  })

  it('classifies a failed preflight runner as configuration rather than authentication', async () => {
    const t = setup({
      sandbox: { confine: async argv => wrapped(argv) },
      subprocess: { onCollect: () => ({ code: 125, stderr: 'runner: failed permission denied SECRET' }) },
    })
    const adapter = {
      ...t.adapter,
      plan: (input: Parameters<typeof t.adapter.plan>[0], nonce: string) => ({
        ...t.adapter.plan(input, nonce),
        preflight: { argv: ['auth'], timeoutMs: 1000, category: 'auth' as const },
      }),
    }
    await expect(startExternalRun({ ...t.spec, adapter }, t.deps)).rejects.toThrow(
      /category: config; reason: sandbox-runner-failed/,
    )
    expect(t.subprocess.processes).toEqual([])
    expect(readdirSync(t.tmp)).toEqual([])
  })

  it.each([
    [125, 'runner: failed permission denied SECRET', true],
    [1, 'runner: failed permission denied SECRET', false],
    [125, 'runner: partial enforcement', false],
    [125, 'ordinary permission denied', false],
    [0, 'runner: failed permission denied SECRET', false],
  ] as const)(
    'gates runner failure classification by status and fatal evidence (%i, %s)',
    async (code, stderr, failed) => {
      const t = setup({
        sandbox: { confine: async argv => wrapped(argv) },
        subprocess: {
          onRun: async process => {
            await process.stdinClosed
            process.stdout(line({ type: 'text', text: 'CLI answer' }))
            process.stdout(line({ type: 'done' }))
            process.stderr(stderr)
            process.exit(code)
          },
        },
      })
      const result = await (await t.start()).result
      expect(result.stopReason).toBe(failed ? 'error' : 'completed')
      if (failed) {
        expect(result.diagnostic).toContain('category: config')
        expect(result.diagnostic).toContain('sandbox-runner-failed')
        expect(result.diagnostic).not.toContain('SECRET')
        expect(result.output).toEqual([{ type: 'text', text: HOST_SANDBOX_NOTICE }])
      }
    },
  )

  it('tombstones loader/runtime/shell hooks even if explicitly forwarded, only for host confinement', async () => {
    const names = [
      'LD_PRELOAD',
      'LD_AUDIT',
      'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES',
      'BASH_ENV',
      'ENV',
      'ZDOTDIR',
      'NODE_OPTIONS',
      'NODE_PATH',
      'PYTHONPATH',
      'GCONV_PATH',
    ]
    for (const native of [false, true]) {
      const t = setup({ native, sandbox: { confine: async argv => wrapped(argv) } })
      const env = {
        HOME: t.home,
        PATH: '/trusted/bin',
        ...Object.fromEntries(names.map(name => [name, '/secret/startup'])),
      }
      await (await startExternalRun({ ...t.spec, settings: { envPassthrough: names } }, { ...t.deps, hostEnv: env }))
        .result
      for (const name of names)
        expect(t.subprocess.processes[0]?.spec.env?.[name]).toBe(native ? '/secret/startup' : undefined)
    }
  })

  it('resolves a bare sandbox runner with trusted Host PATH rather than CLI PATH overrides', async () => {
    const t = setup({
      sandbox: { confine: async argv => ({ ...wrapped(argv), argv: ['sandbox-runner', '--', ...argv] }) },
    })
    const adapter = {
      ...t.adapter,
      plan: (input: Parameters<typeof t.adapter.plan>[0], nonce: string) => ({
        ...t.adapter.plan(input, nonce),
        env: { PATH: '/malicious/cli-path' },
      }),
    }
    await (await startExternalRun({ ...t.spec, adapter }, t.deps)).result
    expect(t.subprocess.resolveCalls).toContainEqual({ command: 'sandbox-runner', env: { PATH: '/trusted/bin' } })
    expect(t.subprocess.processes[0]?.spec.argv[0]).toBe('/bin/sandbox-runner')
  })
})
