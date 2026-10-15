/**
 * Read-only enforcement beyond the one-shot sandbox append.
 *
 * A read-only role keeps `sandbox/mode` at `read-only`. The per-agent guard
 * allows only known tool names, and only while the latest mode is `read-only`
 * and every re-pin has succeeded. A same-named tool registered closer than the
 * inherited host tool is refused. MCP hints are not consulted: DSH does not
 * copy `readOnlyHint` onto the registered tool.
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { RoleDefinition } from '../shared/roles.ts'
import type { SessionPort } from './ports.ts'

/** How many times one hold will re-append `read-only` if a nested writer undoes it. */
const REPIN_LIMIT = 8

const repinDepth = new Map<string, number>()

/**
 * Sessions whose re-pin failed. Every later tool call is refused.
 * The id is remembered as well as the object, so a new session object for the
 * same live id stays closed. {@link releasePinFailure} drops both when the
 * agent is disposed or the plugin unloads, so a later session is not stuck.
 */
const failedPins = new WeakSet<SessionPort>()
const failedPinIds = new Set<string>()

/**
 * Tools a read-only role may call while the sandbox is actually `read-only`.
 * Matching is exact. `query` and `fetch` are not permission to invent a name.
 */
export const ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'pwsh',
  'read',
  'read_image',
  'glob',
  'grep',
  'lsp',
  'web_search',
  'web_fetch',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
  'cordis_inspect_list',
  'cordis_inspect_query',
  'get_goal',
  'schedule_list',
  'session_event_read',
  'session_event_search',
  'session_event_trace',
  'session_search',
  'session_trace',
  'list_subagent_models',
  'list_agents',
  'job_list',
  'job_output',
  'ask_user_question',
  'skill',
  'team_task_get',
  'team_task_list',
  'wait_agent',
  'terminal_list',
  'terminal_read',
  // Nested calls re-enter this guard. The program itself is not name-classified.
  'run_code',
])

/**
 * Allowlisted names that can change files or reach the network when the sandbox
 * backend does not enforce `read-only`. {@link readOnlyCallDenial} allows them
 * only after it has required the live mode to be `read-only`.
 */
export const SANDBOX_ASSUMED_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'pwsh',
  'run_code',
  'web_fetch',
  'terminal_read',
])

for (const name of SANDBOX_ASSUMED_TOOLS) {
  if (!ALLOWED_TOOLS.has(name)) {
    throw new Error(`sandbox-assumed tool "${name}" is missing from the read-only allowlist`)
  }
}

/** Coordination tools allowed only when the destination agent is read-only. */
export const COORDINATION_TOOLS: ReadonlySet<string> = new Set(['send_message', 'interrupt_agent'])

/** Tokens that mark a name as a write even when a read-like token sits beside them. */
const WRITE_TOKENS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'delete',
  'remove',
  'rm',
  'create',
  'update',
  'set',
  'put',
  'patch',
  'post',
  'send',
  'exec',
  'execute',
  'run',
  'apply',
  'mutate',
  'upload',
  'insert',
  'append',
  'mkdir',
  'move',
  'rename',
  'commit',
  'push',
  'deploy',
  'publish',
  'install',
  'uninstall',
  'kill',
  'drop',
  'truncate',
  'grant',
  'revoke',
  'chmod',
  'chown',
  'submit',
  'save',
  'store',
  'open',
  'close',
  'signal',
  'act',
  'navigate',
  'replace',
  'add',
  'merge',
  'destroy',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function tokensOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length > 0)
}

function refuse(name: string, why: string): string {
  return `read-only role: \`${name}\` was refused (${why}). Do not retry it; report what should change instead.`
}

/**
 * Remember that this session could not be held at `read-only`.
 * @param session - the session whose re-pin failed.
 */
export function markPinFailed(session: SessionPort): void {
  failedPins.add(session)
  failedPinIds.add(session.id)
}

/**
 * Whether a re-pin has already failed for this session.
 * @param session - the session to test.
 * @returns true after {@link markPinFailed}.
 */
export function pinFailed(session: SessionPort): boolean {
  return failedPins.has(session) || failedPinIds.has(session.id)
}

/**
 * Forget a failed pin. Called when the agent is disposed or the plugin unloads,
 * so the id does not keep refusing a later session.
 * @param session - the session whose failure should be dropped.
 */
export function releasePinFailure(session: SessionPort): void {
  failedPins.delete(session)
  failedPinIds.delete(session.id)
}

/**
 * The mode carried by one `sandbox/mode` payload, if it is a string.
 * @param data - the event's `data`.
 * @returns the mode, or undefined when the payload has none.
 */
export function sandboxModeOf(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined
  return typeof data.mode === 'string' ? data.mode : undefined
}

/**
 * The last `sandbox/mode` in a session log.
 * @param session - the session to scan.
 * @returns the latest mode, or undefined when the log has none.
 */
export function lastSandboxMode(session: SessionPort): string | undefined {
  let mode: string | undefined
  for (const event of session.snapshotEvents()) {
    if (!isRecord(event) || event.type !== 'sandbox/mode') continue
    const next = sandboxModeOf(event.data)
    if (next !== undefined) mode = next
  }
  return mode
}

/**
 * How a session event is classified for a child that must not inherit history.
 * Checked against every `SessionEventMap` member in DSH 0.2.1-alpha.3
 * (`known-event-types.ts`). The same function judges a `prepareContinuable`
 * seed and the live log, for every role that does not inherit the parent
 * conversation.
 *
 * `setup` events carry mode, route, and boundary metadata. They are allowed
 * when the payload does not embed a conversation message. `schedule/change`
 * is the exception that also carries a reminder prompt: a `prompt` field
 * refuses it. `message` events carry conversation text and are refused even
 * when the payload is empty. `splice` is `agent/inbox/spliced`, judged from
 * its inserted messages. `plugin` is a `plugin:` record, allowed only for
 * this plugin's namespace and only without a transcript. Anything else is
 * `unknown` and refused.
 */
export type ChildEventClass = 'setup' | 'message' | 'splice' | 'plugin' | 'unknown'

/** Records this plugin writes. Other `plugin:` namespaces can carry a transcript. */
const PLUGIN_RECORD_PREFIX = 'plugin:dsh-rolesubagents/'

/** How far a payload is walked before an unscanned remainder is treated as parent content. */
const PAYLOAD_SCAN_LIMIT = 32

const CONVERSATION_ROLES: ReadonlySet<string> = new Set(['user', 'assistant', 'system', 'developer', 'tool'])

/**
 * Fields that carry conversation text. A plugin record with one of these is
 * refused. Role instructions use `instructions` and `description`, which stay.
 */
const TRANSCRIPT_FIELDS: ReadonlySet<string> = new Set(['message', 'messages', 'transcript', 'prompt', 'prompts'])

/**
 * Setup a fresh child, or the host around it, writes without copying the
 * parent conversation. Strings here are labels, paths, model ids, and tool
 * schemas. A nested conversation message still refuses the event.
 */
const SETUP_EVENT_TYPES: ReadonlySet<string> = new Set([
  'agent-preset/selected',
  'approval/policy',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session/end-seed',
  'session/title',
  'step/end',
  'step/start',
  'subagent/catalog',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'turn/end',
  'turn/start',
  'working-directory/change',
])

/**
 * Events whose payload is conversation text or parent-owned work.
 * DSH 0.2.1-alpha.3 writes several of these during the child's own first
 * step, after `startActivation` has already returned, so refusing them does
 * not reject a legitimate start. A seed that contains them is parent history.
 */
const MESSAGE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'approval/asked',
  'approval/decided',
  'assistant/attempt',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'deliverables/presented',
  'developer/message',
  'feedback/message-delete',
  'feedback/message-put',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'image/offload',
  'job/registered',
  'job/settled',
  'llm/retry',
  'llm/retry-started',
  'session-log-deepseek/delivery-accepted',
  'session/title-llm-request',
  'system/message',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/call',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'tool/result',
  'user/message',
  'web/deepseek-search-llm-request',
  'workspace/changes',
])

/**
 * The class of one event type, before its payload is inspected.
 * @param type - a session event type.
 * @returns `unknown` for a type this build has not classified.
 */
export function sessionEventClass(type: string): ChildEventClass {
  if (MESSAGE_EVENT_TYPES.has(type)) return 'message'
  if (type === 'agent/inbox/spliced') return 'splice'
  if (type.startsWith('plugin:')) return 'plugin'
  if (SETUP_EVENT_TYPES.has(type)) return 'setup'
  return 'unknown'
}

function keysWithin(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key))
}

function sameRecord(value: unknown, expected: Record<string, string>): boolean {
  if (!isRecord(value)) return false
  const keys = Object.keys(expected)
  if (Object.keys(value).length !== keys.length) return false
  return keys.every(key => value[key] === expected[key])
}

/** A JSON string literal as `JSON.stringify` emits it, starting at `index`. */
function readJsonString(text: string, index: number): { value: string; end: number } | undefined {
  if (text.charCodeAt(index) !== 0x22) return undefined
  let cursor = index + 1
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor)
    if (code === 0x5c) {
      if (cursor + 1 >= text.length) return undefined
      cursor += 2
      continue
    }
    if (code === 0x22) {
      const literal = text.slice(index, cursor + 1)
      try {
        const parsed: unknown = JSON.parse(literal)
        if (typeof parsed !== 'string' || JSON.stringify(parsed) !== literal) return undefined
        return { value: parsed, end: cursor + 1 }
      } catch {
        return undefined
      }
    }
    cursor += 1
  }
  return undefined
}

/**
 * The two notices `working-directory` writes. Both paths are `JSON.stringify`
 * output, and the service returns before writing when the path did not change.
 */
function isWorkingDirectoryNoticeText(text: string): boolean {
  const changed = 'The working directory changed from '
  const unavailable = 'The working directory '
  if (text.startsWith(changed)) return readDirectoryPair(text.slice(changed.length), ' to ', '.')
  if (text.startsWith(unavailable)) {
    return readDirectoryPair(text.slice(unavailable.length), ' is unavailable. The working directory is now ', '.')
  }
  return false
}

function readDirectoryPair(text: string, middle: string, end: string): boolean {
  const previous = readJsonString(text, 0)
  if (previous === undefined || !text.startsWith(middle, previous.end)) return false
  const directory = readJsonString(text, previous.end + middle.length)
  if (directory === undefined || text.slice(directory.end) !== end) return false
  return previous.value !== directory.value
}

function isTextBlock(value: unknown): boolean {
  if (!isRecord(value) || !keysWithin(value, ['type', 'text'])) return false
  return value.type === 'text' && typeof value.text === 'string'
}

/** The user message `working-directory` injects: one matching text block and that source alone. */
function isWorkingDirectoryMessage(message: unknown): boolean {
  if (!isRecord(message) || !keysWithin(message, ['role', 'content', 'source', 'id'])) return false
  if (message.role !== 'user' || !Array.isArray(message.content) || message.content.length !== 1) return false
  if ('id' in message && typeof message.id !== 'string') return false
  if (!sameRecord(message.source, { kind: 'working-directory' })) return false
  const block = message.content[0]
  return (
    isTextBlock(block) && isRecord(block) && typeof block.text === 'string' && isWorkingDirectoryNoticeText(block.text)
  )
}

/**
 * The one task `startLocal` queues. Delivery to the parent appends a second
 * text block of return guidance; both blocks stay inside this one message.
 * `source` is exactly `{ kind: 'user' }`.
 */
function isDelegationTaskMessage(message: unknown): boolean {
  if (!isRecord(message) || !keysWithin(message, ['role', 'content', 'source', 'id'])) return false
  if (message.role !== 'user' || !Array.isArray(message.content) || message.content.length === 0) return false
  if ('id' in message && typeof message.id !== 'string') return false
  if (!sameRecord(message.source, { kind: 'user' })) return false
  return message.content.every(block => isTextBlock(block))
}

type SpliceVerdict = 'own' | 'delegation-task' | 'parent'

function classifySplice(event: Record<string, unknown>): SpliceVerdict {
  const data = event.data
  if (!isRecord(data) || !keysWithin(data, ['target', 'start', 'removedCount', 'inserted', 'outcome'])) return 'parent'
  if (data.target !== 'next-turn' && data.target !== 'next-step') return 'parent'
  if (typeof data.start !== 'number' || !Number.isInteger(data.start) || data.start < 0) return 'parent'
  if ('removedCount' in data) {
    const removed = data.removedCount
    if (typeof removed !== 'number' || !Number.isInteger(removed) || removed < 0) return 'parent'
  }
  if ('outcome' in data && data.outcome !== 'canceled') return 'parent'
  if (!Array.isArray(data.inserted)) return 'parent'
  if (data.inserted.length === 0) return 'own'
  const removedCount = data.removedCount
  if (removedCount !== undefined && removedCount !== 0) return 'parent'
  if ('outcome' in data) return 'parent'
  if (data.inserted.every(message => isWorkingDirectoryMessage(message))) return 'own'
  if (data.target === 'next-turn' && data.inserted.length === 1 && isDelegationTaskMessage(data.inserted[0])) {
    return 'delegation-task'
  }
  return 'parent'
}

function isConversationMessage(value: unknown): boolean {
  if (!isRecord(value) || typeof value.role !== 'string' || !CONVERSATION_ROLES.has(value.role)) return false
  return 'content' in value || 'text' in value
}

function containsConversationMessage(value: unknown, depth: number): boolean {
  if (depth > PAYLOAD_SCAN_LIMIT) return true
  if (isConversationMessage(value)) return true
  if (Array.isArray(value)) return value.some(item => containsConversationMessage(item, depth + 1))
  if (!isRecord(value)) return false
  return Object.values(value).some(child => containsConversationMessage(child, depth + 1))
}

function hasField(value: unknown, names: ReadonlySet<string>, depth: number): boolean {
  if (depth > PAYLOAD_SCAN_LIMIT) return true
  if (Array.isArray(value)) return value.some(item => hasField(item, names, depth + 1))
  if (!isRecord(value)) return false
  for (const [key, child] of Object.entries(value)) {
    if (names.has(key) || hasField(child, names, depth + 1)) return true
  }
  return false
}

function isContentFreeSetup(event: Record<string, unknown>, type: string): boolean {
  if (containsConversationMessage(event.data, 0)) return false
  if (type === 'schedule/change' && hasField(event.data, new Set(['prompt']), 0)) return false
  return true
}

function isOwnPluginRecord(event: Record<string, unknown>, type: string): boolean {
  if (!type.startsWith(PLUGIN_RECORD_PREFIX)) return false
  if (typeof event.data === 'string' || Array.isArray(event.data)) return false
  if (hasField(event.data, TRANSCRIPT_FIELDS, 0)) return false
  return !containsConversationMessage(event.data, 0)
}

type EventVerdict = 'own' | 'delegation-task' | 'parent'

function classifyChildEvent(event: unknown): EventVerdict {
  if (!isRecord(event) || typeof event.type !== 'string') return 'parent'
  const type = event.type
  if (MESSAGE_EVENT_TYPES.has(type)) return 'parent'
  if (type === 'agent/inbox/spliced') return classifySplice(event)
  if (type.startsWith('plugin:')) return isOwnPluginRecord(event, type) ? 'own' : 'parent'
  if (SETUP_EVENT_TYPES.has(type) && isContentFreeSetup(event, type)) return 'own'
  return 'parent'
}

/**
 * Whether a seed or session log already contains parent history.
 * Content-free setup does not count. One delegation-task splice does not
 * count; a second one does, because the host queues the task once. Parent
 * content, another plugin's records, and any unrecognized type do count.
 * @param events - a session log or a provider seed.
 * @returns true when an event is parent history.
 */
export function eventsHaveParentTurns(events: readonly unknown[]): boolean {
  let delegationTasks = 0
  for (const event of events) {
    const verdict = classifyChildEvent(event)
    if (verdict === 'parent') return true
    if (verdict !== 'delegation-task') continue
    delegationTasks += 1
    if (delegationTasks > 1) return true
  }
  return false
}

/**
 * Whether the log already contains parent history.
 * A fresh child does not; a forked seed does.
 * @param session - the child session.
 * @returns true when {@link eventsHaveParentTurns} is true for the log.
 */
export function sessionHasParentTurns(session: SessionPort): boolean {
  return eventsHaveParentTurns(session.snapshotEvents())
}

/**
 * Append `sandbox/mode: read-only` until it is the last mode, or the attempt
 * limit is reached. Re-entering for the same session (a nested `session/event`)
 * returns immediately so the caller that is already looping can append again.
 * @param session - the read-only child's session.
 * @throws when the log rejects the append, or when a nested writer still wins after {@link REPIN_LIMIT} attempts.
 */
export function holdReadOnly(session: SessionPort): void {
  const depth = repinDepth.get(session.id) ?? 0
  if (depth > 0) return
  repinDepth.set(session.id, depth + 1)
  try {
    for (let attempt = 0; attempt < REPIN_LIMIT; attempt++) {
      if (lastSandboxMode(session) === 'read-only') return
      session.append('sandbox/mode', { mode: 'read-only' })
    }
    const mode = lastSandboxMode(session)
    if (mode !== 'read-only') {
      throw new Error(`sandbox mode stayed "${mode ?? 'unset'}" after ${REPIN_LIMIT} re-pins`)
    }
  } finally {
    repinDepth.delete(session.id)
  }
}

/** Where the tool the agent would run was registered, relative to the host tool of the same name. */
export type ToolOrigin = 'inherited' | 'shadow' | 'reserved' | 'unknown'

/** Facts the guard re-reads on every call. */
export interface ReadOnlyGate {
  /** Latest sandbox mode, or undefined when the log has none. */
  readonly mode: string | undefined
  /** True once a re-pin for this session has failed. */
  readonly pinFailed: boolean
  /** `inherited` when the visible tool is the host or ancestor tool. `reserved` is only `run_code`. */
  readonly origin: ToolOrigin
  /** True when `send_message` / `interrupt_agent` names a read-only destination. */
  readonly destinationReadOnly?: boolean
}

function delegateDenial(args: unknown, roles: readonly RoleDefinition[]): string | undefined {
  if (isRecord(args) && args.role !== undefined && typeof args.role !== 'string') {
    return refuse('delegate', 'the role argument is not a string')
  }
  const requested = isRecord(args) && typeof args.role === 'string' && args.role !== '' ? args.role : undefined
  const role =
    requested === undefined
      ? roles.find(entry => entry.builtin === 'general')
      : roles.find(entry => entry.id === requested)
  if (role === undefined) {
    return refuse(
      'delegate',
      requested === undefined ? 'no read-only role is the default' : `unknown role "${requested}"`,
    )
  }
  if (!role.readOnly) return refuse('delegate', `role "${role.id}" is not read-only`)
  if (role.context === 'fork' && role.forkScope !== 'task') {
    return refuse('delegate', `role "${role.id}" would copy the parent conversation into the child`)
  }
  return undefined
}

function destinationDenial(name: string, gate: ReadOnlyGate): string | undefined {
  if (gate.destinationReadOnly === true) return undefined
  return refuse(name, 'its destination is not a read-only agent')
}

/**
 * Whether a read-only agent may run this tool call.
 * The mode and the pin flag are read by the caller on every call.
 * @param name - the tool's public name.
 * @param args - the call's arguments (`delegate` and coordination tools are judged from them).
 * @param roles - the session's selectable roles, used only for `delegate`.
 * @param gate - the session's live sandbox facts and the tool's registration origin.
 * @returns a denial the model should see, or undefined to allow the call.
 */
export function readOnlyCallDenial(
  name: string,
  args: unknown,
  roles: readonly RoleDefinition[],
  gate: ReadOnlyGate,
): string | undefined {
  if (gate.pinFailed) return refuse(name, 'the read-only sandbox could not be restored')
  if (gate.mode !== 'read-only') return refuse(name, 'the sandbox mode is not read-only')
  // `delegate` is this plugin's own registration, not a host tool, but a shadow
  // of that name still has to fail this check before the role is considered.
  if (gate.origin !== 'inherited' && gate.origin !== 'reserved') {
    return refuse(name, 'its registration is not the inherited host tool')
  }
  if (name === 'delegate') return delegateDenial(args, roles)
  if (COORDINATION_TOOLS.has(name)) return destinationDenial(name, gate)
  if (ALLOWED_TOOLS.has(name)) return undefined
  if (tokensOf(name).some(token => WRITE_TOKENS.has(token)) || name.startsWith('stagehand_')) {
    return refuse(name, 'its name marks it as a write')
  }
  return refuse(name, 'it is not an allowlisted read-only tool')
}

/**
 * The inherited definition when `visible` is that object, otherwise a shadow.
 * `run_code` with no definition is the reserved transport, which plugins cannot register.
 * @param name - the tool name.
 * @param visible - the definition the agent would run, if the registry answered.
 * @param inherited - the host or ancestor definition of the same name, if it is the same object.
 * @returns the origin the guard enforces.
 */
export function toolOrigin(
  name: string,
  visible: ToolDefinition | undefined,
  inherited: ToolDefinition | undefined,
): ToolOrigin {
  if (name === 'run_code' && visible === undefined) return 'reserved'
  if (visible === undefined) return 'unknown'
  if (inherited !== undefined && inherited === visible) return 'inherited'
  return 'shadow'
}
