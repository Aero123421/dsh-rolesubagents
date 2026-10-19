/**
 * Incremental parser for `claude -p --output-format stream-json --verbose`.
 *
 * Claude Code prints one JSON object per line: `system/*` events (hooks may
 * come before `init`), `assistant` / `user` messages, `stream_event`s,
 * `rate_limit_event`s and finally a `result` event. Background tasks can make
 * the CLI run another turn after the first `result` and print a second one, so
 * the LAST `result` line decides the outcome. Errors (HTTP failures, missing
 * sign-in) arrive as `subtype: "success"` with `is_error: true`; limits and
 * interruptions use other subtypes. No `result` at all means the CLI crashed
 * or refused to start (e.g. `bypassPermissions` as root).
 *
 * Only fixed-vocabulary facts leave this module: HTTP status numbers, result
 * subtypes and terminal reasons when they are identifier-like. The CLI's error
 * text is used to pick a category but never copied into an outcome.
 */

import type { FailureCategory, RunExit, RunOutcome } from '../../external/types.ts'

/** The `result` fields the parser reads. */
interface ResultEvent {
  readonly subtype?: unknown
  readonly is_error?: unknown
  readonly result?: unknown
  readonly terminal_reason?: unknown
  readonly api_error_status?: unknown
  readonly total_cost_usd?: unknown
  readonly usage?: unknown
  readonly permission_denials?: unknown
}

/** Fact values must match the diagnostic's safe-text rule; anything else is dropped. */
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/

/** stderr of `--permission-mode bypassPermissions` started as root without `IS_SANDBOX=1`. */
const ROOT_REFUSAL = /cannot be used with root\/sudo privileges/

/** Error texts of a missing or rejected sign-in when no HTTP status is reported. */
const AUTH_TEXT = /not logged in|\/login|invalid api key|failed to authenticate|oauth token/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function safeToken(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : undefined
}

/** Text blocks of one top-level, model-written assistant message. */
function assistantText(event: Record<string, unknown>): string | undefined {
  if (event.parent_tool_use_id !== null && event.parent_tool_use_id !== undefined) return undefined
  const message = event.message
  if (!isRecord(message) || message.model === '<synthetic>' || !Array.isArray(message.content)) return undefined
  const parts: string[] = []
  for (const block of message.content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  const text = parts.join('')
  return text.trim() === '' ? undefined : text
}

/**
 * Category of a failed `result`.
 * @param result - the last result event (not a success).
 * @returns the category; `max-tokens` means the prompt did not fit.
 */
export function resultCategory(result: ResultEvent): FailureCategory {
  switch (result.subtype) {
    case 'error_max_turns':
    case 'error_max_budget_usd':
      return 'limit'
    case 'success':
      break
    default:
      return 'unknown'
  }
  const status = finiteNumber(result.api_error_status)
  const text = typeof result.result === 'string' ? result.result : ''
  if (result.terminal_reason === 'prompt_too_long' || status === 413 || /prompt is too long/i.test(text)) {
    return 'max-tokens'
  }
  if (status !== undefined) {
    if (status === 401 || status === 403) return 'auth'
    if (status === 429) return 'limit'
    if (status === 404) return 'model'
    if (status === 400) return 'config'
    if (status >= 500) return 'service'
    return 'unknown'
  }
  if (AUTH_TEXT.test(text)) return 'auth'
  if (result.terminal_reason === 'api_error') return 'transport'
  return 'unknown'
}

/** Accumulated state of one run's stdout. */
export class ClaudeStreamParser {
  #result: ResultEvent | undefined
  #partial: string | undefined
  #retryStatus: number | undefined
  #inputTokens = 0
  #outputTokens = 0
  #sawUsage = false
  #costUsd: number | undefined
  readonly #denied = new Set<string>()
  #anonymousDenials = 0

  /**
   * Feed one stdout line. Non-JSON lines and unknown events are ignored.
   * @param text - the line without its line ending.
   */
  line(text: string): void {
    if (!text.startsWith('{')) return
    let event: unknown
    try {
      event = JSON.parse(text)
    } catch {
      return
    }
    if (!isRecord(event)) return
    switch (event.type) {
      case 'result':
        this.#onResult(event)
        break
      case 'assistant': {
        const answer = assistantText(event)
        if (answer !== undefined) this.#partial = answer
        break
      }
      case 'system':
        if (event.subtype === 'permission_denied') this.#deny(event.tool_use_id)
        else if (event.subtype === 'api_retry')
          this.#retryStatus = finiteNumber(event.error_status) ?? this.#retryStatus
        break
      default:
        break
    }
  }

  #deny(id: unknown): void {
    if (typeof id === 'string' && id !== '') this.#denied.add(id)
    else this.#anonymousDenials++
  }

  #onResult(event: ResultEvent): void {
    this.#result = event
    if (isRecord(event.usage)) {
      const input = finiteNumber(event.usage.input_tokens)
      const output = finiteNumber(event.usage.output_tokens)
      if (input !== undefined || output !== undefined) this.#sawUsage = true
      this.#inputTokens += input ?? 0
      this.#outputTokens += output ?? 0
    }
    // total_cost_usd is cumulative over the process; the latest value covers every turn.
    this.#costUsd = finiteNumber(event.total_cost_usd) ?? this.#costUsd
    if (Array.isArray(event.permission_denials)) {
      for (const denial of event.permission_denials) this.#deny(isRecord(denial) ? denial.tool_use_id : undefined)
    }
  }

  /**
   * Conclude the run.
   * @param exit - how the process ended.
   * @returns the outcome; failures carry only safe facts.
   */
  finish(exit: RunExit): RunOutcome {
    const common = {
      ...this.#usage(),
      ...(this.#denials() > 0 ? { deniedActions: this.#denials() } : {}),
    }
    const result = this.#result
    if (result === undefined) return { ...this.#withoutResult(exit), ...common }
    const success = result.subtype === 'success' && result.is_error !== true
    if (success) {
      const answer = typeof result.result === 'string' ? result.result : ''
      return answer.trim() === ''
        ? { status: 'failed', category: 'empty-answer', ...common }
        : { status: 'completed', answer, ...common }
    }
    const category = resultCategory(result)
    const status = finiteNumber(result.api_error_status)
    const facts: Record<string, string | number> = {}
    if (result.subtype !== 'success') {
      const subtype = safeToken(result.subtype)
      if (subtype !== undefined) facts.subtype = subtype
    }
    const reason = safeToken(result.terminal_reason)
    if (reason !== undefined) facts['terminal reason'] = reason
    if (status !== undefined) facts['http status'] = status
    return {
      status: category === 'max-tokens' ? 'max-tokens' : 'failed',
      category,
      facts,
      ...(this.#partial === undefined ? {} : { answer: this.#partial }),
      ...common,
    }
  }

  #withoutResult(exit: RunExit): RunOutcome {
    if (ROOT_REFUSAL.test(exit.stderrTail)) {
      return { status: 'failed', category: 'config', facts: { reason: 'bypass-refused-as-root' } }
    }
    const facts: Record<string, string | number> = {}
    const signal = safeToken(exit.signal)
    if (signal !== undefined) facts.signal = signal
    if (this.#retryStatus !== undefined) facts['http status'] = this.#retryStatus
    return {
      status: 'failed',
      category: 'cli-crashed',
      facts,
      ...(this.#partial === undefined ? {} : { answer: this.#partial }),
    }
  }

  #denials(): number {
    return this.#denied.size + this.#anonymousDenials
  }

  #usage(): Pick<RunOutcome, 'usage'> {
    if (!this.#sawUsage && this.#costUsd === undefined) return {}
    return {
      usage: {
        ...(this.#sawUsage ? { inputTokens: this.#inputTokens, outputTokens: this.#outputTokens } : {}),
        ...(this.#costUsd === undefined ? {} : { costUsd: this.#costUsd }),
      },
    }
  }
}
