// biome-ignore-all lint/suspicious/noTemplateCurlyInString: instructions text with a literal ${HOME} placeholder.
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CODEX_BASE_ARGS, codexAdapter, codexArgv } from '../src/host/cli/codex/index.ts'
import {
  CodexStream,
  classifyFailure,
  classifyStderr,
  parseDebugModels,
  parseVersion,
} from '../src/host/cli/codex/parser.ts'
import { startExternalRun } from '../src/host/external/engine.ts'
import type { PlanInput, ProbeRun, ProbeRunner, RunExit, RunOutcome } from '../src/host/external/types.ts'
import type { SubagentRunPort } from '../src/host/ports.ts'
import { CODEX } from '../src/shared/cli/codex.ts'
import { fakeSubprocess } from './external-fakes.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures/cli/codex')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

function input(patch: Partial<PlanInput> = {}): PlanInput {
  return {
    runner: { cli: 'codex', permission: 'workspace-write' },
    preset: 'workspace-write',
    access: 'workspace-write',
    instructions: 'Your role: worker.',
    task: 'fix the bug ✓',
    cwd: '/work/space',
    ...patch,
  }
}

const exit = (patch: Partial<RunExit> = {}): RunExit => ({
  code: 0,
  signal: null,
  stderrTail: '',
  cancelled: false,
  timedOut: false,
  ...patch,
})

/** Replay a recorded stdout transcript through a fresh session. */
function replay(name: string, exitPatch: Partial<RunExit> = {}): RunOutcome {
  const session = codexAdapter.createSession(input(), 'abcdef012345')
  for (const line of fixture(name).split('\n')) session.line(line)
  return session.finish(exit(exitPatch))
}

/** Value following a `-c key=` override, parsed back as the JSON/TOML string it is. */
function override(argv: readonly string[], key: string): string | undefined {
  const entry = argv.find(arg => arg.startsWith(`${key}=`))
  return entry === undefined ? undefined : JSON.parse(entry.slice(key.length + 1))
}

describe('codex plan', () => {
  it('builds the hygiene argv with the preset, reading the task from stdin', () => {
    const plan = codexAdapter.plan(input(), 'abcdef012345')
    expect(plan.argv).toEqual([
      'exec',
      '--json',
      '--ephemeral',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--disable',
      'plugins',
      '--disable',
      'multi_agent',
      '-c',
      'analytics.enabled=false',
      '-c',
      'notify=[]',
      '-c',
      'shell_environment_policy.ignore_default_excludes=false',
      '-C',
      '/work/space',
      '-s',
      'workspace-write',
      '-c',
      'developer_instructions="Your role: worker."',
      '-',
    ])
    expect(plan.env).toEqual({})
    expect(plan.files).toBeUndefined()
    expect(plan.preflight).toBeUndefined()
    expect(plan.argv.join(' ')).not.toContain('fix the bug')
  })

  const presets = CODEX.permissions.map(preset => [preset.id, preset.access] as const)
  const variants = [
    { name: 'defaults', runner: {}, instructions: '' },
    { name: 'model', runner: { model: 'gpt-5.5' }, instructions: 'Your role: r.' },
    { name: 'effort', runner: { effort: 'xhigh' }, instructions: '' },
    { name: 'all', runner: { model: 'gpt-6.1-sol', effort: 'none' }, instructions: 'Your role: r.\nLine "two" \\ ✓' },
  ]
  for (const [preset, access] of presets) {
    for (const variant of variants) {
      it(`preset ${preset} × ${variant.name}`, () => {
        const plan = codexAdapter.plan(
          input({
            preset,
            access,
            runner: { cli: 'codex', permission: preset, ...variant.runner },
            instructions: variant.instructions,
          }),
          'n',
        )
        const { argv } = plan
        expect(argv.slice(0, CODEX_BASE_ARGS.length)).toEqual(CODEX_BASE_ARGS)
        expect(argv.at(-1)).toBe('-')
        expect(argv[argv.indexOf('-s') + 1]).toBe(preset)
        expect(argv[argv.indexOf('-C') + 1]).toBe('/work/space')
        const model = 'model' in variant.runner ? variant.runner.model : undefined
        if (model === undefined) expect(argv).not.toContain('-m')
        else expect(argv[argv.indexOf('-m') + 1]).toBe(model)
        const effort = 'effort' in variant.runner ? variant.runner.effort : undefined
        expect(override(argv, 'model_reasoning_effort')).toBe(effort)
        expect(override(argv, 'developer_instructions')).toBe(
          variant.instructions === '' ? undefined : variant.instructions,
        )
        expect(plan.env).toEqual({})
      })
    }
  }

  it('never passes an effort outside the descriptor (ultra) and skips blank instructions', () => {
    const argv = codexArgv(
      input({ runner: { cli: 'codex', permission: 'read-only', effort: 'ultra' }, instructions: '  \n' }),
    )
    expect(argv.some(arg => arg.includes('model_reasoning_effort'))).toBe(false)
    expect(argv.some(arg => arg.includes('developer_instructions'))).toBe(false)
  })

  it('keeps instructions byte-exact and replaces lone surrogates (valid TOML string)', () => {
    const text = 'a = "b"\n\t\\ ${HOME} \u0001 😀 \uD800 end'
    const value = override(codexArgv(input({ instructions: text })), 'developer_instructions')
    expect(value).toBe('a = "b"\n\t\\ ${HOME} \u0001 😀 \uFFFD end')
  })

  it('writes the task to stdin and closes it', () => {
    const session = codexAdapter.createSession(input(), 'n')
    const write = vi.fn()
    const end = vi.fn()
    session.start({ write, end })
    expect(write).toHaveBeenCalledWith('fix the bug ✓')
    expect(end).toHaveBeenCalledOnce()
    expect(session.cancel).toBeUndefined()
  })
})

describe('codex session on recorded transcripts', () => {
  it('basic run: answer, usage, the model-metadata warning item is ignored', () => {
    expect(replay('exec-basic.stdout.jsonl')).toEqual({
      status: 'completed',
      answer: 'HELLO_FROM_FAKE',
      usage: { inputTokens: 10, outputTokens: 5 },
    })
  })

  it('multi-message run: the last agent_message is the answer', () => {
    const outcome = replay('exec-multi-message.stdout.jsonl')
    expect(outcome.status).toBe('completed')
    expect(outcome.answer).toBe('FINAL_ANSWER_TEXT')
    expect(outcome.usage).toEqual({ inputTokens: 20, outputTokens: 10 })
  })

  it.each([
    ['golden-readonly.stdout.jsonl', 'REVIEW_RESULT: write was blocked'],
    ['golden-worker.stdout.jsonl', 'WORKER_DONE: created created.txt'],
    ['sandbox-readonly-write.stdout.jsonl', 'DONE_AFTER_TOOL'],
    ['sandbox-workspace-write.stdout.jsonl', 'DONE'],
  ])('%s completes with its final answer', (name, answer) => {
    expect(replay(name)).toMatchObject({ status: 'completed', answer })
  })

  it.each([
    ['err-400.stdout.jsonl', 'failed', 'model', { 'error code': 'model_not_found' }],
    ['err-401.stdout.jsonl', 'failed', 'auth', { 'http status': 401 }],
    ['auth-noconfig-nologin.stdout.jsonl', 'failed', 'auth', { 'http status': 401 }],
    ['auth-missing-envkey.stdout.jsonl', 'failed', 'auth', { reason: 'missing-api-key' }],
    ['err-429-quota.stdout.jsonl', 'failed', 'limit', {}],
    ['err-429-usage.stdout.jsonl', 'failed', 'limit', {}],
    ['err-429-rate.stdout.jsonl', 'failed', 'rate-limit', { 'http status': 429 }],
    ['err-500.stdout.jsonl', 'failed', 'service', {}],
    ['err-failed-server.stdout.jsonl', 'failed', 'transport', {}],
    ['err-failed-ctx.stdout.jsonl', 'max-tokens', 'max-tokens', {}],
  ])('%s → %s/%s without provider text', (name, status, category, facts) => {
    const outcome = replay(name, { code: 1 })
    expect(outcome).toEqual({ status, category, facts })
    const text = JSON.stringify(outcome)
    for (const leak of ['http://', 'https://', 'sk-', 'Unsupported', 'cf-ray', 'FAKE_API_KEY', 'chatgpt.com']) {
      expect(text).not.toContain(leak)
    }
  })

  it.each([
    ['cancel-SIGINT.stdout.jsonl', 1],
    // The launcher exits 0 after a forwarded SIGTERM: exit 0 without turn.completed is not a success.
    ['cancel-SIGTERM.stdout.jsonl', 0],
  ])('%s (no terminal event, exit %d) → cli-crashed', (name, code) => {
    expect(replay(name, { code })).toEqual({ status: 'failed', category: 'cli-crashed' })
  })

  it('turn.completed without an answer is an empty answer; a signal is a safe fact', () => {
    const session = codexAdapter.createSession(input(), 'n')
    session.line('{"type":"turn.started"}')
    session.line('{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"  "}}')
    session.line('{"type":"turn.completed","usage":{"input_tokens":"x","output_tokens":3}}')
    expect(session.finish(exit())).toEqual({
      status: 'failed',
      category: 'empty-answer',
      answer: '  ',
      usage: { outputTokens: 3 },
    })
    const killed = codexAdapter.createSession(input(), 'n')
    expect(killed.finish(exit({ code: null, signal: 'SIGKILL' }))).toEqual({
      status: 'failed',
      category: 'cli-crashed',
      facts: { signal: 'SIGKILL' },
    })
  })

  it('tolerates non-JSON lines, unknown events, malformed items and counts declined items', () => {
    const stream = new CodexStream()
    for (const line of [
      '',
      'Reading additional input from stdin...',
      '{not json',
      '[1,2]',
      'null',
      '{"type":"item.completed"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":7}}',
      '{"type":"future.event","x":1}',
      '{"type":"error","message":"Reconnecting... 1/5"}',
      '{"type":"item.completed","item":{"type":"file_change","status":"declined"}}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}',
      '{"type":"turn.failed"}',
    ]) {
      stream.line(line)
    }
    expect(stream.finish(exit({ code: 1 }))).toEqual({
      status: 'failed',
      category: 'unknown',
      facts: {},
      answer: 'partial',
      deniedActions: 1,
    })
  })

  it.each([
    ['config-missing-home.stderr.txt', 'config'],
    ['config-bad-toml.stderr.txt', 'config'],
    ['exec-untrusted-nongit.stderr.txt', undefined],
  ])('stderr %s without a terminal event → %s', (name, category) => {
    expect(classifyStderr(fixture(name))).toBe(category)
    const session = codexAdapter.createSession(input(), 'n')
    expect(session.finish(exit({ code: 1, stderrTail: fixture(name) }))).toEqual({
      status: 'failed',
      category: category ?? 'cli-crashed',
    })
  })

  it('maps other known failure texts', () => {
    expect(classifyStderr('Error: Missing optional dependency @openai/codex-linux-x64')).toBe('cli-missing')
    expect(classifyFailure('unexpected status 403 Forbidden: nope, url: https://x')).toEqual({
      status: 'failed',
      category: 'auth',
      facts: { 'http status': 403 },
    })
    expect(classifyFailure('exceeded retry limit, last status: 502 Bad Gateway').category).toBe('service')
    expect(classifyFailure('unexpected status 404 Not Found').category).toBe('model')
    expect(classifyFailure('{"error":{"type":"invalid_request_error","param":"reasoning.effort"}}')).toEqual({
      status: 'failed',
      category: 'config',
      facts: {},
    })
    expect(classifyFailure('{"error":{"code":"context_length_exceeded","message":"timed out"}}').status).toBe(
      'max-tokens',
    )
    expect(classifyFailure('{"error":{"code":"Weird Code!","type":"x"}}')).toEqual({
      status: 'failed',
      category: 'unknown',
      facts: {},
    })
    expect(classifyFailure('something new').category).toBe('unknown')
  })
})

describe('codex through the engine (fake subprocess)', () => {
  it('replays a transcript: argv reaches spawn, stdin carries the task and is closed', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'rolesubagents-codex-ws-'))
    let stdin = ''
    const subprocess = fakeSubprocess({
      onRun: async process => {
        stdin = await process.stdinClosed
        process.stdout(fixture('exec-multi-message.stdout.jsonl'))
        process.exit(0)
      },
    })
    const run = await startExternalRun(
      {
        adapter: codexAdapter,
        input: input({ cwd: workspace }),
        settings: { envPassthrough: ['CODEX_API_KEY'] },
        timeoutMs: 60_000,
        signal: new AbortController().signal,
      },
      {
        subprocess: () => subprocess,
        logger: { info: vi.fn(), warn: vi.fn() },
        runs: new Set<SubagentRunPort>(),
        hostEnv: { HOME: workspace, PATH: '/usr/bin', CODEX_API_KEY: 'sk-test' },
      },
    )
    expect(await run.result).toEqual({
      output: [{ type: 'text', text: 'FINAL_ANSWER_TEXT' }],
      stopReason: 'completed',
    })
    expect(stdin).toBe('fix the bug ✓')
    const spec = subprocess.processes[0]?.spec
    expect(spec?.argv).toEqual(['/bin/codex', ...codexArgv(input({ cwd: workspace }))])
    expect(spec?.env?.CODEX_API_KEY).toBe('sk-test')
  })

  it('a failed turn yields a safe diagnostic', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'rolesubagents-codex-ws-'))
    const subprocess = fakeSubprocess({
      onRun: async process => {
        await process.stdinClosed
        process.stdout(fixture('err-401.stdout.jsonl'))
        process.exit(1)
      },
    })
    const run = await startExternalRun(
      {
        adapter: codexAdapter,
        input: input({ cwd: workspace }),
        settings: {},
        timeoutMs: 60_000,
        signal: new AbortController().signal,
      },
      {
        subprocess: () => subprocess,
        logger: { info: vi.fn(), warn: vi.fn() },
        runs: new Set<SubagentRunPort>(),
        hostEnv: { HOME: workspace, PATH: '/usr/bin' },
      },
    )
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic?.split('\n')[0]).toBe(
      'Subagent failure (CLI: Codex; category: auth; exit code: 1; http status: 401)',
    )
    expect(result.diagnostic).not.toMatch(/127\.0\.0\.1|sk-fake/)
  })
})

describe('codex probe', () => {
  const runs = (answers: Record<string, Partial<ProbeRun>>) => {
    const calls: string[][] = []
    const run: ProbeRunner = async argv => {
      calls.push([...argv])
      return { code: 0, stdout: '', stderr: '', timedOut: false, ...answers[argv.join(' ')] }
    }
    return { run, calls }
  }
  const signal = new AbortController().signal

  it('parses the version', () => {
    expect(parseVersion(fixture('version.stdout.txt'))).toBe('0.163.0')
    expect(parseVersion('something else')).toBeUndefined()
  })

  it('lists visible models with descriptor efforts only (no ultra)', () => {
    const models = parseDebugModels(fixture('debug-models.stdout.txt'))
    expect(models?.map(model => model.id)).toEqual([
      'gpt-6-astra',
      'gpt-6.1-sol',
      'gpt-6-sol',
      'gpt-6-luna',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
    ])
    expect(models?.[0]).toEqual({
      id: 'gpt-6-astra',
      name: 'GPT-6-Astra',
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    })
    expect(models?.find(model => model.id === 'gpt-5.5')?.efforts).toEqual(['low', 'medium', 'high', 'xhigh'])
    // The descriptor's static suggestions are exactly the visible catalog.
    expect(new Set(models?.map(model => model.id))).toEqual(new Set(CODEX.modelSuggestions))
    expect(parseDebugModels('{"models":[{"slug":""},{"slug":"x","supported_reasoning_levels":"no"},7]}')).toEqual([
      { id: 'x' },
    ])
    expect(parseDebugModels('not json')).toBeUndefined()
    expect(parseDebugModels('{"models":{}}')).toBeUndefined()
  })

  it('reports version, signed-in state and models', async () => {
    const { run, calls } = runs({
      '--version': { stdout: fixture('version.stdout.txt') },
      'login status': { code: 0, stderr: fixture('login-ok.stderr.txt') },
      'debug models': { stdout: fixture('debug-models.stdout.txt') },
    })
    const result = await codexAdapter.probe?.('/bin/codex', run, signal, {})
    expect(calls).toEqual([['--version'], ['login', 'status'], ['debug', 'models']])
    expect(result).toMatchObject({ cli: 'codex', found: true, version: '0.163.0', auth: 'ok' })
    expect(result?.models).toHaveLength(8)
    expect(JSON.stringify(result)).not.toContain('sk-')
  })

  it('not logged in → missing, unless CODEX_API_KEY is forwarded; failures → unknown/absent', async () => {
    const missing = runs({ 'login status': { code: 1, stderr: fixture('login-missing.stderr.txt') } })
    expect((await codexAdapter.probe?.('/bin/codex', missing.run, signal, {}))?.auth).toBe('missing')
    expect(
      (await codexAdapter.probe?.('/bin/codex', missing.run, signal, { envPassthrough: ['CODEX_API_KEY'] }))?.auth,
    ).toBe('ok')
    const broken = runs({
      '--version': { code: null, timedOut: true },
      'login status': { code: 2 },
      'debug models': { code: 1, stdout: '{"models":[]}' },
    })
    expect(await codexAdapter.probe?.('/bin/codex', broken.run, signal, {})).toEqual({
      cli: 'codex',
      found: true,
      auth: 'unknown',
    })
  })
})
