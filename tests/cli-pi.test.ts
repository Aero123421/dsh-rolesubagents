// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Engine-owned RUN_DIR placeholders are literal.
import { describe, expect, it, vi } from 'vitest'
import { piAdapter } from '../src/host/cli/pi/index.ts'
import { PiSession } from '../src/host/cli/pi/parser.ts'
import type { PlanInput, ProbeRunner, RunExit } from '../src/host/external/types.ts'

const input: PlanInput = {
  runner: { cli: 'pi', permission: 'native', model: 'fake/model', effort: 'high' },
  preset: 'native',
  access: 'full-access',
  instructions: 'Role: worker ✓',
  task: 'Task\n✓',
  cwd: '/work',
}
const exit = (patch: Partial<RunExit> = {}): RunExit => ({
  code: 0,
  signal: null,
  stderrTail: '',
  cancelled: false,
  timedOut: false,
  ...patch,
})
function setup() {
  const session = new PiSession(input.task, 'abc')
  const io = { write: vi.fn(), end: vi.fn() }
  session.start(io)
  const emit = (event: unknown) => session.line(JSON.stringify(event))
  const response = (command = 'prompt', data: unknown = { disposition: 'started' }, success = true) =>
    emit({ type: 'response', command, id: `dsh-abc-${command}`, success, data })
  const answer = (text = 'Final ✓', stopReason = 'stop', extra = {}) =>
    emit({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text }], stopReason, ...extra },
    })
  const settled = (aborted = false) => emit({ type: 'agent_settled', aborted })
  return { session, io, emit, response, answer, settled }
}

describe('Pi native plan and safe probe', () => {
  it('preserves native resources/auth and sends instructions through a private file', () => {
    const plan = piAdapter.plan(input, 'abc')
    expect(plan.argv).toEqual([
      '--mode',
      'rpc',
      '--no-session',
      '--model',
      'fake/model',
      '--thinking',
      'high',
      '--append-system-prompt',
      '${RUN_DIR}/pi-instructions.txt',
    ])
    expect(Object.values(plan.files ?? {})).toEqual([input.instructions])
    expect(plan.env).toEqual({ PI_SKIP_VERSION_CHECK: '1' })
    expect(plan.envRemovePrefixes).toBeUndefined()
    expect(plan.preflight).toBeUndefined()
    expect(plan.cancelGraceMs).toBe(5000)
  })
  it.each(['read-only', 'workspace-write'] as const)('refuses to silently adapt a native plan to %s access', access => {
    expect(() => piAdapter.plan({ ...input, access }, 'abc')).toThrow('full-access')
  })
  it('uses a distinct Host-confined workspace plan without replacing native RPC semantics', () => {
    const plan = piAdapter.plan(
      {
        ...input,
        preset: 'workspace-write',
        access: 'workspace-write',
        runner: { ...input.runner, permission: 'workspace-write' },
      },
      'abc',
    )
    expect(plan.privateState).toBe('pi')
    expect(plan.env.HOME).toBe('${RUN_DIR}/home')
    expect(plan.env.PI_CODING_AGENT_DIR).toBe('${RUN_DIR}/pi')
    expect(plan.argv).toEqual(piAdapter.plan(input, 'abc').argv)
    expect(piAdapter.descriptor.permissions.find(p => p.id === 'workspace-write')?.confinement).toBe('host-sandbox')
  })
  it('probes only early-exit version, not extension-loading help/models/auth commands', async () => {
    const run = vi.fn<ProbeRunner>(async () => ({ code: 0, stdout: '1.3.0\n', stderr: '', timedOut: false }))
    expect(await piAdapter.probe?.('/bin/pi', run, new AbortController().signal, {})).toEqual({
      cli: 'pi',
      found: true,
      version: '1.3.0',
      auth: 'unknown',
    })
    expect(run).toHaveBeenCalledOnce()
    expect(run.mock.calls[0]?.[0]).toEqual(['--version'])
  })
})

describe('Pi RPC lifecycle', () => {
  it('writes one correlated prompt and leaves stdin open until settled', () => {
    const { session, io, response, answer, settled, emit } = setup()
    expect(JSON.parse(io.write.mock.calls[0]?.[0])).toEqual({
      id: 'dsh-abc-prompt',
      type: 'prompt',
      message: input.task,
    })
    response()
    answer()
    emit({ type: 'agent_end', willRetry: false })
    expect(io.end).not.toHaveBeenCalled()
    expect(session.finish(exit()).status).toBe('failed')
    settled()
    expect(io.end).toHaveBeenCalledOnce()
    expect(session.finish(exit())).toMatchObject({ status: 'completed', answer: 'Final ✓' })
  })
  it('waits for authoritative acceptance even when events arrive early', () => {
    const { io, response, answer, settled, session } = setup()
    answer()
    settled()
    expect(io.end).not.toHaveBeenCalled()
    response()
    expect(io.end).toHaveBeenCalledOnce()
    expect(session.finish(exit()).status).toBe('completed')
  })
  it('ignores unrelated response ids and unknown/malformed lines', () => {
    const { session, emit, io } = setup()
    session.line('no json')
    session.line('null')
    session.line('{')
    emit({ type: 'response', id: 'other-prompt', success: false })
    emit({ type: 'extension_ui_request', id: 'notify', method: 'notify', message: 'notice' })
    expect(io.end).not.toHaveBeenCalled()
    expect(io.write).toHaveBeenCalledOnce()
  })
  it('waits through retries and uses only authoritative last assistant final message', () => {
    const { session, response, answer, settled, emit } = setup()
    response('prompt', { disposition: 'queued' })
    answer('retry partial', 'error', { errorMessage: '429 private-provider-info' })
    emit({ type: 'agent_end', willRetry: true })
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'duplicate' } })
    answer('final', 'stop', { usage: { input: 10, cacheRead: 2, cacheWrite: 3, output: 4 } })
    emit({
      type: 'message_end',
      message: { role: 'toolResult', content: [{ type: 'text', text: 'secret-tool-output' }] },
    })
    settled()
    expect(session.finish(exit())).toEqual({
      status: 'completed',
      answer: 'final',
      usage: { inputTokens: 15, outputTokens: 4 },
    })
  })
  it.each(['handled', 'future'])('terminates %s prompt without hanging or inventing success', disposition => {
    const { session, response, io, answer } = setup()
    response('prompt', { disposition })
    expect(JSON.parse(io.write.mock.calls.at(-1)?.[0]).type).toBe('clear_queue')
    response('clear_queue')
    expect(JSON.parse(io.write.mock.calls.at(-1)?.[0]).type).toBe('abort')
    answer('unrelated extension result')
    response('abort')
    expect(io.end).toHaveBeenCalledOnce()
    expect(session.finish(exit())).toMatchObject({ status: 'failed', category: 'config' })
  })
  it('clears queued work before abort; idempotent cancellation awaits abort ack', () => {
    const { session, io, response, settled } = setup()
    response()
    session.cancel()
    session.cancel()
    expect(io.write).toHaveBeenCalledTimes(2)
    settled(true)
    expect(io.end).not.toHaveBeenCalled()
    response('clear_queue', undefined, false)
    expect(JSON.parse(io.write.mock.calls.at(-1)?.[0]).type).toBe('abort')
    response('abort')
    expect(io.end).toHaveBeenCalledOnce()
    expect(session.finish(exit({ cancelled: true })).status).toBe('failed')
  })
  it.each(['select', 'confirm', 'input', 'editor'])(
    'cancels unsupported extension %s requests rather than approving',
    method => {
      const { session, io, response, emit, answer, settled } = setup()
      response()
      emit({ type: 'extension_ui_request', method, id: 'dialog-1', title: 'private' })
      expect(JSON.parse(io.write.mock.calls.at(-1)?.[0])).toEqual({
        type: 'extension_ui_response',
        id: 'dialog-1',
        cancelled: true,
      })
      answer()
      settled()
      expect(session.finish(exit())).toMatchObject({ status: 'failed', category: 'permission', deniedActions: 1 })
    },
  )
  it.each([
    ['401 key', 'auth'],
    ['429 quota', 'rate-limit'],
    ['503 unavailable', 'service'],
    ['404 model', 'model'],
    ['permission denied', 'permission'],
    ['connection failed', 'transport'],
  ])('classifies final provider error %s without returning raw errors', (errorMessage, category) => {
    const { session, response, answer, settled } = setup()
    response()
    answer('', 'error', { errorMessage })
    settled()
    const outcome = session.finish(exit())
    expect(outcome).toMatchObject({ status: 'failed', category })
    expect(JSON.stringify(outcome)).not.toContain(errorMessage)
  })
  it('handles prompt preflight rejection without requiring settled', () => {
    const { session, emit, io } = setup()
    emit({ type: 'response', id: 'dsh-abc-prompt', command: 'prompt', success: false, error: '401 secret' })
    expect(io.end).toHaveBeenCalledOnce()
    expect(session.finish(exit())).toMatchObject({ status: 'failed', category: 'auth' })
  })
  it.each([
    ['length', 'max-tokens'],
    ['aborted', 'failed'],
    ['toolUse', 'failed'],
    ['future', 'failed'],
  ])('maps %s final reason', (stop, status) => {
    const { session, response, answer, settled } = setup()
    response()
    answer('partial', stop)
    settled()
    expect(session.finish(exit()).status).toBe(status)
  })
  it.each([{ code: 1 }, { signal: 'SIGTERM' }, { timedOut: true }, { cancelled: true }])(
    'abnormal exit wins over answer %j',
    patch => {
      const { session, response, answer, settled } = setup()
      response()
      answer()
      settled()
      expect(session.finish(exit(patch)).status).toBe('failed')
    },
  )
  it('empty final answer does not resurrect earlier assistant preamble', () => {
    const { session, response, answer, settled } = setup()
    response()
    answer('preamble', 'toolUse')
    answer('')
    settled()
    expect(session.finish(exit())).toMatchObject({ status: 'failed', category: 'empty-answer' })
  })
})
