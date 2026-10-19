/**
 * Parsing for Codex CLI output (`codex exec --json` JSONL, probe commands).
 *
 * Event stream (Codex 0.163, verified against the real binary):
 * `thread.started`, `turn.started`, `item.started|updated|completed`, `error`,
 * then exactly one terminal event, `turn.completed` (with `usage`) or
 * `turn.failed` (with `error.message`). The final answer is the text of the
 * LAST completed `agent_message` item. `error` events and `error` items are
 * non-fatal warnings (reconnects, unknown model metadata). Without a terminal
 * event the run crashed (or was cancelled — the launcher exits 0 after a
 * forwarded SIGTERM, so exit 0 alone never means success).
 *
 * Failure messages are provider/CLI text that can echo request bodies (400)
 * or URLs (401); they are only matched against fixed patterns here and never
 * forwarded.
 */

import { CODEX } from '../../../shared/cli/codex.ts'
import type { FailureCategory, ProbeModel, RunExit, RunOutcome } from '../../external/types.ts'

/** A failure category plus the safe facts derived from a Codex error message. */
export interface CodexFailure {
  readonly status: 'failed' | 'max-tokens'
  readonly category: FailureCategory
  readonly facts: Readonly<Record<string, string | number>>
}

const SAFE_CODE = /^[a-z][a-z0-9_]{0,47}$/

function categoryOfStatus(status: number): FailureCategory {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'model'
  if (status === 408) return 'transport'
  if (status === 429) return 'rate-limit'
  if (status === 400 || status === 422) return 'config'
  if (status >= 500) return 'service'
  return 'unknown'
}

/**
 * Codex prints the provider's raw JSON body for most 4xx answers it does not
 * recognise (e.g. 400 `{"error":{"code":"model_not_found",...}}`). Read only
 * its `code`/`type`/`param` tokens.
 */
function classifyBody(message: string): CodexFailure | undefined {
  let body: unknown
  try {
    body = JSON.parse(message)
  } catch {
    return undefined
  }
  const error = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
  if (typeof error !== 'object' || error === null) return undefined
  const { code, type, param } = error as { code?: unknown; type?: unknown; param?: unknown }
  const facts: Record<string, string> = {}
  if (typeof code === 'string' && SAFE_CODE.test(code)) facts['error code'] = code
  const text = [code, type, param].filter(value => typeof value === 'string').join(' ')
  let category: FailureCategory = 'unknown'
  if (/model/i.test(text)) category = 'model'
  else if (/context_length|context_window/i.test(text)) return { status: 'max-tokens', category: 'max-tokens', facts }
  else if (/insufficient_quota|billing/i.test(text)) category = 'limit'
  else if (/rate_limit/i.test(text)) category = 'rate-limit'
  else if (/auth|api_key|permission/i.test(text)) category = 'auth'
  else if (/invalid_request|reasoning|unsupported/i.test(text)) category = 'config'
  else if (/server_error/i.test(text)) category = 'service'
  return { status: 'failed', category, facts }
}

/**
 * Map a `turn.failed` message to a category and safe facts.
 * @param message - `turn.failed.error.message` (untrusted provider text; never returned).
 * @returns the classification; unknown messages map to `unknown`.
 */
export function classifyFailure(message: string): CodexFailure {
  const failed = (category: FailureCategory, facts: Record<string, string | number> = {}): CodexFailure => ({
    status: 'failed',
    category,
    facts,
  })
  if (message.trimStart().startsWith('{')) return classifyBody(message) ?? failed('unknown')
  if (/Missing environment variable/i.test(message)) return failed('auth', { reason: 'missing-api-key' })
  if (/ran out of room in the model's context window|context window|context_length_exceeded/i.test(message)) {
    return { status: 'max-tokens', category: 'max-tokens', facts: {} }
  }
  if (/hit your usage limit|Quota exceeded|insufficient_quota/i.test(message)) return failed('limit')
  const retry = /exceeded retry limit, last status: (\d{3})/i.exec(message)
  if (retry !== null) {
    const status = Number(retry[1])
    return failed(categoryOfStatus(status), { 'http status': status })
  }
  const unexpected = /unexpected status (\d{3})/i.exec(message)
  if (unexpected !== null) {
    const status = Number(unexpected[1])
    return failed(categoryOfStatus(status), { 'http status': status })
  }
  if (/experiencing high demand|server_error|Internal server error/i.test(message)) return failed('service')
  if (/stream disconnected|error sending request|connection (refused|reset)|timed out|dns error/i.test(message)) {
    return failed('transport')
  }
  return failed('unknown')
}

/**
 * Map a crash's stderr (no terminal JSON event) to a category.
 * @param stderrTail - last bytes of stderr (never returned).
 * @returns a category when a known startup error is recognised.
 */
export function classifyStderr(stderrTail: string): FailureCategory | undefined {
  if (/Missing optional dependency @openai\/codex-/.test(stderrTail)) return 'cli-missing'
  if (/^Error (finding codex home|loading config)/m.test(stderrTail)) return 'config'
  if (/^error: (unexpected argument|invalid value|unrecognized)/im.test(stderrTail)) return 'config'
  return undefined
}

type Json = Record<string, unknown>

function record(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Incremental reader of one `codex exec --json` stream. Never throws. */
export class CodexStream {
  #answer: string | undefined
  #terminal: { kind: 'completed' } | { kind: 'failed'; message: string } | undefined
  #usage: RunOutcome['usage']
  #declined = 0

  /**
   * Feed one stdout line (non-JSON and unknown events are ignored).
   * @param text - the line without its ending.
   */
  line(text: string): void {
    if (!text.startsWith('{')) return
    let event: Json | undefined
    try {
      event = record(JSON.parse(text))
    } catch {
      return
    }
    if (event === undefined) return
    switch (event.type) {
      case 'item.completed': {
        const item = record(event.item)
        if (item === undefined) return
        if (item.type === 'agent_message' && typeof item.text === 'string') this.#answer = item.text
        if (item.status === 'declined') this.#declined++
        return
      }
      case 'turn.completed': {
        this.#terminal = { kind: 'completed' }
        const usage = record(event.usage)
        if (usage !== undefined) {
          const input = count(usage.input_tokens)
          const output = count(usage.output_tokens)
          this.#usage = {
            ...(input === undefined ? {} : { inputTokens: input }),
            ...(output === undefined ? {} : { outputTokens: output }),
          }
        }
        return
      }
      case 'turn.failed': {
        const message = record(event.error)?.message
        this.#terminal = { kind: 'failed', message: typeof message === 'string' ? message : '' }
        return
      }
      default:
      // thread.started, turn.started, item.started/updated, error (non-fatal), unknown future events.
    }
  }

  /**
   * Conclude the run.
   * @param exit - exit facts from the engine (cancellation/timeouts are applied by the engine on top).
   * @returns the outcome.
   */
  finish(exit: RunExit): RunOutcome {
    const answer = this.#answer
    const extra = {
      ...(answer === undefined ? {} : { answer }),
      ...(this.#usage === undefined ? {} : { usage: this.#usage }),
      ...(this.#declined === 0 ? {} : { deniedActions: this.#declined }),
    }
    const terminal = this.#terminal
    if (terminal?.kind === 'completed') {
      return answer !== undefined && answer.trim() !== ''
        ? { status: 'completed', ...extra }
        : { status: 'failed', category: 'empty-answer', ...extra }
    }
    if (terminal?.kind === 'failed') {
      const failure = classifyFailure(terminal.message)
      return { status: failure.status, category: failure.category, facts: failure.facts, ...extra }
    }
    const category = classifyStderr(exit.stderrTail) ?? 'cli-crashed'
    return {
      status: 'failed',
      category,
      ...extra,
      ...(exit.signal === null ? {} : { facts: { signal: exit.signal } }),
    }
  }
}

/**
 * Read the version from `codex --version` output.
 * @param stdout - the command's stdout.
 * @returns e.g. `0.163.0`, or undefined.
 */
export function parseVersion(stdout: string): string | undefined {
  const match = /^codex-cli (\S+)$/m.exec(stdout)
  return match?.[1]
}

/**
 * Read the model list from `codex debug models` JSON. Hidden models are skipped;
 * efforts are limited to the descriptor's list (so `ultra` is never offered).
 * @param stdout - the command's stdout.
 * @returns the models, or undefined when the output is not the expected JSON.
 */
export function parseDebugModels(stdout: string): ProbeModel[] | undefined {
  let data: unknown
  try {
    data = JSON.parse(stdout)
  } catch {
    return undefined
  }
  const models = record(data)?.models
  if (!Array.isArray(models)) return undefined
  const result: ProbeModel[] = []
  for (const entry of models) {
    const model = record(entry)
    if (model === undefined || typeof model.slug !== 'string' || model.slug === '') continue
    if (model.visibility === 'hide') continue
    const levels = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : []
    const efforts = levels
      .map(level => record(level)?.effort)
      .filter((effort): effort is string => typeof effort === 'string' && CODEX.efforts.includes(effort))
    result.push({
      id: model.slug,
      ...(typeof model.display_name === 'string' && model.display_name !== '' ? { name: model.display_name } : {}),
      ...(efforts.length === 0 ? {} : { efforts }),
    })
  }
  return result
}
