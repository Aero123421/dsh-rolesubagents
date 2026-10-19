/**
 * Incremental parser for `agy --output-format stream-json` (Antigravity CLI 1.4.x) and
 * the mapping of one run's end to a {@link RunOutcome}.
 *
 * Protocol (verified against the real binary, see tests/fixtures/cli/agy/):
 * - `{"event":"init",…}` once; `{"event":"step_update","step_update":{step_index, step_type, state, text_delta?}}`
 *   per step; `{"event":"result","result":{status:"SUCCESS"|"ERROR", response, error?, denied_actions?, usage}}`
 *   once at the end. Unknown events and step types are ignored.
 * - The answer is the text of the LAST non-empty `agent_response` step (text deltas accumulate per
 *   `step_index`); `result.response` concatenates every agent text, including preambles, so it is
 *   only a fallback when no step carried text.
 * - A tool the headless permission policy cannot prompt for is soft-denied: the turn ends with
 *   status SUCCESS, an empty response and `denied_actions`.
 * - Model/API failures exit 3 and print `AGY_ERROR: {json}` on stderr; only its `status`,
 *   `error_code`, `code_kind` and `retryable` fields are read.
 *
 * Raw CLI or provider text is only matched against fixed patterns here; it never becomes a fact.
 */

import type { FailureCategory, RunExit, RunOutcome } from '../../external/types.ts'

/** The terminal `result` event fields this parser uses. */
export interface AgyResult {
  readonly status: string
  readonly response: string
  /** Raw error text; matched against fixed patterns only, never forwarded. */
  readonly error: string
  readonly deniedActions: number
  readonly inputTokens?: number
  readonly outputTokens?: number
}

/** Fields read from the `AGY_ERROR:` stderr line. */
export interface AgyError {
  readonly status?: string
  readonly errorCode?: number
  readonly codeKind?: string
  readonly retryable?: boolean
}

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** A fact value is kept only when it is a short identifier-like token. */
const SAFE_TOKEN = /^[A-Za-z0-9_.:-]{1,64}$/

function token(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : undefined
}

/** Accumulates one run's stdout events. Never throws. */
export class AgyStreamParser {
  /** `agent_response` text per step index, in first-seen order. */
  readonly #steps = new Map<number, string>()
  #result: AgyResult | undefined

  /**
   * Feed one stdout line (without its newline). Non-JSON lines and unknown events are ignored.
   * @param text - one line.
   */
  line(text: string): void {
    const event = parseJson(text.trim())
    if (!isRecord(event)) return
    if (event.event === 'step_update' && isRecord(event.step_update)) this.#step(event.step_update)
    else if (event.event === 'result' && isRecord(event.result)) this.#terminal(event.result)
  }

  #step(step: Json): void {
    if (step.step_type !== 'agent_response' || typeof step.text_delta !== 'string') return
    const index = typeof step.step_index === 'number' ? step.step_index : -1
    this.#steps.set(index, (this.#steps.get(index) ?? '') + step.text_delta)
  }

  #terminal(result: Json): void {
    const usage = isRecord(result.usage) ? result.usage : {}
    const inputTokens = count(usage.input_tokens)
    const outputTokens = count(usage.output_tokens)
    this.#result = {
      status: typeof result.status === 'string' ? result.status : '',
      response: typeof result.response === 'string' ? result.response : '',
      error: typeof result.error === 'string' ? result.error : '',
      deniedActions: Array.isArray(result.denied_actions) ? result.denied_actions.length : 0,
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
    }
  }

  /** The terminal result, once seen. */
  get result(): AgyResult | undefined {
    return this.#result
  }

  /**
   * The final answer: the last non-empty `agent_response` step (one trailing newline removed),
   * else the result's `response` when no step carried text.
   */
  answer(): string | undefined {
    let last: string | undefined
    let index = Number.NEGATIVE_INFINITY
    for (const [step, text] of this.#steps) {
      if (text.trim() !== '' && step >= index) {
        last = text
        index = step
      }
    }
    if (last === undefined && this.#steps.size === 0 && this.#result?.response.trim()) last = this.#result.response
    return last?.replace(/\r?\n$/, '')
  }
}

/**
 * Read the last `AGY_ERROR: {json}` line of stderr.
 * @param stderr - the stderr tail.
 * @returns its safe fields, or undefined when there is none.
 */
export function parseAgyError(stderr: string): AgyError | undefined {
  const line = stderr
    .split(/\r?\n/)
    .reverse()
    .find(entry => entry.startsWith('AGY_ERROR: '))
  if (line === undefined) return undefined
  const data = parseJson(line.slice('AGY_ERROR: '.length))
  if (!isRecord(data)) return {}
  const status = token(data.status)
  const codeKind = token(data.code_kind)
  return {
    ...(status === undefined ? {} : { status }),
    ...(typeof data.error_code === 'number' && Number.isInteger(data.error_code) ? { errorCode: data.error_code } : {}),
    ...(codeKind === undefined ? {} : { codeKind }),
    ...(typeof data.retryable === 'boolean' ? { retryable: data.retryable } : {}),
  }
}

/**
 * Category of an HTTP status from the model API.
 * @param status - HTTP status code.
 * @returns the category.
 */
export function httpCategory(status: number): FailureCategory {
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'limit'
  if (status === 404) return 'model'
  if (status >= 500 && status <= 599) return 'service'
  return 'unknown'
}

/** Fixed patterns over agy's own error texts (verified wording of 1.4.2). */
const AUTH_TEXT =
  /authentication (?:required|failed)|please sign in|not signed in|GEMINI_API_KEY environment variable is not set|API key not valid/i
const MODEL_TEXT = /invalid model selection/i
const EFFORT_TEXT = /has no "[^"]*" effort/i
const AGENT_TEXT = /unknown agent/i
const STREAM_TEXT = /stream was interrupted/i
const HTTP_TEXT = /\bError (\d{3}),/

function textCategory(error: string): { category: FailureCategory; facts: Record<string, string | number> } {
  if (error.trim() === 'interrupted') return { category: 'unknown', facts: { reason: 'interrupted' } }
  if (MODEL_TEXT.test(error)) return { category: EFFORT_TEXT.test(error) ? 'config' : 'model', facts: {} }
  if (AGENT_TEXT.test(error)) return { category: 'config', facts: {} }
  if (AUTH_TEXT.test(error)) return { category: 'auth', facts: {} }
  if (STREAM_TEXT.test(error)) return { category: 'transport', facts: {} }
  const http = HTTP_TEXT.exec(error)
  if (http !== null) {
    const status = Number(http[1])
    return { category: httpCategory(status), facts: { 'http status': status } }
  }
  return { category: 'unknown', facts: {} }
}

function errorFacts(error: AgyError): Record<string, string | number> {
  return {
    ...(error.codeKind === 'http' && error.errorCode !== undefined ? { 'http status': error.errorCode } : {}),
    ...(error.codeKind !== 'http' && error.errorCode !== undefined ? { 'error code': error.errorCode } : {}),
    ...(error.status === undefined ? {} : { 'error status': error.status }),
    ...(error.retryable === undefined ? {} : { retryable: String(error.retryable) }),
  }
}

/**
 * Decide one run's outcome from the parsed stream and the exit facts.
 * @param parser - the run's parser after stdout drained.
 * @param exit - exit code/signal and the stderr tail.
 * @returns the outcome; `completed` only for exit 0 + status SUCCESS + no denied actions + an answer.
 */
export function agyOutcome(parser: AgyStreamParser, exit: Pick<RunExit, 'code' | 'stderrTail'>): RunOutcome {
  const result = parser.result
  const answer = parser.answer()
  const withAnswer = answer === undefined ? {} : { answer }
  const usage =
    result?.inputTokens === undefined && result?.outputTokens === undefined
      ? {}
      : {
          usage: {
            ...(result.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
            ...(result.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }),
          },
        }
  const denied = result !== undefined && result.deniedActions > 0 ? { deniedActions: result.deniedActions } : {}
  const failed = (category: FailureCategory, facts: Record<string, string | number> = {}): RunOutcome => ({
    status: 'failed',
    category,
    ...withAnswer,
    ...usage,
    ...denied,
    ...(Object.keys(facts).length > 0 ? { facts } : {}),
  })

  // A model/API failure: the AGY_ERROR line is the most precise source.
  const agyError = parseAgyError(exit.stderrTail)
  if (agyError !== undefined) {
    const category =
      agyError.codeKind === 'http' && agyError.errorCode !== undefined
        ? httpCategory(agyError.errorCode)
        : agyError.codeKind === 'grpc'
          ? 'transport'
          : 'unknown'
    return failed(category, errorFacts(agyError))
  }
  if (result === undefined) {
    // agy prints sign-in failures before any event in some setups; the text is matched, never forwarded.
    return failed(AUTH_TEXT.test(exit.stderrTail) ? 'auth' : 'cli-crashed')
  }
  if (result.status === 'SUCCESS') {
    if (result.deniedActions > 0) return failed('permission', { 'denied actions': result.deniedActions })
    if (answer === undefined) return failed('empty-answer')
    if (exit.code !== 0) return failed('unknown', { 'result status': 'SUCCESS' })
    return { status: 'completed', answer, ...usage }
  }
  const { category, facts } = textCategory(result.error)
  return failed(category, { 'result status': token(result.status) ?? 'unknown', ...facts })
}
