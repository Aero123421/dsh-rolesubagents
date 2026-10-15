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
 * The id is remembered as well as the object: a resume can hand back a new
 * session object for the same id, and that session stays closed.
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
 * Whether the log already contains a completed or open parent turn.
 * A fresh child does not; a forked seed does.
 * @param session - the child session.
 * @returns true when a `turn/start` or `turn/end` event is present.
 */
export function sessionHasParentTurns(session: SessionPort): boolean {
  return session.snapshotEvents().some(event => {
    if (!isRecord(event)) return false
    return event.type === 'turn/start' || event.type === 'turn/end'
  })
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
  if (name === 'delegate') return delegateDenial(args, roles)
  if (gate.origin !== 'inherited' && gate.origin !== 'reserved') {
    return refuse(name, 'its registration is not the inherited host tool')
  }
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
