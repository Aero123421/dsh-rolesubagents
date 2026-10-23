/** Pi 1.3 RPC lifecycle. Acceptance/agent_end are NOT completion; agent_settled is. */
import type { FailureCategory, RunExit, RunOutcome, RunSession, SessionIO } from '../../external/types.ts'

type Json = Record<string, unknown>
function record(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
function errorCategory(text: string): FailureCategory {
  if (/\b401\b|\b403\b|authenticat|api.?key|not logged in/i.test(text)) return 'auth'
  if (/\b429\b|rate.?limit/i.test(text)) return 'rate-limit'
  if (/\b5\d\d\b|overloaded|unavailable/i.test(text)) return 'service'
  if (/model.*(?:not found|unknown|invalid)|\b404\b/i.test(text)) return 'model'
  if (/permission|denied|not allowed/i.test(text)) return 'permission'
  if (/connect|network|socket|fetch failed/i.test(text)) return 'transport'
  return 'unknown'
}

export class PiSession implements RunSession {
  readonly #task: string
  readonly #id: string
  #io: SessionIO | undefined
  #accepted = false
  #settled = false
  #aborted = false
  #cancelling = false
  #closed = false
  #answer = ''
  #stop = ''
  #failure: FailureCategory | undefined
  #reason: string | undefined
  #denied = 0
  #usage: RunOutcome['usage']

  constructor(task: string, nonce: string) {
    this.#task = task
    this.#id = `dsh-${nonce}`
  }
  #send(type: string, extra: Json = {}): void {
    if (!this.#closed) this.#io?.write(`${JSON.stringify({ id: `${this.#id}-${type}`, type, ...extra })}\n`)
  }
  #end(): void {
    if (!this.#closed) {
      this.#closed = true
      this.#io?.end()
    }
  }
  start(io: SessionIO): void {
    this.#io = io
    this.#send('prompt', { message: this.#task })
  }
  cancel(): void {
    if (this.#cancelling || this.#closed) return
    this.#cancelling = true
    // Pi's abort alone can continue queued follow-ups. Clear before abort, awaiting each reply.
    this.#send('clear_queue')
  }
  line(text: string): void {
    let event: unknown
    try {
      event = JSON.parse(text)
    } catch {
      return
    }
    if (!record(event) || this.#closed) return
    if (event.type === 'response') {
      if (event.id === `${this.#id}-clear_queue` && this.#cancelling) this.#send('abort')
      else if (event.id === `${this.#id}-abort` && this.#cancelling) this.#end()
      else if (event.id === `${this.#id}-prompt`) {
        if (event.success !== true) {
          this.#failure = errorCategory(typeof event.error === 'string' ? event.error : '')
          this.#reason = 'prompt-rejected'
          this.#end()
          return
        }
        const disposition = record(event.data) ? event.data.disposition : undefined
        if (disposition === 'handled') {
          // An extension consumed the prompt without an agent run. Never invent an answer or await forever.
          this.#failure = 'config'
          this.#reason = 'prompt-handled'
          this.cancel()
        } else if (disposition === 'started' || disposition === 'queued') {
          this.#accepted = true
          if (this.#settled && !this.#cancelling) this.#end()
        } else {
          this.#failure = 'config'
          this.#reason = 'unsupported-prompt-response'
          this.cancel()
        }
      }
      return
    }
    if (
      event.type === 'extension_ui_request' &&
      typeof event.id === 'string' &&
      ['select', 'confirm', 'input', 'editor'].includes(String(event.method))
    ) {
      this.#denied++
      this.#io?.write(`${JSON.stringify({ type: 'extension_ui_response', id: event.id, cancelled: true })}\n`)
      return
    }
    if (event.type === 'message_end' && record(event.message) && event.message.role === 'assistant') {
      const message = event.message
      this.#answer = Array.isArray(message.content)
        ? message.content
            .filter(record)
            .filter(block => block.type === 'text' && typeof block.text === 'string')
            .map(block => block.text)
            .join('')
        : ''
      this.#stop = typeof message.stopReason === 'string' ? message.stopReason : ''
      // A later successful assistant response supersedes a retried provider error.
      if (this.#reason === undefined)
        this.#failure =
          this.#stop === 'error'
            ? errorCategory(typeof message.errorMessage === 'string' ? message.errorMessage : '')
            : undefined
      const usage = record(message.usage) ? message.usage : {}
      const input = count(usage.input)
      const output = count(usage.output)
      const cost = record(usage.cost) ? count(usage.cost.total) : undefined
      this.#usage = {
        ...(input === undefined
          ? {}
          : { inputTokens: input + (count(usage.cacheRead) ?? 0) + (count(usage.cacheWrite) ?? 0) }),
        ...(output === undefined ? {} : { outputTokens: output }),
        ...(cost === undefined ? {} : { costUsd: cost }),
      }
    } else if (event.type === 'agent_settled') {
      this.#settled = true
      this.#aborted = event.aborted === true
      if (this.#accepted && !this.#cancelling) this.#end()
    }
  }
  finish(exit: RunExit): RunOutcome {
    const answer = this.#answer.trim()
    const data = {
      ...(answer ? { answer } : {}),
      ...(this.#usage ? { usage: this.#usage } : {}),
      ...(this.#denied ? { deniedActions: this.#denied } : {}),
    }
    const fail = (category: FailureCategory, reason?: string): RunOutcome => ({
      status: 'failed',
      category,
      ...data,
      ...(reason ? { facts: { reason } } : {}),
    })
    if (exit.timedOut) return fail('timeout')
    if (exit.cancelled || this.#aborted) return fail('unknown', 'cancelled')
    if (this.#failure) return fail(this.#failure, this.#reason)
    if (exit.code !== 0 || exit.signal !== null) return fail('cli-crashed')
    if (!this.#accepted || !this.#settled) return fail('cli-crashed', 'missing-terminal')
    if (this.#denied) return fail('permission', 'interactive-request')
    if (this.#stop === 'length') return { status: 'max-tokens', category: 'max-tokens', ...data }
    if (this.#stop === 'aborted') return fail('unknown', 'cancelled')
    if (this.#stop !== 'stop') return fail('unknown', 'unknown-stop-reason')
    return answer ? { status: 'completed', ...data } : fail('empty-answer')
  }
}
