/**
 * OpenCode run session: a client for `opencode acp` (Agent Client Protocol,
 * JSON-RPC 2.0 as NDJSON over stdio), one prompt per process.
 *
 * Flow (verified against opencode 1.19.3, see DESIGN §5.4):
 *   initialize → session/new {cwd, mcpServers: []} → session/set_config_option model
 *   → mode (the generated agent) → effort (only when set) → session/prompt → end stdin.
 * Each request waits for its response before the next one is written. While the prompt
 * runs, `agent_message_chunk` text is collected per `messageId`; every step of a turn is
 * its own message, so the final answer is the text of the LAST message id.
 * Agent→client requests: `session/request_permission` is always answered with a reject
 * option (the permission profile already decided what is allowed); anything else gets
 * JSON-RPC error -32601 (the client advertises no fs/terminal capabilities).
 *
 * Errors are JSON-RPC error responses. Their message is provider text and never leaves
 * this file: only a {@link FailureCategory}, the error class name (when identifier-shaped)
 * and an HTTP status number become facts.
 */

import type { FailureCategory, PlanInput, RunExit, RunOutcome, RunSession, SessionIO } from '../../external/types.ts'

/** The ACP protocol version this client speaks. */
export const ACP_PROTOCOL_VERSION = 1

/** JSON-RPC "method not found". */
const METHOD_NOT_FOUND = -32601

/** Steps of the request sequence, in order. */
type Step = 'initialize' | 'session' | 'model' | 'mode' | 'effort' | 'prompt'

/** Fact value naming the step a failure happened in (fixed vocabulary). */
const STEP_FACT: Readonly<Record<Step, string>> = Object.freeze({
  initialize: 'initialize',
  session: 'session-new',
  model: 'set-model',
  mode: 'set-mode',
  effort: 'set-effort',
  prompt: 'prompt',
})

/** What a session needs besides the plan input. */
export interface OpencodeSessionOptions {
  /** `<provider>/<model>`. */
  readonly model: string
  /** Name of the generated agent (the ACP `mode`). */
  readonly agent: string
  /** Effort variant, when set. */
  readonly effort?: string
}

/** A classified JSON-RPC error: category plus safe facts. */
export interface ClassifiedError {
  readonly category: FailureCategory
  readonly facts: Readonly<Record<string, string | number>>
}

type Json = Record<string, unknown>

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parse(text: string): Json | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const value: unknown = JSON.parse(trimmed)
    return isRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function hasId(message: Json): boolean {
  return typeof message.id === 'number' || typeof message.id === 'string'
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Error class names opencode reports in `error.data.errorName` that are safe to show as a fact. */
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,47}Error$/

/**
 * Classify a JSON-RPC error response from `opencode acp`. Only fixed keywords are looked for in
 * the message; the message itself is never returned.
 * @param error - the response's `error` member.
 * @param step - which request failed.
 * @returns category and safe facts.
 */
export function classifyRpcError(error: unknown, step: Step): ClassifiedError {
  const record = isRecord(error) ? error : {}
  const message = typeof record.message === 'string' ? record.message : ''
  const data = isRecord(record.data) ? record.data : {}
  const errorName = typeof data.errorName === 'string' ? data.errorName : ''
  const lower = message.toLowerCase()
  const facts: Record<string, string | number> = { step: STEP_FACT[step] }
  if (ERROR_NAME.test(errorName)) facts['error name'] = errorName
  // opencode puts the provider's status into the message of an APIError; only the number is kept.
  const statusMatch = errorName === 'APIError' ? /\b([45]\d\d)\b/.exec(message) : null
  const status = statusMatch === null ? undefined : Number(statusMatch[1])
  if (status !== undefined) facts['http status'] = status

  const category = ((): FailureCategory => {
    if (/mode not found|agent not found|effort not found|variant not found/.test(lower)) return 'config'
    if (errorName === 'ProviderModelNotFoundError' || /model not found|provider not found/.test(lower)) return 'model'
    // A rejected configuration step without a recognised message.
    if (step === 'model') return 'model'
    if (step === 'mode' || step === 'effort') return 'config'
    if (errorName === 'ProviderAuthError') return 'auth'
    if (
      errorName === 'ContextOverflowError' ||
      /context (length|window)|too many tokens|prompt is too long/.test(lower)
    ) {
      return 'max-tokens'
    }
    if (status !== undefined) {
      if (status === 401 || status === 403) return 'auth'
      if (status === 429) return 'limit'
      if (status === 404) return 'model'
      if (status >= 500) return 'service'
      return 'unknown'
    }
    if (/econnrefused|enotfound|etimedout|econnreset|unable to connect|fetch failed|network|socket/.test(lower)) {
      return 'transport'
    }
    if (/api key|unauthorized|authentication|not authenticated|credential/.test(lower)) return 'auth'
    return 'unknown'
  })()
  return { category, facts }
}

/**
 * Create the ACP state machine for one run.
 * @param input - the plan input (cwd and task are used).
 * @param options - model, agent name and effort.
 * @returns a session that never throws.
 */
export function createOpencodeSession(input: PlanInput, options: OpencodeSessionOptions): RunSession {
  let io: SessionIO | undefined
  let nextId = 0
  /** Our outstanding requests: id → step. */
  const pending = new Map<number, Step>()
  let sessionId: string | undefined
  let cancelled = false
  let ended = false
  let failure: ClassifiedError | undefined
  let promptResult: Json | undefined
  /** Text per message id; `lastMessageId` names the latest message (each step of a turn is its own). */
  const texts = new Map<string, string>()
  let lastMessageId: string | undefined
  let rejected = 0

  const send = (message: Json): void => {
    if (ended) return
    io?.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  }
  const end = (): void => {
    ended = true
    io?.end()
  }
  const request = (step: Step, method: string, params: Json): void => {
    if (ended) return
    nextId += 1
    pending.set(nextId, step)
    send({ id: nextId, method, params })
  }
  const setOption = (step: Step, configId: string, value: string): void =>
    request(step, 'session/set_config_option', { sessionId, configId, value })

  const prompt = (): void =>
    request('prompt', 'session/prompt', { sessionId, prompt: [{ type: 'text', text: input.task }] })

  /** Write the request that follows a successful `step`. */
  const advance = (step: Step, result: Json): void => {
    if (cancelled) {
      end()
      return
    }
    switch (step) {
      case 'initialize':
        request('session', 'session/new', { cwd: input.cwd, mcpServers: [] })
        break
      case 'session':
        if (typeof result.sessionId === 'string' && result.sessionId !== '') {
          sessionId = result.sessionId
          setOption('model', 'model', options.model)
        } else {
          failure = { category: 'cli-crashed', facts: { step: STEP_FACT.session } }
          end()
        }
        break
      case 'model':
        setOption('mode', 'mode', options.agent)
        break
      case 'mode':
        if (options.effort === undefined) prompt()
        else setOption('effort', 'effort', options.effort)
        break
      case 'effort':
        prompt()
        break
      case 'prompt':
        promptResult = result
        end()
        break
    }
  }

  const onResponse = (message: Json): void => {
    const id = typeof message.id === 'number' ? message.id : Number.NaN
    const step = pending.get(id)
    if (step === undefined) return
    pending.delete(id)
    if (message.error !== undefined && message.error !== null) {
      if (!cancelled) failure ??= classifyRpcError(message.error, step)
      end()
      return
    }
    advance(step, isRecord(message.result) ? message.result : {})
  }

  const onRequest = (message: Json): void => {
    const id = message.id
    if (message.method === 'session/request_permission') {
      rejected += 1
      const params = isRecord(message.params) ? message.params : {}
      const optionsList = Array.isArray(params.options) ? params.options.filter(isRecord) : []
      const reject =
        optionsList.find(option => option.kind === 'reject_once') ??
        optionsList.find(option => typeof option.kind === 'string' && option.kind.startsWith('reject'))
      const outcome =
        reject !== undefined && typeof reject.optionId === 'string'
          ? { outcome: 'selected', optionId: reject.optionId }
          : { outcome: 'cancelled' }
      send({ id, result: { outcome } })
      return
    }
    send({ id, error: { code: METHOD_NOT_FOUND, message: 'Method not supported by this client' } })
  }

  const onNotification = (message: Json): void => {
    if (message.method !== 'session/update' || !isRecord(message.params)) return
    const update = message.params.update
    if (!isRecord(update) || update.sessionUpdate !== 'agent_message_chunk') return
    const content = update.content
    if (!isRecord(content) || content.type !== 'text' || typeof content.text !== 'string') return
    const messageId = typeof update.messageId === 'string' ? update.messageId : (lastMessageId ?? '')
    // A message id seen again moves to the end, so the last key is the latest message.
    const previous = texts.get(messageId) ?? ''
    texts.delete(messageId)
    texts.set(messageId, previous + content.text)
    lastMessageId = messageId
  }

  const answer = (): string | undefined => (lastMessageId === undefined ? undefined : texts.get(lastMessageId))

  return {
    start(stdio: SessionIO): void {
      io = stdio
      request('initialize', 'initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      })
    },

    line(text: string): void {
      const message = parse(text)
      if (message === undefined || message.jsonrpc !== '2.0') return
      const isCall = typeof message.method === 'string'
      if (isCall && hasId(message)) onRequest(message)
      else if (isCall) onNotification(message)
      else if (hasId(message)) onResponse(message)
    },

    cancel(): void {
      if (cancelled) return
      cancelled = true
      // A notification: opencode aborts the running turn and the prompt resolves with `cancelled`.
      if (sessionId !== undefined && !ended) send({ method: 'session/cancel', params: { sessionId } })
      // Closing stdin makes `opencode acp` stop running tools (whole process trees) and exit.
      end()
    },

    finish(exit: RunExit): RunOutcome {
      const text = answer()
      const partial = text === undefined || text.trim() === '' ? {} : { answer: text }
      const deniedActions = rejected > 0 ? { deniedActions: rejected } : {}
      if (failure !== undefined) {
        return { status: 'failed', category: failure.category, facts: failure.facts, ...partial, ...deniedActions }
      }
      if (promptResult === undefined) {
        const facts: Record<string, string | number> = {}
        const open = [...pending.values()].at(-1)
        if (open !== undefined) facts.step = STEP_FACT[open]
        if (exit.signal !== null && /^[A-Z0-9]{1,16}$/.test(exit.signal)) facts.signal = exit.signal
        return { status: 'failed', category: 'cli-crashed', facts, ...partial, ...deniedActions }
      }
      const usageRecord = isRecord(promptResult.usage) ? promptResult.usage : {}
      const inputTokens = finiteNumber(usageRecord.inputTokens)
      const outputTokens = finiteNumber(usageRecord.outputTokens)
      const usage =
        inputTokens === undefined && outputTokens === undefined
          ? {}
          : {
              usage: {
                ...(inputTokens === undefined ? {} : { inputTokens }),
                ...(outputTokens === undefined ? {} : { outputTokens }),
              },
            }
      const stopReason = typeof promptResult.stopReason === 'string' ? promptResult.stopReason : 'unknown'
      const reasonFact: Record<string, string> = /^[a-z_]{1,32}$/.test(stopReason) ? { 'stop reason': stopReason } : {}
      const common = { ...partial, ...usage, ...deniedActions }
      switch (stopReason) {
        case 'max_tokens':
          return { status: 'max-tokens', facts: reasonFact, ...common }
        case 'refusal':
          return { status: 'refusal', ...common }
        case 'max_turn_requests':
          return { status: 'failed', category: 'limit', facts: reasonFact, ...common }
        case 'cancelled':
          // Not requested by us (ours is reported as aborted by the engine).
          return { status: 'failed', category: 'unknown', facts: reasonFact, ...common }
        default:
          if (partial.answer !== undefined) return { status: 'completed', ...common }
          return {
            status: 'failed',
            category: rejected > 0 ? 'permission' : 'empty-answer',
            facts: reasonFact,
            ...common,
          }
      }
    },
  }
}
