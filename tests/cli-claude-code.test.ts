import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLAUDE_CODE_MODELS,
  claudeCodeAdapter,
  EDIT_TOOLS,
  permissionArgs,
  READ_ONLY_TOOLS,
  READ_ONLY_DISALLOWED_TOOLS,
} from '../src/host/cli/claude-code/index.ts'
import { ClaudeStreamParser, resultCategory } from '../src/host/cli/claude-code/parser.ts'
import { formatDiagnostic } from '../src/host/external/diagnostic.ts'
import { composeEnv } from '../src/host/external/env.ts'
import type { PlanInput, ProbeRunner, RunExit, RunOutcome } from '../src/host/external/types.ts'
import { CLAUDE_CODE } from '../src/shared/cli/claude-code.ts'
import type { AccessLevel } from '../src/shared/cli/index.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures/cli/claude-code')
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8')

const BASE_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--strict-mcp-config',
]

function input(patch: Partial<PlanInput> & { model?: string; effort?: string } = {}): PlanInput {
  const { model, effort, ...rest } = patch
  const preset = rest.preset ?? 'acceptEdits'
  return {
    runner: {
      cli: 'claude-code',
      permission: preset,
      ...(model === undefined ? {} : { model }),
      ...(effort === undefined ? {} : { effort }),
    },
    preset,
    access: rest.access ?? CLAUDE_CODE.permissions.find(p => p.id === preset)?.access ?? 'workspace-write',
    instructions: '',
    task: 'Do the task.',
    cwd: '/work',
    ...rest,
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

/** Feed a recorded transcript through a real session. */
function replay(name: string, exitPatch: Partial<RunExit> = {}): RunOutcome {
  const session = claudeCodeAdapter.createSession(input(), 'n')
  for (const line of fixture(name).split('\n')) session.line(line.replace(/\r$/, ''))
  return session.finish(exit(exitPatch))
}

describe('claude-code plan', () => {
  const presetArgs: Record<string, string[]> = {
    'read-only': [
      '--permission-mode',
      'dontAsk',
      '--setting-sources',
      '',
      '--tools',
      'Read,Glob,Grep,WebFetch,WebSearch',
      '--disallowedTools',
      'Write,Edit,NotebookEdit',
    ],
    acceptEdits: [
      '--permission-mode',
      'acceptEdits',
      '--setting-sources',
      '',
      '--tools',
      'Read,Glob,Grep,WebFetch,WebSearch,Edit,Write,NotebookEdit',
    ],
    auto: ['--permission-mode', 'auto'],
    bypassPermissions: ['--permission-mode', 'bypassPermissions'],
  }
  const variants: {
    name: string
    patch: { instructions?: string; model?: string; effort?: string }
    extra: string[]
  }[] = [
    { name: 'defaults', patch: {}, extra: [] },
    { name: 'model', patch: { model: 'sonnet' }, extra: ['--model', 'sonnet'] },
    { name: 'effort', patch: { effort: 'xhigh' }, extra: ['--effort', 'xhigh'] },
    {
      name: 'model + effort',
      patch: { model: 'claude-opus-5-5', effort: 'low' },
      extra: ['--model', 'claude-opus-5-5', '--effort', 'low'],
    },
  ]

  for (const preset of CLAUDE_CODE.permissions) {
    for (const variant of variants) {
      for (const instructions of ['', 'Your role: reviewer.\n- be strict']) {
        it(`${preset.id} / ${variant.name} / ${instructions === '' ? 'no instructions' : 'instructions'}`, () => {
          const plan = claudeCodeAdapter.plan(input({ preset: preset.id, ...variant.patch, instructions }), 'n')
          expect(plan.argv).toEqual([
            ...BASE_ARGS,
            ...variant.extra,
            ...(presetArgs[preset.id] as string[]),
            ...(instructions === '' ? [] : ['--append-system-prompt', instructions]),
          ])
          expect(plan.env).toEqual({
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            DISABLE_AUTOUPDATER: '1',
            CLAUDECODE: undefined,
          })
          expect(plan.envRemovePrefixes).toEqual(['CLAUDE_CODE_'])
          expect(plan.files).toBeUndefined()
          expect(plan.preflight).toBeUndefined()
          expect(plan.cancelGraceMs).toBe(0)
        })
      }
    }
  }

  it('never puts the task on the command line; it is written to stdin, which is then closed', () => {
    const task = '--model haiku and a very long task'
    const plan = claudeCodeAdapter.plan(input({ task }), 'n')
    expect(plan.argv).not.toContain(task)
    const writes: string[] = []
    let ended = 0
    claudeCodeAdapter.createSession(input({ task }), 'n').start({ write: t => writes.push(t), end: () => ended++ })
    expect(writes.join('')).toBe(task)
    expect(ended).toBe(1)
  })

  it('omits whitespace-only instructions and keeps a dash-leading value as one argument', () => {
    expect(claudeCodeAdapter.plan(input({ instructions: ' \n ' }), 'n').argv).not.toContain('--append-system-prompt')
    const argv = claudeCodeAdapter.plan(input({ instructions: '--model x' }), 'n').argv
    expect(argv.slice(-2)).toEqual(['--append-system-prompt', '--model x'])
  })

  it('fails closed: read-only access always gets the read-only arguments; unknown presets use their level', () => {
    const readOnly = [
      '--permission-mode',
      'dontAsk',
      '--setting-sources',
      '',
      '--tools',
      READ_ONLY_TOOLS,
      '--disallowedTools',
      READ_ONLY_DISALLOWED_TOOLS,
    ]
    expect(permissionArgs({ preset: 'bypassPermissions', access: 'read-only' })).toEqual(readOnly)
    const acceptEdits = ['--permission-mode', 'acceptEdits', '--setting-sources', '', '--tools', EDIT_TOOLS]
    // Neither restricted preset offers Bash.
    expect(READ_ONLY_TOOLS.split(',')).not.toContain('Bash')
    expect(EDIT_TOOLS.split(',')).not.toContain('Bash')
    expect(permissionArgs({ preset: 'plan', access: 'workspace-write' })).toEqual(acceptEdits)
    // A preset whose own level differs from the effective access is replaced by the access level's preset.
    expect(permissionArgs({ preset: 'bypassPermissions', access: 'workspace-write' })).toEqual(acceptEdits)
    // `auto` is full access (its classifier can approve any unsandboxed command): below that it becomes acceptEdits.
    expect(permissionArgs({ preset: 'auto', access: 'workspace-write' })).toEqual(acceptEdits)
    expect(permissionArgs({ preset: 'auto', access: 'full-access' })).toEqual(['--permission-mode', 'auto'])
    for (const access of ['read-only', 'workspace-write', 'full-access'] as AccessLevel[]) {
      expect(permissionArgs({ preset: 'nonsense', access })).toEqual(
        permissionArgs({ preset: CLAUDE_CODE.presetForAccess[access], access }),
      )
    }
  })

  it('removes inherited CLAUDE_CODE_* and CLAUDECODE, but a forwarded name and its own values win', () => {
    const plan = claudeCodeAdapter.plan(input(), 'n')
    const env = composeEnv({
      overlay: plan.env,
      removePrefixes: plan.envRemovePrefixes ?? [],
      passthrough: ['CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_API_KEY'],
      hostEnv: {
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_USE_BEDROCK: '1',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '0',
        ANTHROPIC_API_KEY: 'k',
        PATH: '/bin',
      },
    })
    expect(env).toEqual({
      CLAUDECODE: undefined,
      CODEX_SANDBOX: undefined,
      CODEX_SANDBOX_NETWORK_DISABLED: undefined,
      CLAUDE_CODE_ENTRYPOINT: undefined,
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      ANTHROPIC_API_KEY: 'k',
    })
  })
})

describe('claude-code session on recorded transcripts', () => {
  it('success: the result text is the answer, with usage and cost', () => {
    expect(replay('stream-json.success-text.jsonl')).toEqual({
      status: 'completed',
      answer: 'HELLO_FROM_FAKE',
      usage: { inputTokens: 11, outputTokens: 5, costUsd: 0.000144 },
    })
  })

  it.each([
    ['stream-json.tool-write-allowed-acceptEdits.jsonl', 'AFTER_TOOL_FINAL', undefined],
    ['stream-json.tool-write-denied-default.jsonl', 'AFTER_TOOL_FINAL', 1],
    ['stream-json.tool-write-denied-dontAsk.jsonl', 'AFTER_TOOL_FINAL', 1],
    ['stream-json.tool-write-denied-plan.jsonl', 'AFTER_TOOL_FINAL', 1],
    ['stream-json-io.can-use-tool-host-deny.jsonl', 'AFTER_DENY', 1],
    ['stream-json.readonly-dontAsk-bash-matrix.jsonl', 'F', 9],
    ['stream-json.hook-events-before-init.jsonl', 'SETTINGS_FINAL', undefined],
    ['stream-json.include-partial-messages.jsonl', 'FAKE_FINAL_ANSWER', undefined],
    ['stream-json.api-retry-events.jsonl', 'FAKE_DEFAULT_REPLY', undefined],
  ])('%s completes with its final answer and counts denials', (name, answer, denied) => {
    const outcome = replay(name)
    expect(outcome.status).toBe('completed')
    expect(outcome.answer).toBe(answer)
    expect(outcome.deniedActions).toBe(denied)
  })

  it('background tasks: the LAST result wins; tokens add up and cost is the cumulative total', () => {
    const bash = replay('stream-json.background-bash-two-results.jsonl')
    expect(bash).toMatchObject({ status: 'completed', answer: 'BG_DONE' })
    expect(bash.usage).toEqual({ inputTokens: 33, outputTokens: 15, costUsd: 0.000432 })
    const agent = replay('stream-json.background-subagent-two-results.jsonl')
    expect(agent).toMatchObject({ status: 'completed', answer: 'FAKE_DEFAULT_REPLY' })
  })

  it.each([
    ['stream-json.error-401-invalid-key.jsonl', 'auth', { 'terminal reason': 'api_error', 'http status': 401 }],
    ['stream-json.error-403.jsonl', 'auth', { 'terminal reason': 'api_error', 'http status': 403 }],
    ['stream-json.error-not-logged-in.jsonl', 'auth', { 'terminal reason': 'api_error' }],
    ['stream-json.error-404-model.jsonl', 'model', { 'terminal reason': 'api_error', 'http status': 404 }],
    ['stream-json.error-429.jsonl', 'limit', { 'terminal reason': 'api_error', 'http status': 429 }],
    ['stream-json.error-500.jsonl', 'service', { 'terminal reason': 'api_error', 'http status': 500 }],
    ['stream-json.error-529.jsonl', 'service', { 'terminal reason': 'api_error', 'http status': 529 }],
    ['stream-json.error-connection-refused.jsonl', 'transport', { 'terminal reason': 'api_error' }],
    ['stream-json.error-max-turns.jsonl', 'limit', { subtype: 'error_max_turns', 'terminal reason': 'max_turns' }],
    [
      'stream-json.error-max-budget.jsonl',
      'limit',
      { subtype: 'error_max_budget_usd', 'terminal reason': 'budget_exhausted' },
    ],
    [
      'stream-json.cancel-sigint-during-request.jsonl',
      'unknown',
      { subtype: 'error_during_execution', 'terminal reason': 'aborted_streaming' },
    ],
    [
      'stream-json.cancel-sigint-during-bash.jsonl',
      'unknown',
      { subtype: 'error_during_execution', 'terminal reason': 'aborted_tools' },
    ],
  ])('%s fails as %s with safe facts only', (name, category, facts) => {
    const outcome = replay(name, { code: 1 })
    expect(outcome.status).toBe('failed')
    expect(outcome.category).toBe(category)
    expect(outcome.facts).toEqual(facts)
    // The CLI's error text never becomes the answer (synthetic assistant messages are skipped).
    expect(outcome.answer).toBeUndefined()
    const diagnostic = formatDiagnostic('Claude Code', outcome.category ?? 'unknown', outcome.facts)
    expect(diagnostic).not.toMatch(/API Error|Invalid API key|login|fake|127\.0\.0\.1/i)
  })

  it('prompt too long is a max-tokens outcome', () => {
    expect(replay('stream-json.error-400-prompt-too-long.jsonl', { code: 1 })).toMatchObject({
      status: 'max-tokens',
      category: 'max-tokens',
      facts: { 'terminal reason': 'prompt_too_long', 'http status': 400 },
    })
  })

  it('no result (SIGTERM, model fallback cut short) is cli-crashed with the signal and last retry status', () => {
    expect(replay('stream-json.cancel-sigterm-during-request.jsonl', { code: null, signal: 'SIGTERM' })).toEqual({
      status: 'failed',
      category: 'cli-crashed',
      facts: { signal: 'SIGTERM' },
    })
    expect(replay('stream-json.model-fallback-partial.jsonl', { code: null, signal: 'SIGKILL' })).toMatchObject({
      status: 'failed',
      category: 'cli-crashed',
      facts: { signal: 'SIGKILL', 'http status': 529 },
    })
  })

  it('bypassPermissions refused as root maps to config with a fixed fact', () => {
    const session = claudeCodeAdapter.createSession(input({ preset: 'bypassPermissions' }), 'n')
    expect(session.finish(exit({ code: 1, stderrTail: fixture('stderr.bypass-as-root.txt') }))).toEqual({
      status: 'failed',
      category: 'config',
      facts: { reason: 'bypass-refused-as-root' },
    })
  })

  it('tolerates junk, partial results and blank answers', () => {
    const session = claudeCodeAdapter.createSession(input(), 'n')
    for (const line of [
      '',
      'not json',
      '{bad json',
      '[1,2]',
      'null',
      '{"type":"mystery","x":1}',
      '{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"partial"}]},"parent_tool_use_id":null}',
      '{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"sub"}]},"parent_tool_use_id":"t"}',
      '{"type":"result","subtype":"success","is_error":false,"result":"  "}',
    ]) {
      session.line(line)
    }
    expect(session.finish(exit())).toEqual({ status: 'failed', category: 'empty-answer' })
  })

  it('keeps the last top-level model text as a partial answer when no result arrives', () => {
    const session = claudeCodeAdapter.createSession(input(), 'n')
    session.line(
      '{"type":"assistant","message":{"model":"m","content":[{"type":"text","text":"half done"}]},"parent_tool_use_id":null}',
    )
    expect(session.finish(exit({ code: 1 }))).toEqual({
      status: 'failed',
      category: 'cli-crashed',
      facts: {},
      answer: 'half done',
    })
  })

  it('drops unsafe fact values', () => {
    const parser = new ClaudeStreamParser()
    parser.line(
      JSON.stringify({
        type: 'result',
        subtype: 'error weird text',
        is_error: true,
        terminal_reason: 'x y',
        usage: {},
      }),
    )
    expect(parser.finish(exit())).toEqual({ status: 'failed', category: 'unknown', facts: {} })
  })

  it('maps result fields to categories', () => {
    expect(resultCategory({ subtype: 'success', is_error: true, api_error_status: 400 })).toBe('config')
    expect(resultCategory({ subtype: 'success', is_error: true, api_error_status: 413 })).toBe('max-tokens')
    expect(resultCategory({ subtype: 'success', is_error: true, api_error_status: 418 })).toBe('unknown')
    expect(resultCategory({ subtype: 'success', is_error: true })).toBe('unknown')
    expect(resultCategory({ subtype: 'error_during_execution', is_error: true })).toBe('unknown')
  })
})

describe('claude-code probe', () => {
  const runner =
    (answer: { code: number | null; stdout?: string; timedOut?: boolean }, seen: string[][] = []): ProbeRunner =>
    async argv => {
      seen.push([...argv])
      return { code: answer.code, stdout: answer.stdout ?? '', stderr: '', timedOut: answer.timedOut ?? false }
    }
  const signal = new AbortController().signal

  it('reads the version and reports the static model list; sign-in stays unknown', async () => {
    const seen: string[][] = []
    const result = await claudeCodeAdapter.probe?.(
      '/bin/claude',
      runner({ code: 0, stdout: '2.1.303 (Claude Code)\n' }, seen),
      signal,
      {},
    )
    expect(seen).toEqual([['--version']])
    expect(result).toEqual({
      cli: 'claude-code',
      found: true,
      path: '/bin/claude',
      version: '2.1.303',
      auth: 'unknown',
      models: CLAUDE_CODE_MODELS,
    })
    expect(CLAUDE_CODE_MODELS.map(m => m.id).sort()).toEqual([...CLAUDE_CODE.modelSuggestions].sort())
  })

  it('reports an unreadable version or a timeout with a fixed word', async () => {
    expect(await claudeCodeAdapter.probe?.('/c', runner({ code: 1, stdout: 'oops' }), signal, {})).toMatchObject({
      message: 'version-unreadable',
    })
    expect(await claudeCodeAdapter.probe?.('/c', runner({ code: null, timedOut: true }), signal, {})).toMatchObject({
      message: 'version-timeout',
    })
  })
})
