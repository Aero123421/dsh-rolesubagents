// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Engine-owned RUN_DIR placeholders are literal.
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { grokBuildAdapter } from '../src/host/cli/grok-build/index.ts'
import { GrokStream } from '../src/host/cli/grok-build/parser.ts'
import type { PlanInput, ProbeRunner, RunExit } from '../src/host/external/types.ts'

const input: PlanInput = {
  runner: { cli: 'grok-build', permission: 'native', model: 'fake', effort: 'high' },
  preset: 'native',
  access: 'full-access',
  instructions: 'Your role: worker.',
  task: 'Unicode ✓\n--not-a-flag',
  cwd: '/work space',
}
const exit = (patch: Partial<RunExit> = {}): RunExit => ({
  code: 0,
  signal: null,
  stderrTail: '',
  cancelled: false,
  timedOut: false,
  ...patch,
})
function stream(...events: unknown[]) {
  const parser = new GrokStream()
  for (const event of events) parser.line(JSON.stringify(event))
  return parser
}
const text = (data: string) => ({ type: 'text', data })
const end = (stopReason = 'end_turn') => ({ type: 'end', stopReason })

describe('Grok native adapter', () => {
  it('preserves native configuration without widening permissions or argv-interpolating task', () => {
    const plan = grokBuildAdapter.plan(input, 'abc')
    expect(plan.argv).toEqual([
      '--output-format',
      'streaming-json',
      '--cwd',
      '/work space',
      '--prompt-file',
      '${RUN_DIR}/grok-task.txt',
      '--model',
      'fake',
      '--reasoning-effort',
      'high',
      '--rules',
      input.instructions,
    ])
    expect(Object.values(plan.files ?? {})).toEqual([input.task])
    expect(plan.env).toEqual({ GROK_DISABLE_AUTOUPDATER: '1' })
    expect(plan.envRemovePrefixes).toBeUndefined()
    expect(plan.preflight).toBeUndefined()
  })
  it.each(['read-only', 'workspace-write'] as const)('refuses unsupported %s at plan boundary', access => {
    expect(() => grokBuildAdapter.plan({ ...input, access }, 'abc')).toThrow('full-access')
  })
  it.each(['read-only', 'workspace', 'workspace-write'])(
    'does not advertise unverified official profile %s as a supported preset',
    preset => {
      expect(() =>
        grokBuildAdapter.plan({ ...input, preset, runner: { ...input.runner, permission: preset } }, 'abc'),
      ).toThrow('Grok native requires full-access')
    },
  )
  it('ends stdin without writing task or protocol commands', () => {
    const io = { write: vi.fn(), end: vi.fn() }
    grokBuildAdapter.createSession(input, 'abc').start(io)
    expect(io.write).not.toHaveBeenCalled()
    expect(io.end).toHaveBeenCalledOnce()
  })
  it('probes only version and never claims verified auth', async () => {
    const run = vi.fn<ProbeRunner>(async () => ({
      code: 0,
      stdout: 'grok 1.0.62 (abc) [stable]\n',
      stderr: '',
      timedOut: false,
    }))
    expect(await grokBuildAdapter.probe?.('/bin/grok', run, new AbortController().signal, {})).toEqual({
      cli: 'grok-build',
      found: true,
      version: '1.0.62',
      auth: 'unknown',
    })
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0]?.[0]).toEqual(['--version'])
  })
})

describe('Grok stream lifecycle', () => {
  it('maps real Grok 1.0.62 truncation error with nonzero exit to max-tokens', () => {
    const parser = new GrokStream()
    for (const line of readFileSync(new URL('./fixtures/cli/grok-build/length.ndjson', import.meta.url), 'utf8').split(
      '\n',
    ))
      parser.line(line)
    expect(parser.finish(exit({ code: 1 }))).toMatchObject({
      status: 'max-tokens',
      category: 'max-tokens',
      answer: 'GROK_FAKE_FINAL ✓',
    })
  })
  it('uses the last response, not thoughts, tool payloads, or intermediate text', () => {
    const parser = stream(
      text('Preamble'),
      { type: 'usage', stopReason: 'tool_use' },
      { type: 'tool_call', rawInput: { secret: 'private' } },
      { type: 'thought', data: 'private reasoning' },
      text('Final '),
      text('✓'),
      { type: 'usage' },
      end(),
    )
    expect(parser.finish(exit())).toMatchObject({ status: 'completed', answer: 'Final ✓' })
  })
  it('does not resurrect a preamble after an empty final response', () => {
    expect(stream(text('Preamble'), { type: 'usage' }, { type: 'usage' }, end()).finish(exit())).toMatchObject({
      status: 'failed',
      category: 'empty-answer',
    })
  })
  it('tolerates malformed/unrecognized events and ignores data after terminal', () => {
    const parser = stream({ type: 'auto_compact_start' }, text('ok'), end())
    parser.line('not-json')
    parser.line('null')
    parser.line('{')
    parser.line(JSON.stringify(text('later')))
    expect(parser.finish(exit()).answer).toBe('ok')
  })
  it('uses end aggregate usage only, with cached tokens and unknown cost omitted', () => {
    const result = stream(
      text('ok'),
      { type: 'usage', usage: { input_tokens: 9999 } },
      {
        ...end(),
        usage: { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 5 },
      },
    ).finish(exit())
    expect(result.usage).toEqual({ inputTokens: 15, outputTokens: 5 })
  })
  it.each([
    ['max_tokens', 'max-tokens', 'max-tokens'],
    ['refusal', 'refusal', 'permission'],
    ['max_turn_requests', 'failed', 'limit'],
    ['cancelled', 'failed', 'unknown'],
    ['future_reason', 'failed', 'unknown'],
  ])('maps %s stop reason', (reason, status, category) => {
    expect(stream(text('partial'), end(reason)).finish(exit())).toMatchObject({ status, category, answer: 'partial' })
  })
  it.each([
    ['401 secret-key', 'auth'],
    ['429 limited', 'rate-limit'],
    ['503 unavailable', 'service'],
    ['404 model', 'model'],
    ['permission denied', 'permission'],
    ['connection closed', 'transport'],
  ])('classifies errors without leaking %s', (message, category) => {
    const result = stream({ type: 'error', message }, end()).finish(exit())
    expect(result).toMatchObject({ status: 'failed', category })
    expect(JSON.stringify(result)).not.toContain(message)
  })
  it.each([{ code: 1 }, { signal: 'SIGTERM' }, { timedOut: true }, { cancelled: true }])(
    'never succeeds on abnormal exit %j',
    patch => {
      expect(stream(text('answer'), end()).finish(exit(patch)).status).toBe('failed')
    },
  )
  it('requires terminal even with exit zero and answer', () => {
    expect(stream(text('partial')).finish(exit())).toMatchObject({
      status: 'failed',
      facts: { reason: 'missing-terminal' },
    })
  })
})
