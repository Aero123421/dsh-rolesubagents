// biome-ignore-all lint/suspicious/noTemplateCurlyInString: run-plan placeholders are literal ${...} strings.
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  createProbeRunner,
  type EngineDeps,
  type ExternalRunSpec,
  resolvePlanFile,
  SPAWN_GRACE_MS,
  startExternalRun,
  toSubagentResult,
} from '../src/host/external/engine.ts'
import type { PlanInput, RunPlan } from '../src/host/external/types.ts'
import type { SubagentRunPort } from '../src/host/ports.ts'
import { type FakeProcess, type FakeSubprocessOptions, fakeSubprocess, line, testAdapter } from './external-fakes.ts'

const workspace = mkdtempSync(join(tmpdir(), 'rolesubagents-engine-ws-'))

function input(patch: Partial<PlanInput> = {}): PlanInput {
  return {
    runner: { cli: 'codex', permission: 'workspace-write' },
    preset: 'workspace-write',
    access: 'workspace-write',
    instructions: 'Your role: worker.',
    task: 'fix the bug ✓',
    cwd: workspace,
    ...patch,
  }
}

interface Setup {
  readonly subprocess?: FakeSubprocessOptions
  readonly plan?: (input: PlanInput, nonce: string) => Partial<RunPlan>
  readonly cancellable?: boolean
  readonly spec?: Partial<ExternalRunSpec>
  readonly deps?: Partial<EngineDeps>
}

function setup(options: Setup = {}) {
  const subprocess = fakeSubprocess(options.subprocess)
  const adapter = testAdapter({
    ...(options.plan === undefined ? {} : { plan: options.plan }),
    ...(options.cancellable === undefined ? {} : { cancellable: options.cancellable }),
  })
  const logger = { info: vi.fn(), warn: vi.fn() }
  const runs = new Set<SubagentRunPort>()
  const tmp = mkdtempSync(join(tmpdir(), 'rolesubagents-engine-tmp-'))
  const home = mkdtempSync(join(tmpdir(), 'rolesubagents-engine-home-'))
  const controller = new AbortController()
  const deps: EngineDeps = {
    subprocess: () => subprocess,
    logger,
    runs,
    hostEnv: { HOME: home, PATH: '/usr/bin', FORWARD_ME: 'forwarded', CLAUDECODE: '1' },
    tmpDir: tmp,
    random: { nonce: () => 'abcdef012345', secret: () => 'f'.repeat(32), id: () => 'run-1' },
    ...options.deps,
  }
  const spec: ExternalRunSpec = {
    adapter,
    input: input(),
    settings: {},
    timeoutMs: 60_000,
    signal: controller.signal,
    ...options.spec,
  }
  const start = () => startExternalRun(spec, deps)
  return { subprocess, adapter, logger, runs, tmp, home, controller, deps, spec, start }
}

const answering =
  (...chunks: (string | Uint8Array)[]) =>
  async (process: FakeProcess) => {
    await process.stdinClosed
    for (const chunk of chunks) process.stdout(chunk)
    process.exit(0)
  }

describe('startExternalRun: a successful run', () => {
  it('spawns the CLI with pipes, writes and closes stdin, and settles the final answer', async () => {
    const t = setup({
      subprocess: {
        onRun: answering(
          line({ type: 'text', text: 'all ' }),
          line({ type: 'text', text: 'done' }),
          line({ type: 'done' }),
        ),
      },
    })
    const run = await t.start()
    expect(run.id).toBe('run-1')
    expect(t.runs.has(run)).toBe(true)
    const result = await run.result
    expect(result).toEqual({ output: [{ type: 'text', text: 'all done' }], stopReason: 'completed' })
    const [process] = t.subprocess.processes
    expect(process?.spec).toMatchObject({
      argv: ['/bin/codex', 'run', '--preset', 'workspace-write'],
      cwd: workspace,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: SPAWN_GRACE_MS,
    })
    expect(process?.spec.signal).toBeUndefined()
    expect(process?.stdinText()).toBe('fix the bug ✓')
    expect(process?.stdinEnded).toBe(true)
    expect(t.adapter.nonces).toEqual(['abcdef012345'])
    expect(t.runs.has(run)).toBe(true)
    expect(t.logger.warn).not.toHaveBeenCalled()
    expect(process?.terminated).toBe(0)
    await run.dispose()
    await run.dispose()
    expect(t.runs.size).toBe(0)
    // dispose sweeps the (already empty) managed range once.
    expect(process?.terminated).toBe(1)
  })

  it('frames CRLF lines and multi-byte characters split across chunks', async () => {
    const bytes = Buffer.from(`${JSON.stringify({ type: 'text', text: '日本語' })}\r\n{"type":"done"}`, 'utf8')
    const chunks = Array.from(bytes, byte => Uint8Array.of(byte))
    const t = setup({ subprocess: { onRun: answering(...chunks) } })
    const result = await (await t.start()).result
    expect(result.output).toEqual([{ type: 'text', text: '日本語' }])
    expect(t.adapter.sessions[0]?.lines).toEqual(['{"type":"text","text":"日本語"}', '{"type":"done"}'])
  })

  it('composes the environment and resolves the configured executable with it', async () => {
    const t = setup({
      spec: { settings: { executable: '/opt/codex', envPassthrough: ['FORWARD_ME', 'ABSENT'] } },
      plan: () => ({ env: { PLAN_VAR: 'p', PATH: undefined } }),
      subprocess: { onRun: answering(line({ type: 'text', text: 'x' }), line({ type: 'done' })) },
    })
    await (await t.start()).result
    expect(t.subprocess.resolveCalls).toEqual([
      { command: '/opt/codex', env: { FORWARD_ME: 'forwarded', PLAN_VAR: 'p' } },
    ])
    const env = t.subprocess.processes[0]?.spec.env ?? {}
    expect(env).toMatchObject({ FORWARD_ME: 'forwarded', PLAN_VAR: 'p', PATH: undefined, CLAUDECODE: undefined })
    expect('ABSENT' in env).toBe(false)
  })
})

describe('startExternalRun: files and placeholders', () => {
  it('creates files before spawn, substitutes placeholders and removes everything afterwards', async () => {
    let seen: { runFile: string; homeFile: string; mode: number; dirMode: number; argv: readonly string[] } | undefined
    const t = setup({
      plan: () => ({
        argv: ['--log', '${RUN_DIR}/cli.log', '--agent-text', 'literal ${HOME} stays', '${HOME}/x'],
        env: { CONFIG: '{"instructions":["${RUN_DIR}/role.md"]}', PASSWORD: '${SECRET}' },
        files: { '${RUN_DIR}/role.md': 'Role ${HOME} text', '${HOME}/.cli/agents/dsh-abcdef012345.md': 'agent' },
      }),
      subprocess: {
        onRun: async process => {
          const runDir = String(process.spec.argv[2]).replace(/\/cli\.log$/, '')
          const runFile = join(runDir, 'role.md')
          seen = {
            runFile,
            homeFile: join(t.home, '.cli/agents/dsh-abcdef012345.md'),
            mode: statSync(runFile).mode & 0o777,
            dirMode: statSync(runDir).mode & 0o777,
            argv: process.spec.argv,
          }
          expect(readFileSync(runFile, 'utf8')).toBe('Role ${HOME} text')
          expect(readFileSync(seen.homeFile, 'utf8')).toBe('agent')
          expect(process.spec.env).toMatchObject({
            CONFIG: `{"instructions":["${runDir}/role.md"]}`,
            PASSWORD: 'f'.repeat(32),
          })
          await answering(line({ type: 'text', text: 'ok' }), line({ type: 'done' }))(process)
        },
      },
    })
    const result = await (await t.start()).result
    expect(result.stopReason).toBe('completed')
    if (seen === undefined) throw new Error('the process never ran')
    expect(seen.mode).toBe(0o600)
    expect(seen.dirMode).toBe(0o700)
    expect(seen.argv[1]).toBe('--log')
    expect(seen.argv[2]?.startsWith(t.tmp)).toBe(true)
    expect(seen.argv[4]).toBe('literal ${HOME} stays')
    expect(seen.argv[5]).toBe(`${t.home}/x`)
    expect(existsSync(seen.runFile)).toBe(false)
    expect(existsSync(seen.homeFile)).toBe(false)
    expect(readdirSync(t.tmp)).toEqual([])
  })

  it('removes files when the run fails and when the spawn throws', async () => {
    const files = { '${RUN_DIR}/a': 'a', '${HOME}/b': 'b' }
    const failing = setup({ plan: () => ({ files }), subprocess: { onRun: p => p.exit(1) } })
    await (await failing.start()).result
    expect(readdirSync(failing.tmp)).toEqual([])
    expect(existsSync(join(failing.home, 'b'))).toBe(false)

    const throwing = setup({ plan: () => ({ files }), subprocess: { spawnThrows: true } })
    await expect(throwing.start()).rejects.toThrow(/^Codex could not be started$/)
    expect(readdirSync(throwing.tmp)).toEqual([])
    expect(existsSync(join(throwing.home, 'b'))).toBe(false)
    expect(throwing.logger.warn).toHaveBeenCalledWith(expect.stringContaining('secret detail'))
  })

  it('never overwrites an existing file and refuses keys outside the placeholders', async () => {
    const t = setup({ plan: () => ({ files: { '${HOME}/taken': 'new' } }) })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(t.home, 'taken'), 'mine')
    await expect(t.start()).rejects.toThrow(/^Codex run files could not be prepared$/)
    expect(readFileSync(join(t.home, 'taken'), 'utf8')).toBe('mine')
    expect(t.subprocess.processes).toEqual([])

    for (const key of ['/etc/passwd', '${RUN_DIR}/../x', '${HOME}//x', '${SECRET}/x', 'relative']) {
      expect(() => resolvePlanFile(key, { RUN_DIR: '/tmp/run', HOME: '/home/u' })).toThrow()
    }
    expect(resolvePlanFile('${HOME}/.gemini/a.md', { RUN_DIR: '/tmp/run', HOME: '/home/u' })).toBe(
      '/home/u/.gemini/a.md',
    )
  })
})

describe('startExternalRun: refusals before spawn', () => {
  it('refuses without the subprocess service, with a bad cwd, a missing CLI or an aborted signal', async () => {
    await expect(setup({ deps: { subprocess: () => undefined } }).start()).rejects.toThrow(
      /Codex roles need the Host's subprocess service/,
    )
    await expect(setup({ spec: { input: input({ cwd: '/definitely/missing' }) } }).start()).rejects.toThrow(
      /not an accessible directory: \/definitely\/missing/,
    )
    await expect(setup({ subprocess: { executables: {} } }).start()).rejects.toThrow(
      /^Codex was not found \(set its path in the plugin settings\)$/,
    )
    const aborted = setup()
    aborted.controller.abort()
    await expect(aborted.start()).rejects.toThrow()
    expect(aborted.subprocess.processes).toEqual([])
  })

  it('refuses when the pre-flight fails, with the category in a safe message', async () => {
    const t = setup({
      plan: () => ({
        preflight: { argv: ['models'], timeoutMs: 1000, category: 'auth' },
        files: { '${RUN_DIR}/x': 'x' },
      }),
      subprocess: { onCollect: () => ({ code: 1, stderr: 'token sk-secret expired' }) },
    })
    const error = await t.start().then(
      () => undefined,
      (e: Error) => e,
    )
    expect(error?.message).toMatch(/^Subagent failure \(CLI: Codex; category: auth\)\n/)
    expect(error?.message).not.toContain('sk-secret')
    expect(t.subprocess.collected[0]?.argv).toEqual(['/bin/codex', 'models'])
    expect(t.subprocess.collected[0]?.stdio.stdin).toBe('ignore')
    expect(t.subprocess.processes).toEqual([])
    expect(readdirSync(t.tmp)).toEqual([])
  })

  it('runs the real command after a passing pre-flight', async () => {
    const t = setup({
      plan: () => ({ preflight: { argv: ['models'], timeoutMs: 1000, category: 'auth' } }),
      subprocess: {
        onCollect: () => ({ code: 0 }),
        onRun: answering(line({ type: 'text', text: 'y' }), line({ type: 'done' })),
      },
    })
    expect((await (await t.start()).result).stopReason).toBe('completed')
  })
})

describe('startExternalRun: failures, timeout and cancellation', () => {
  it('maps a crash to a safe cli-crashed diagnostic and logs stderr on the Host only', async () => {
    const t = setup({
      subprocess: {
        onRun: async p => {
          await p.stdinClosed
          p.stdout(line({ type: 'text', text: 'partial' }))
          p.stderr('Error: request to https://api.example/v1 failed with key sk-123\n')
          p.exit(2)
        },
      },
    })
    const result = await (await t.start()).result
    expect(result.stopReason).toBe('error')
    expect(result.output).toEqual([{ type: 'text', text: 'partial' }])
    expect(result.diagnostic).toBe(
      'Subagent failure (CLI: Codex; category: cli-crashed; exit code: 2)\nThe CLI exited without a final result.',
    )
    expect(result.diagnostic).not.toContain('sk-123')
    expect(t.logger.warn).toHaveBeenCalledWith(expect.stringContaining('sk-123'))
  })

  it('maps an adapter failure category and an unknown category', async () => {
    const t = setup({ subprocess: { onRun: answering(line({ type: 'error', category: 'rate-limit' })) } })
    expect((await (await t.start()).result).diagnostic).toMatch(/category: rate-limit; exit code: 0\)/)
    const u = setup({ subprocess: { onRun: answering(line({ type: 'error', category: 'made-up' })) } })
    expect((await (await u.start()).result).diagnostic).toMatch(/category: unknown/)
  })

  it('reports an empty completed answer as empty-answer', async () => {
    const t = setup({ subprocess: { onRun: answering(line({ type: 'text', text: '  ' }), line({ type: 'done' })) } })
    const result = await (await t.start()).result
    expect(result).toMatchObject({ stopReason: 'error', output: [] })
    expect(result.diagnostic).toMatch(/category: empty-answer/)
  })

  it('treats a throwing session and a rejected spawn outcome as a crash', async () => {
    const t = setup({ subprocess: { onRun: answering('{"type":"text","text":"a"}\n', line({ type: 'done' })) } })
    const run = t.start()
    // Make the session throw on its first line.
    const started = await run
    const session = t.adapter.sessions[0]
    if (session !== undefined)
      session.line = () => {
        throw new Error('parser bug')
      }
    expect((await started.result).diagnostic).toMatch(/category: cli-crashed/)

    const r = setup({
      subprocess: { onRun: p => p.fail(Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' })) },
    })
    const result = await (await r.start()).result
    expect(result.diagnostic).toMatch(/^Subagent failure \(CLI: Codex; category: cli-crashed\)/)
  })

  it('times out: asks the session to cancel, terminates after the grace and reports timeout', async () => {
    const onTerminalStatus = vi.fn()
    const t = setup({ spec: { timeoutMs: 20, onTerminalStatus }, subprocess: { onRun: () => {} } })
    const run = await t.start()
    const result = await run.result
    expect(t.adapter.sessions[0]?.cancelled).toBe(1)
    expect(t.subprocess.processes[0]?.terminated).toBe(1)
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toMatch(/category: timeout/)
    expect(onTerminalStatus).toHaveBeenCalledExactlyOnceWith('timeout')
  })

  it('aborts on the request signal with partial output', async () => {
    const onTerminalStatus = vi.fn()
    const t = setup({
      spec: { onTerminalStatus },
      subprocess: {
        onRun: async p => {
          await p.stdinClosed
          p.stdout(line({ type: 'text', text: 'half' }))
        },
      },
    })
    const run = await t.start()
    await new Promise(resolve => setTimeout(resolve, 10))
    t.controller.abort()
    const result = await run.result
    expect(result).toEqual({ output: [{ type: 'text', text: 'half' }], stopReason: 'aborted' })
    expect(onTerminalStatus).toHaveBeenCalledExactlyOnceWith('cancelled')
    expect(t.adapter.sessions[0]?.cancelled).toBe(1)
    expect(t.subprocess.processes[0]?.terminated).toBe(1)
    expect(t.runs.has(run)).toBe(true)
    await run.dispose()
    expect(t.runs.size).toBe(0)
  })

  it('terminates at once when the session has no graceful cancel', async () => {
    const t = setup({ cancellable: false, subprocess: { onRun: () => {} } })
    const run = await t.start()
    t.controller.abort()
    expect(t.subprocess.processes[0]?.terminated).toBe(1)
    expect((await run.result).stopReason).toBe('aborted')
  })

  it('dispose is idempotent, cancels a live run and waits for its cleanup', async () => {
    const t = setup({ plan: () => ({ files: { '${RUN_DIR}/x': 'x' } }), subprocess: { onRun: () => {} } })
    const run = await t.start()
    expect(t.runs.has(run)).toBe(true)
    const first = run.dispose()
    expect(run.dispose()).toBe(first)
    await first
    expect((await run.result).stopReason).toBe('aborted')
    expect(t.subprocess.processes[0]?.terminated).toBeGreaterThanOrEqual(1)
    expect(readdirSync(t.tmp)).toEqual([])
    expect(t.runs.size).toBe(0)
  })
})

describe('startExternalRun: dispose ladder (graceful cancel → cancelGraceMs → terminate)', () => {
  it('cancels first and terminates only after cancelGraceMs', async () => {
    const t = setup({ subprocess: { onRun: () => {} } })
    const run = await t.start()
    vi.useFakeTimers()
    try {
      const disposal = run.dispose()
      expect(t.adapter.sessions[0]?.cancelled).toBe(1)
      expect(t.subprocess.processes[0]?.terminated).toBe(0)
      vi.advanceTimersByTime(49)
      expect(t.subprocess.processes[0]?.terminated).toBe(0)
      vi.advanceTimersByTime(1)
      expect(t.subprocess.processes[0]?.terminated).toBe(1)
      vi.useRealTimers()
      await disposal
      expect((await run.result).stopReason).toBe('aborted')
      expect(t.runs.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not escalate while the CLI exits on the graceful cancel; terminates the range only after the result', async () => {
    let terminatedAtExit = -1
    const t = setup({
      subprocess: {
        onRun: async p => {
          await p.stdinClosed
          // A CLI that stops by itself once stdin closes (e.g. opencode acp after session/cancel).
          setTimeout(() => {
            terminatedAtExit = p.terminated
            p.exit(0)
          }, 5)
        },
      },
    })
    const run = await t.start()
    await run.dispose()
    expect(t.adapter.sessions[0]?.cancelled).toBe(1)
    expect(terminatedAtExit).toBe(0)
    // Only the final range sweep after the result settled; the grace timer was cleared.
    expect(t.subprocess.processes[0]?.terminated).toBe(1)
    expect((await run.result).stopReason).toBe('aborted')
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(t.subprocess.processes[0]?.terminated).toBe(1)
  })

  it('graceful cancel: a CLI that exits within the grace but leaves a background child is swept, dispose resolves', async () => {
    const t = setup({
      subprocess: {
        leftoverChild: true,
        onRun: async p => {
          await p.stdinClosed
          setTimeout(() => p.exit(0), 5)
        },
      },
    })
    const run = await t.start()
    await run.dispose()
    const process = t.subprocess.processes[0]
    expect(t.adapter.sessions[0]?.cancelled).toBe(1)
    expect(process?.terminated).toBe(1)
    expect(process?.childAlive).toBe(false)
    expect((await run.result).stopReason).toBe('aborted')
    expect(t.runs.size).toBe(0)
  })

  it('natural settle: a CLI that answered and exited but left a background child is swept by dispose', async () => {
    const t = setup({
      subprocess: {
        leftoverChild: true,
        onRun: answering(line({ type: 'text', text: 'ok' }), line({ type: 'done' })),
      },
    })
    const run = await t.start()
    expect((await run.result).stopReason).toBe('completed')
    const process = t.subprocess.processes[0]
    expect(process?.childAlive).toBe(true)
    let disposed = false
    const disposal = run.dispose().then(() => {
      disposed = true
    })
    await Promise.race([disposal, new Promise(resolve => setTimeout(resolve, 200))])
    expect(disposed).toBe(true)
    expect(process?.terminated).toBe(1)
    expect(process?.childAlive).toBe(false)
    expect(t.adapter.sessions[0]?.cancelled).toBe(0)
    expect((await run.result).stopReason).toBe('completed')
  })

  it('a leftover child alone does not settle the run late: the result settles when the CLI exits', async () => {
    const t = setup({
      subprocess: { leftoverChild: true, onRun: answering(line({ type: 'text', text: 'ok' }), line({ type: 'done' })) },
    })
    const run = await t.start()
    expect(await run.result).toEqual({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' })
    expect(t.subprocess.processes[0]?.terminated).toBe(0)
    await run.dispose()
  })

  it('terminates at once when the session has no graceful cancel', async () => {
    const t = setup({ cancellable: false, subprocess: { onRun: () => {} } })
    const run = await t.start()
    const disposal = run.dispose()
    expect(t.subprocess.processes[0]?.terminated).toBe(1)
    await disposal
    expect((await run.result).stopReason).toBe('aborted')
  })

  it('does not cancel a run whose process already exited; only sweeps its range', async () => {
    const t = setup({ subprocess: { onRun: answering(line({ type: 'text', text: 'ok' }), line({ type: 'done' })) } })
    const run = await t.start()
    expect((await run.result).stopReason).toBe('completed')
    await run.dispose()
    expect(t.adapter.sessions[0]?.cancelled).toBe(0)
    expect(t.subprocess.processes[0]?.terminated).toBe(1)
    expect((await run.result).stopReason).toBe('completed')
  })

  it('still resolves when terminating the exited range throws (logged)', async () => {
    const t = setup({
      subprocess: {
        terminateThrowsAfterExit: true,
        onRun: answering(line({ type: 'text', text: 'ok' }), line({ type: 'done' })),
      },
    })
    const run = await t.start()
    await run.result
    await run.dispose()
    expect(t.logger.warn).toHaveBeenCalledWith(expect.stringMatching(/could not terminate Codex run run-1/))
    expect(t.runs.size).toBe(0)
  })

  it('is idempotent and resolves only after the process exited', async () => {
    let exitNow: (() => void) | undefined
    const t = setup({
      subprocess: {
        ignoreTerminate: true,
        onRun: p => {
          exitNow = () => p.exit(null, 'SIGTERM')
        },
      },
    })
    const run = await t.start()
    let resolved = false
    const first = run.dispose().then(() => {
      resolved = true
    })
    expect(run.dispose()).toBe(run.dispose())
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(t.subprocess.processes[0]?.terminated).toBe(1)
    expect(resolved).toBe(false)
    exitNow?.()
    await first
    expect(resolved).toBe(true)
    expect(t.adapter.sessions[0]?.cancelled).toBe(1)
    expect((await run.result).stopReason).toBe('aborted')
  })
})

describe('result mapping and probe runner', () => {
  it('maps every outcome status', () => {
    const flags = { cancelled: false, timedOut: false }
    expect(toSubagentResult({ status: 'max-tokens', answer: 'p' }, 'X', flags)).toMatchObject({
      stopReason: 'max-tokens',
      output: [{ type: 'text', text: 'p' }],
    })
    expect(toSubagentResult({ status: 'refusal' }, 'X', flags)).toEqual({ output: [], stopReason: 'refusal' })
    expect(
      toSubagentResult({ status: 'completed', answer: 'a' }, 'X', { cancelled: true, timedOut: true }).stopReason,
    ).toBe('aborted')
    expect(
      toSubagentResult({ status: 'completed', answer: 'a' }, 'X', { cancelled: false, timedOut: true }).diagnostic,
    ).toMatch(/timeout/)
  })

  it('runs short commands with bounded output and reports timeouts and spawn failures', async () => {
    const subprocess = fakeSubprocess({ onCollect: spec => ({ code: 0, stdout: `v ${spec.argv.join(' ')}` }) })
    const run = createProbeRunner(subprocess, '/bin/cli', { A: '1' }, workspace)
    const result = await run(['--version'], { timeoutMs: 1000, env: { B: '2' } }, new AbortController().signal)
    expect(result).toEqual({ code: 0, stdout: 'v /bin/cli --version', stderr: '', timedOut: false })
    expect(subprocess.collected[0]).toMatchObject({
      cwd: workspace,
      env: { A: '1', B: '2' },
      stdio: { stdin: 'ignore' },
    })
    const aborted = new AbortController()
    aborted.abort()
    await expect(run(['x'], { timeoutMs: 1000 }, aborted.signal)).rejects.toThrow()
  })
})
