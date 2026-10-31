// biome-ignore-all lint/suspicious/noTemplateCurlyInString: run-plan placeholders are literal ${...} strings.
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  agentName,
  configObject,
  loadsProjectConfig,
  INSTRUCTIONS_FILE,
  OPENCODE_CANCEL_GRACE_MS,
  opencodeAdapter,
  PERMISSION_PROFILES,
  permissionProfile,
} from '../src/host/cli/opencode/index.ts'
import { classifyRpcError } from '../src/host/cli/opencode/parser.ts'
import { parseModels, parseVersion, probeOpencode } from '../src/host/cli/opencode/probe.ts'
import { formatDiagnostic } from '../src/host/external/diagnostic.ts'
import { jsonEnvText, startExternalRun, substituteLeaves } from '../src/host/external/engine.ts'
import type { PlanInput, ProbeRunner, RunExit } from '../src/host/external/types.ts'
import type { SubagentRunPort } from '../src/host/ports.ts'
import { OPENCODE } from '../src/shared/cli/opencode.ts'
import { fakeSubprocess } from './external-fakes.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures/cli/opencode')
const NONCE = 'abcdef012345'
const CWD = '/work/proj'

function input(patch: Partial<PlanInput> = {}, runner: Partial<PlanInput['runner']> = {}): PlanInput {
  return {
    runner: { cli: 'opencode', provider: 'fake', model: 'fake-model', permission: 'edit-files', ...runner },
    preset: 'edit-files',
    access: 'workspace-write',
    instructions: 'Your role: coder.',
    task: 'hello acp',
    cwd: CWD,
    ...patch,
  }
}

const EXIT: RunExit = { code: 0, signal: null, stderrTail: '', cancelled: false, timedOut: false }

/** Parse a recorded transcript: `>> ` lines were written by the client, `## cancel` marks a cancel. */
function transcript(name: string): { kind: 'client' | 'agent' | 'cancel'; text: string }[] {
  return readFileSync(join(FIXTURES, name), 'utf8')
    .split('\n')
    .filter(text => text !== '')
    .map(text =>
      text.startsWith('>> ')
        ? { kind: 'client' as const, text: text.slice(3) }
        : text === '## cancel'
          ? { kind: 'cancel' as const, text }
          : { kind: 'agent' as const, text },
    )
}

/**
 * Replay a recorded run through a fresh session: agent lines are fed in order and every line
 * the session writes must equal the recorded client line at that point.
 */
function replay(name: string, value: PlanInput = input(), exit: RunExit = EXIT) {
  const session = opencodeAdapter.createSession(value, NONCE)
  const writes: string[] = []
  let ended = false
  session.start({
    write: text => {
      if (!ended) writes.push(...text.split('\n').filter(part => part !== ''))
    },
    end: () => {
      ended = true
    },
  })
  const expected: string[] = []
  for (const entry of transcript(name)) {
    if (entry.kind === 'client') {
      expected.push(entry.text)
      expect(writes.slice(0, expected.length)).toEqual(expected)
    } else if (entry.kind === 'cancel') session.cancel?.()
    else session.line(entry.text)
  }
  expect(writes).toEqual(expected)
  return { outcome: session.finish(exit), writes, ended }
}

/** The config a run gets: the engine's envJson substitution and serialization. */
function substituted(config: unknown, runDir = '/run/dir'): Record<string, unknown> {
  const values = { RUN_DIR: runDir, HOME: '/home/u', SECRET: 's'.repeat(32) }
  return JSON.parse(jsonEnvText(substituteLeaves(config, values)))
}

describe('opencode plan', () => {
  it('runs `opencode acp` in the cwd with an isolated per-run configuration', () => {
    const plan = opencodeAdapter.plan(input(), NONCE)
    expect(plan.argv).toEqual(['acp', '--cwd', CWD, '--print-logs', '--log-level', 'WARN'])
    expect(plan.cancelGraceMs).toBe(OPENCODE_CANCEL_GRACE_MS)
    expect(plan.preflight).toBeUndefined()
    expect(plan.envJson).toEqual({ OPENCODE_CONFIG_CONTENT: configObject(input(), NONCE) })
    expect(plan.env).toEqual({
      OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      OPENCODE_DB: ':memory:',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_SERVER_PASSWORD: '${SECRET}',
      OPENCODE_SERVER_USERNAME: undefined,
      OPENCODE_PERMISSION: undefined,
      OPENCODE_AUTO_SHARE: undefined,
      PWD: CWD,
    })
    expect(plan.files).toEqual({ '${RUN_DIR}/role-instructions.md': 'Your role: coder.' })
  })

  it.each(['read-only', 'edit-files', 'full-access'])('builds the config for preset %s', preset => {
    const config = substituted(configObject(input({ preset }), NONCE))
    expect(config).toEqual({
      $schema: 'https://opencode.ai/config.json',
      autoupdate: false,
      share: 'disabled',
      snapshot: false,
      model: 'fake/fake-model',
      instructions: ['/run/dir/role-instructions.md'],
      agent: {
        title: { disable: true },
        'dsh-abcdef012345': {
          mode: 'primary',
          description: 'DSH delegated role',
          permission: PERMISSION_PROFILES[preset],
        },
      },
    })
  })

  it('omits instructions and their file when the role has none', () => {
    for (const instructions of ['', '  \n']) {
      const plan = opencodeAdapter.plan(input({ instructions }), NONCE)
      expect(plan.files).toBeUndefined()
      const config = substituted(plan.envJson?.OPENCODE_CONFIG_CONTENT)
      expect(config).not.toHaveProperty('instructions')
      expect(JSON.stringify(plan)).not.toContain('RUN_DIR')
    }
  })

  it('never puts the task or the effort into the plan (they travel over ACP)', () => {
    const plan = opencodeAdapter.plan(input({ task: 'SECRET TASK' }, { effort: 'high' }), NONCE)
    expect(JSON.stringify(plan)).not.toContain('SECRET TASK')
    expect(JSON.stringify(plan)).not.toContain('high')
  })

  it('keeps provider/model ids with slashes; data can form neither a placeholder nor an {env:} reference', () => {
    const value = input({}, { provider: 'openrouter', model: 'anthropic/x-${SECRET}{env:HOME}' })
    const json = jsonEnvText(substituteLeaves(configObject(value, NONCE), { RUN_DIR: '/r', HOME: '/h', SECRET: 'S' }))
    expect(json).not.toContain('$')
    expect(json).not.toContain('{env:')
    const config = JSON.parse(json)
    expect(config.model).toBe('openrouter/anthropic/x-${SECRET}{env:HOME}')
    expect(config.$schema).toBe('https://opencode.ai/config.json')
    expect(config.instructions).toEqual(['/r/role-instructions.md'])
  })

  it('keeps the config valid JSON for a run directory with backslashes or quotes', () => {
    for (const runDir of ['C:\\Users\\me\\AppData\\Local\\Temp\\dsh-x', '/tmp/a\\b"c']) {
      const config = substituted(configObject(input(), NONCE), runDir)
      expect(config.instructions).toEqual([`${runDir}/role-instructions.md`])
    }
  })

  it('loads the project config only at full access', () => {
    expect(loadsProjectConfig({ preset: 'full-access', access: 'full-access' })).toBe(true)
    for (const preset of ['read-only', 'edit-files', 'bogus']) {
      const plan = opencodeAdapter.plan(input({ preset }), NONCE)
      expect(plan.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('1')
    }
    const full = opencodeAdapter.plan(input({ preset: 'full-access', access: 'full-access' }), NONCE)
    expect(full.env).not.toHaveProperty('OPENCODE_DISABLE_PROJECT_CONFIG')
  })

  it('fails closed: unknown presets get the read-only profile; a missing model refuses the run', () => {
    expect(permissionProfile('bogus')).toBe(PERMISSION_PROFILES['read-only'])
    expect(() => opencodeAdapter.plan(input({}, { model: undefined }), NONCE)).toThrow(
      /^OpenCode roles need a provider and a model$/,
    )
    expect(() => opencodeAdapter.createSession(input({}, { provider: '' }), NONCE)).toThrow(/provider and a model/)
  })

  it('has a profile for every descriptor preset, with the documented tool sets', () => {
    for (const preset of OPENCODE.permissions) expect(PERMISSION_PROFILES[preset.id]).toBeDefined()
    const readOnly = PERMISSION_PROFILES['read-only'] as Record<string, unknown>
    expect(readOnly['*']).toBe('deny')
    expect(Object.values(readOnly).filter(rule => rule === 'allow')).toHaveLength(5)
    const edit = PERMISSION_PROFILES['edit-files'] as Record<string, unknown>
    expect(edit).toMatchObject({ '*': 'deny', edit: 'allow', bash: 'deny', external_directory: 'deny' })
    const full = PERMISSION_PROFILES['full-access'] as Record<string, unknown>
    expect(full).toMatchObject({ '*': 'allow', external_directory: 'deny', question: 'deny' })
    for (const profile of Object.values(PERMISSION_PROFILES)) {
      expect(profile.read).toEqual({ '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' })
    }
    expect(agentName(NONCE)).toBe('dsh-abcdef012345')
    expect(INSTRUCTIONS_FILE).toBe('${RUN_DIR}/role-instructions.md')
  })
})

describe('opencode session: recorded runs (opencode 1.19.3)', () => {
  it('answers a plain prompt', () => {
    const { outcome, ended, writes } = replay('acp-text.ndjson', input({ preset: 'edit-files' }))
    expect(outcome).toEqual({
      status: 'completed',
      answer: 'FAKE_FINAL: hello from the fake model',
      usage: { inputTokens: 11, outputTokens: 7 },
    })
    expect(ended).toBe(true)
    expect(writes.map(line => JSON.parse(line).method)).toEqual([
      'initialize',
      'session/new',
      'session/set_config_option',
      'session/set_config_option',
      'session/prompt',
    ])
    expect(JSON.parse(writes[1] as string).params).toEqual({ cwd: CWD, mcpServers: [] })
  })

  it('returns only the last message of a multi-step turn', () => {
    const { outcome } = replay(
      'acp-multistep.ndjson',
      input({ task: 'multi [[pretext]] [[tool:write {"filePath":"out.txt","content":"written\\n"}]]' }),
    )
    expect(outcome.status).toBe('completed')
    expect(outcome.answer).toBe('FAKE_FINAL after tool: Wrote file successfully.')
  })

  it('sets the effort after the mode when one is configured', () => {
    const { outcome, writes } = replay(
      'acp-effort.ndjson',
      input(
        { preset: 'read-only', task: 'hi [[reasoning]]', instructions: '' },
        { model: 'fake-reasoner', effort: 'high' },
      ),
    )
    expect(outcome.status).toBe('completed')
    const options = writes.map(line => JSON.parse(line).params).filter(params => params?.configId !== undefined)
    expect(options.map(params => [params.configId, params.value])).toEqual([
      ['model', 'fake/fake-reasoner'],
      ['mode', 'dsh-abcdef012345'],
      ['effort', 'high'],
    ])
  })

  it.each([
    [
      'acp-readonly-write.ndjson',
      'read-only',
      'write please [[tool:write {"filePath":"pwned.txt","content":"x"}]]',
      /unavailable tool/,
    ],
    [
      'acp-editfiles-bash.ndjson',
      'edit-files',
      'shell [[tool:bash {"command":"echo x > pwned.txt","description":"w"}]]',
      /unavailable tool/,
    ],
    [
      'acp-editfiles-external.ndjson',
      'edit-files',
      'outside [[tool:write {"filePath":"/tmp/oc-outside-pwned.txt","content":"x"}]]',
      /prevents you from using this specific tool call/,
    ],
    [
      'acp-full-bash.ndjson',
      'full-access',
      'shell [[tool:bash {"command":"echo hi > made.txt && echo done","description":"w"}]]',
      /^FAKE_FINAL after tool: done\n$/,
    ],
  ])('%s: tool results under preset %s come back as the answer', (name, preset, task, answer) => {
    const { outcome } = replay(
      name,
      input({ preset, task, instructions: preset === 'read-only' ? 'Your role: reviewer.' : '' }),
    )
    expect(outcome.status).toBe('completed')
    expect(outcome.answer).toMatch(answer)
  })

  it('rejects permission requests and reports a permission failure when nothing was answered', () => {
    const { outcome, writes } = replay(
      'acp-permission-reject.ndjson',
      input({
        preset: 'full-access',
        task: 'perm [[tool:bash {"command":"echo acp > acp.txt","description":"write"}]]',
        instructions: '',
      }),
    )
    expect(JSON.parse(writes.at(-1) as string)).toEqual({
      jsonrpc: '2.0',
      id: 0,
      result: { outcome: { outcome: 'selected', optionId: 'reject' } },
    })
    expect(outcome).toEqual({
      status: 'failed',
      category: 'permission',
      facts: { 'stop reason': 'end_turn' },
      usage: { inputTokens: 11, outputTokens: 7 },
      deniedActions: 1,
    })
  })

  it.each([
    ['acp-error-401.ndjson', 'x [[http:401]]', 'auth', 401],
    ['acp-error-429.ndjson', 'x [[http:429]]', 'limit', 429],
    ['acp-error-500.ndjson', 'x [[http:500]]', 'service', 500],
  ])('%s maps the provider error to %s without its text', (name, task, category, status) => {
    const { outcome } = replay(name, input({ preset: 'read-only', task, instructions: '' }))
    expect(outcome).toEqual({
      status: 'failed',
      category,
      facts: { step: 'prompt', 'error name': 'APIError', 'http status': status },
    })
    const diagnostic = formatDiagnostic('OpenCode', category as 'auth', outcome.facts)
    expect(diagnostic).toContain(`category: ${category}; step: prompt; error name: APIError; http status: ${status}`)
    expect(JSON.stringify(outcome)).not.toMatch(/fake upstream/)
  })

  it.each([
    ['acp-bad-model.ndjson', { model: 'nope' }, 'model', 'set-model'],
    ['acp-nokey.ndjson', { provider: 'anthropic', model: 'claude-fable-5' }, 'model', 'set-model'],
    ['acp-bad-effort.ndjson', { effort: 'turbo' }, 'config', 'set-effort'],
  ])('%s fails the configuration step before prompting', (name, runner, category, step) => {
    const { outcome, writes, ended } = replay(
      name,
      input({ preset: 'read-only', task: 'hi', instructions: '' }, runner),
    )
    expect(outcome).toEqual({ status: 'failed', category, facts: { step } })
    expect(writes.some(line => line.includes('session/prompt'))).toBe(false)
    expect(ended).toBe(true)
  })

  it('cancels a running turn: session/cancel, then stdin EOF', () => {
    const task = 'cancel me [[tool:bash {"command":"sleep 324; echo finished","description":"long sleep"}]]'
    const { writes, ended } = replay('acp-cancel.ndjson', input({ preset: 'full-access', task, instructions: '' }), {
      ...EXIT,
      cancelled: true,
    })
    expect(JSON.parse(writes.at(-1) as string)).toEqual({
      jsonrpc: '2.0',
      method: 'session/cancel',
      params: { sessionId: 'ses_ead2dc8e7ffeEOsYr00emHRLJA' },
    })
    expect(ended).toBe(true)
  })
})

describe('opencode session: protocol edge cases', () => {
  function live(value: PlanInput = input()) {
    const session = opencodeAdapter.createSession(value, NONCE)
    const writes: Record<string, unknown>[] = []
    const io = { write: vi.fn((text: string) => writes.push(JSON.parse(text))), end: vi.fn() }
    session.start(io)
    const respond = (result: unknown): void => {
      const last = writes.at(-1) as { id: number }
      session.line(JSON.stringify({ jsonrpc: '2.0', id: last.id, result }))
    }
    const chunk = (messageId: string | undefined, text: string): void =>
      session.line(
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: 's',
            update: {
              sessionUpdate: 'agent_message_chunk',
              ...(messageId ? { messageId } : {}),
              content: { type: 'text', text },
            },
          },
        }),
      )
    const toPrompt = (): void => {
      respond({ protocolVersion: 1 })
      respond({ sessionId: 's' })
      respond({})
      respond({})
    }
    return { session, writes, io, respond, chunk, toPrompt }
  }

  it('tolerates noise, unknown events and stray responses', () => {
    const { session, writes, chunk, toPrompt, respond } = live()
    for (const noise of ['', 'Starting…', '[1, 2]', '{"broken"', '{"jsonrpc":"1.0","id":1,"result":{}}', 'null']) {
      session.line(noise)
    }
    session.line(JSON.stringify({ jsonrpc: '2.0', id: 99, result: {} }))
    session.line(
      JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'new_kind' } } }),
    )
    expect(writes).toHaveLength(1)
    toPrompt()
    chunk('m1', 'thinking out loud')
    session.line(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image' } } },
      }),
    )
    chunk('m2', 'final ')
    chunk(undefined, 'answer')
    respond({ stopReason: 'end_turn' })
    expect(session.finish(EXIT)).toEqual({ status: 'completed', answer: 'final answer' })
  })

  it('answers unknown agent requests with method-not-found and permission requests without reject options with cancelled', () => {
    const { session, writes } = live()
    session.line(
      JSON.stringify({ jsonrpc: '2.0', id: 'x1', method: 'fs/read_text_file', params: { path: '/etc/passwd' } }),
    )
    expect(writes.at(-1)).toEqual({
      jsonrpc: '2.0',
      id: 'x1',
      error: { code: -32601, message: 'Method not supported by this client' },
    })
    session.line(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'session/request_permission',
        params: { options: [{ optionId: 'ok', kind: 'allow_once' }] },
      }),
    )
    expect(writes.at(-1)).toEqual({ jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'cancelled' } } })
    session.line(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 8,
        method: 'session/request_permission',
        params: {
          options: [
            { optionId: 'always-no', kind: 'reject_always' },
            { optionId: 'no', kind: 'reject_once' },
          ],
        },
      }),
    )
    expect(writes.at(-1)).toEqual({
      jsonrpc: '2.0',
      id: 8,
      result: { outcome: { outcome: 'selected', optionId: 'no' } },
    })
  })

  it.each([
    ['max_tokens', { status: 'max-tokens', answer: 'partial', facts: { 'stop reason': 'max_tokens' } }],
    ['refusal', { status: 'refusal', answer: 'partial' }],
    [
      'max_turn_requests',
      { status: 'failed', category: 'limit', answer: 'partial', facts: { 'stop reason': 'max_turn_requests' } },
    ],
    ['cancelled', { status: 'failed', category: 'unknown', answer: 'partial', facts: { 'stop reason': 'cancelled' } }],
  ])('maps stop reason %s', (stopReason, expected) => {
    const { session, chunk, toPrompt, respond } = live()
    toPrompt()
    chunk('m', 'partial')
    respond({ stopReason })
    expect(session.finish(EXIT)).toEqual(expected)
  })

  it('reports an empty answer and a process that died before the prompt finished', () => {
    const empty = live()
    empty.toPrompt()
    empty.chunk('m', '   ')
    empty.respond({ stopReason: 'end_turn', usage: { inputTokens: -1, outputTokens: 'x' } })
    expect(empty.session.finish(EXIT)).toEqual({
      status: 'failed',
      category: 'empty-answer',
      facts: { 'stop reason': 'end_turn' },
    })
    const died = live()
    died.respond({})
    died.chunk('m', 'half')
    expect(died.session.finish({ ...EXIT, code: null, signal: 'SIGKILL' })).toEqual({
      status: 'failed',
      category: 'cli-crashed',
      facts: { step: 'session-new', signal: 'SIGKILL' },
      answer: 'half',
    })
    const silent = live()
    expect(silent.session.finish({ ...EXIT, code: 1 })).toEqual({
      status: 'failed',
      category: 'cli-crashed',
      facts: { step: 'initialize' },
    })
  })

  it('fails when session/new returns no session id', () => {
    const { session, respond, io, writes } = live()
    respond({})
    respond({ sessionId: 42 })
    expect(io.end).toHaveBeenCalled()
    expect(writes).toHaveLength(2)
    expect(session.finish(EXIT)).toEqual({ status: 'failed', category: 'cli-crashed', facts: { step: 'session-new' } })
  })

  it('cancel before a session exists only closes stdin; later responses write nothing', () => {
    const { session, io, writes, respond } = live()
    session.cancel?.()
    session.cancel?.()
    expect(io.end).toHaveBeenCalledTimes(1)
    respond({})
    expect(writes).toHaveLength(1)
    expect(io.write).toHaveBeenCalledTimes(1)
  })

  it('cancel during configuration stops before prompting', () => {
    const { session, io, writes, respond } = live()
    respond({})
    respond({ sessionId: 's' })
    session.cancel?.()
    expect(writes.at(-1)).toEqual({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: 's' } })
    expect(io.end).toHaveBeenCalled()
    respond({})
    expect(writes.filter(message => message.method === 'session/prompt')).toEqual([])
  })

  it('never throws on hostile input', () => {
    const { session } = live()
    const hostile = [
      '{"jsonrpc":"2.0","id":1,"error":null,"result":null}',
      '{"jsonrpc":"2.0","method":"session/update","params":null}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","messageId":5,"content":{"type":"text","text":7}}}}',
      '{"jsonrpc":"2.0","id":3,"method":"session/request_permission","params":{"options":"nope"}}',
      '{"jsonrpc":"2.0","id":2,"error":"boom"}',
    ]
    for (const text of hostile) expect(() => session.line(text)).not.toThrow()
    expect(() => session.finish(EXIT)).not.toThrow()
  })
})

describe('opencode error classification', () => {
  it.each([
    [
      { message: 'Internal error: boom 403', data: { errorName: 'APIError' } },
      'prompt',
      'auth',
      { 'http status': 403 },
    ],
    [
      { message: 'Internal error: Not Found 404', data: { errorName: 'APIError' } },
      'prompt',
      'model',
      { 'http status': 404 },
    ],
    [
      { message: 'Internal error: bad request 400', data: { errorName: 'APIError' } },
      'prompt',
      'unknown',
      { 'http status': 400 },
    ],
    [{ message: 'Internal error: x', data: { errorName: 'ProviderAuthError' } }, 'prompt', 'auth', {}],
    [{ message: 'Internal error: x', data: { errorName: 'ContextOverflowError' } }, 'prompt', 'max-tokens', {}],
    [
      { message: 'Internal error: Unable to connect. Is the computer able to access the url?' },
      'prompt',
      'transport',
      {},
    ],
    [{ message: 'Internal error: Missing API key' }, 'prompt', 'auth', {}],
    [{ message: 'Internal error: Unexpected server error' }, 'prompt', 'unknown', {}],
    [{ message: 'Invalid params: mode not found: dsh-x' }, 'mode', 'config', {}],
    [{ message: 'Invalid params' }, 'mode', 'config', {}],
    [{ message: 'Invalid params' }, 'model', 'model', {}],
    [{ message: 'Invalid params: model not found: a/b' }, 'prompt', 'model', {}],
    [{ message: 'Internal error: x', data: { errorName: 'ProviderModelNotFoundError' } }, 'prompt', 'model', {}],
    [{ message: 'status 500 but not an APIError' }, 'prompt', 'unknown', {}],
    ['not an object', 'initialize', 'unknown', {}],
  ] as const)('%j at step %s → %s', (error, step, category, extra) => {
    const result = classifyRpcError(error, step)
    expect(result.category).toBe(category)
    expect(result.facts).toMatchObject(extra)
    if (!('http status' in extra)) expect(result.facts).not.toHaveProperty('http status')
  })

  it('keeps only identifier-shaped error names', () => {
    expect(
      classifyRpcError({ message: '', data: { errorName: 'Bad name with spaces Error' } }, 'prompt').facts,
    ).toEqual({
      step: 'prompt',
    })
    expect(classifyRpcError({ message: '', data: { errorName: 'UnknownError' } }, 'initialize').facts).toEqual({
      step: 'initialize',
      'error name': 'UnknownError',
    })
  })
})

describe('opencode probe', () => {
  const version = readFileSync(join(FIXTURES, 'version.txt'), 'utf8')
  const verbose = readFileSync(join(FIXTURES, 'models-fake-verbose.txt'), 'utf8')

  it('parses the version line', () => {
    expect(parseVersion(version)).toBe('1.19.3')
    expect(parseVersion('v1.20.0-beta.1\n')).toBe('1.20.0-beta.1')
    expect(parseVersion('opencode is great')).toBeUndefined()
  })

  it('parses verbose and plain model lists', () => {
    expect(parseModels(verbose)).toEqual([
      { id: 'fake/fake-model', name: 'Fake Model' },
      { id: 'fake/fake-reasoner', name: 'Fake Reasoner', efforts: ['low', 'medium', 'high'] },
    ])
    expect(parseModels('opencode/big-pickle\nopenrouter/anthropic/claude-x\nopencode/big-pickle\n\n')).toEqual([
      { id: 'opencode/big-pickle' },
      { id: 'openrouter/anthropic/claude-x' },
    ])
    expect(parseModels('Error: something\n  at x\n')).toEqual([])
  })

  it('keeps ids from a verbose list cut off by the output limit', () => {
    const head = readFileSync(join(FIXTURES, 'models-anthropic-verbose-head.txt'), 'utf8')
    expect(parseModels(head)).toEqual([{ id: 'anthropic/claude-fable-5' }])
    expect(parseModels(`${verbose}anthropic/claude-cut`)).toHaveLength(2)
  })

  it('runs --version and models --verbose with a time box, no model call and auth unknown', async () => {
    const calls: { argv: readonly string[]; timeoutMs: number; env?: unknown }[] = []
    const run: ProbeRunner = async (argv, opts) => {
      calls.push({ argv, ...opts })
      return { code: 0, stdout: argv[0] === '--version' ? version : verbose, stderr: '', timedOut: false }
    }
    const result = await opencodeAdapter.probe?.('/bin/opencode', run, new AbortController().signal, {})
    expect(result).toEqual({
      cli: 'opencode',
      found: true,
      version: '1.19.3',
      auth: 'unknown',
      models: parseModels(verbose),
    })
    expect(calls.map(call => call.argv)).toEqual([['--version'], ['models', '--verbose']])
    for (const call of calls) {
      expect(call.timeoutMs).toBeLessThanOrEqual(30_000)
      expect(call.env).toMatchObject({ OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DB: ':memory:' })
    }
  })

  it('reports a failing or slow model listing with a fixed word', async () => {
    const failing: ProbeRunner = async argv =>
      argv[0] === '--version'
        ? { code: 1, stdout: 'garbage', stderr: 'boom', timedOut: false }
        : { code: null, stdout: '', stderr: '', timedOut: true }
    expect(await probeOpencode(failing, new AbortController().signal)).toEqual({
      cli: 'opencode',
      found: true,
      auth: 'unknown',
      message: 'models-timeout',
    })
    const broken: ProbeRunner = async () => ({ code: 1, stdout: '', stderr: 'Error: x', timedOut: false })
    expect((await probeOpencode(broken, new AbortController().signal)).message).toBe('models-unavailable')
  })
})

describe('opencode through the engine', () => {
  it('substitutes the run dir into the config, writes the instructions file and drives the ACP flow', async () => {
    const entries = transcript('acp-text.ndjson')
    let seenConfig: Record<string, unknown> | undefined
    let instructionsText: string | undefined
    const subprocess = fakeSubprocess({
      onRun: process => {
        const env = process.spec.env ?? {}
        const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT as string) as { instructions: string[] }
        seenConfig = config
        instructionsText = readFileSync(config.instructions[0] as string, 'utf8')
        // Replay: after each recorded client line arrives on stdin, emit the agent lines that follow it.
        let consumed = 0
        let index = 0
        const pump = (): void => {
          const written = process
            .stdinText()
            .split('\n')
            .filter(line => line !== '')
          while (index < entries.length) {
            const entry = entries[index] as (typeof entries)[number]
            if (entry.kind === 'client') {
              if (consumed >= written.length) break
              consumed++
            } else process.stdout(`${entry.text.replaceAll('/work/proj', workspace)}\n`)
            index++
          }
          if (process.stdinEnded) process.exit(0)
          else setTimeout(pump, 1)
        }
        pump()
      },
    })
    const workspace = mkdtempSync(join(tmpdir(), 'rolesubagents-opencode-ws-'))
    // Model a worktree root even when the executor's temp directory has an ancestor .git marker.
    mkdirSync(join(workspace, '.git'))
    const runs = new Set<SubagentRunPort>()
    const run = await startExternalRun(
      {
        adapter: opencodeAdapter,
        input: input({ cwd: workspace }),
        settings: {},
        timeoutMs: 60_000,
        signal: new AbortController().signal,
      },
      {
        subprocess: () => subprocess,
        logger: { info: vi.fn(), warn: vi.fn() },
        runs,
        hostEnv: { HOME: '/home/u', PATH: '/usr/bin', OPENCODE_PERMISSION: '{"*":"allow"}' },
        tmpDir: mkdtempSync(join(tmpdir(), 'rolesubagents-opencode-tmp-')),
        random: { nonce: () => NONCE, secret: () => 'f'.repeat(32), id: () => 'run-1' },
      },
    )
    const result = await run.result
    expect(result).toEqual({
      output: [{ type: 'text', text: 'FAKE_FINAL: hello from the fake model' }],
      stopReason: 'completed',
    })
    const spec = subprocess.processes[0]?.spec
    expect(spec?.argv).toEqual(['/bin/opencode', 'acp', '--cwd', workspace, '--print-logs', '--log-level', 'WARN'])
    expect(spec?.env).toMatchObject({
      OPENCODE_SERVER_PASSWORD: 'f'.repeat(32),
      PWD: workspace,
      OPENCODE_PERMISSION: undefined,
    })
    expect(instructionsText).toBe('Your role: coder.')
    const file = (seenConfig?.instructions as string[] | undefined)?.[0]
    expect(file).toMatch(/role-instructions\.md$/)
    expect(file).not.toContain('$')
  })
})
