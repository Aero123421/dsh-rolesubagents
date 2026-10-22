/** Grok 1.0.62 native streaming-json. `usage` separates responses; only `end` is terminal. */
import type { FailureCategory, RunExit, RunOutcome } from '../../external/types.ts'

type Json = Record<string, unknown>
function record(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}
function category(text: string): FailureCategory {
  if (/\b401\b|\b403\b|authenticat|api.?key|not logged in|sign in/i.test(text)) return 'auth'
  if (/\b429\b|rate.?limit/i.test(text)) return 'rate-limit'
  if (/\b5\d\d\b|overloaded|unavailable/i.test(text)) return 'service'
  if (/model.*(?:not found|unknown|invalid)|\b404\b/i.test(text)) return 'model'
  if (/permission|denied|not allowed/i.test(text)) return 'permission'
  if (/connect|network|socket|fetch failed/i.test(text)) return 'transport'
  return 'unknown'
}

export class GrokStream {
  #current = ''
  #last = ''
  #ended: Json | undefined
  #error: string | undefined
  #usage: RunOutcome['usage']
  line(text: string): void {
    let event: unknown
    try {
      event = JSON.parse(text)
    } catch {
      return
    }
    if (!record(event) || this.#ended !== undefined) return
    if (event.type === 'text' && typeof event.data === 'string') this.#current += event.data
    else if (event.type === 'usage') {
      // Even an empty last response supersedes an earlier preamble.
      this.#last = this.#current
      this.#current = ''
    } else if (event.type === 'error') {
      this.#error = typeof event.message === 'string' ? event.message : ''
    } else if (event.type === 'end') {
      this.#ended = event
      if (this.#current !== '') this.#last = this.#current
      const usage = record(event.usage) ? event.usage : {}
      const input = count(usage.input_tokens)
      const output = count(usage.output_tokens)
      const cost = count(event.total_cost_usd)
      this.#usage = {
        ...(input === undefined
          ? {}
          : {
              inputTokens:
                input + (count(usage.cache_read_input_tokens) ?? 0) + (count(usage.cache_creation_input_tokens) ?? 0),
            }),
        ...(output === undefined ? {} : { outputTokens: output }),
        ...(cost === undefined ? {} : { costUsd: cost }),
      }
    }
  }
  finish(exit: RunExit): RunOutcome {
    const answer = (this.#current || this.#last).trim()
    const data = { ...(answer ? { answer } : {}), ...(this.#usage ? { usage: this.#usage } : {}) }
    const fail = (failure: FailureCategory, reason?: string): RunOutcome => ({
      status: 'failed',
      category: failure,
      ...data,
      ...(reason ? { facts: { reason } } : {}),
    })
    if (exit.timedOut) return fail('timeout')
    if (exit.cancelled) return fail('unknown', 'cancelled')
    // Grok 1.0.62 Chat Completions emits error + exit 1 rather than end/max_tokens for length.
    if (this.#error !== undefined) {
      if (/max_tokens_truncation|response truncated by max_tokens/.test(this.#error)) {
        return { status: 'max-tokens', category: 'max-tokens', ...data }
      }
      return fail(category(this.#error))
    }
    if (!this.#ended) return fail(exit.stderrTail ? category(exit.stderrTail) : 'cli-crashed', 'missing-terminal')
    if (exit.code !== 0 || exit.signal !== null) return fail('cli-crashed')
    switch (this.#ended.stopReason) {
      case 'max_tokens':
        return { status: 'max-tokens', category: 'max-tokens', ...data }
      case 'refusal':
        return { status: 'refusal', category: 'permission', ...data }
      case 'cancelled':
        return fail('unknown', 'cancelled')
      case 'max_turn_requests':
        return fail('limit')
      case 'end_turn':
        return answer ? { status: 'completed', ...data } : fail('empty-answer')
      default:
        return fail('unknown', 'unknown-stop-reason')
    }
  }
}
