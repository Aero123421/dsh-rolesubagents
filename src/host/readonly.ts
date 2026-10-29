/**
 * Read-only enforcement beyond the one-shot sandbox append.
 *
 * A read-only role keeps `sandbox/mode` at `read-only` for the life of the
 * session, and a per-agent tool guard refuses write-like tools the file
 * sandbox does not govern (MCP tools and other plugins). The guard classifies
 * by public name: DSH's MCP client does not copy `readOnlyHint` onto the
 * registered tool, so a hint cannot be consulted.
 */

import { resolveDelegationOverrides } from '../shared/delegation-overrides.ts'
import { forkInheritsHistory, type RoleDefinition } from '../shared/roles.ts'
import type { SessionPort } from './ports.ts'

/** How many times one hold will re-append `read-only` if a nested writer undoes it. */
const REPIN_LIMIT = 8

const repinDepth = new Map<string, number>()

/** Shells that can change files. Allowed only while the latest sandbox mode is `read-only`. */
const FILE_SHELLS: ReadonlySet<string> = new Set(['bash', 'pwsh', 'run_code'])

/** Tools a read-only role may call. Shell and file reads stay; the sandbox denies their writes. */
const ALLOWED_TOOLS: ReadonlySet<string> = new Set([
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
  'send_message',
  'interrupt_agent',
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

/** Tools refused even when their name does not look like a write. */
const DENIED_TOOLS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'str_replace_editor',
  'plugin_manager',
  'present',
  'todo_write',
  'working_directory',
  'create_worktree',
  'create_goal',
  'update_goal',
  'schedule_create',
  'schedule_delete',
  'schedule_update',
  'exit_plan_mode',
  'ralph',
  'workflow',
  'subagent',
  'subagent_fork',
  'spawn_teammate',
  'team_task_create',
  'team_task_update',
  'job_kill',
  'load_workspace_dependencies',
  'terminal_open',
  'terminal_send',
  'terminal_close',
  'terminal_signal',
])

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
])

const READ_TOKENS: ReadonlySet<string> = new Set([
  'read',
  'get',
  'list',
  'search',
  'find',
  'query',
  'describe',
  'show',
  'fetch',
  'status',
  'ping',
  'health',
  'count',
  'head',
  'stat',
  'info',
  'view',
  'lookup',
  'check',
  'inspect',
  'explain',
  'summarize',
  'grep',
  'glob',
  'cat',
  'ls',
  'log',
  'logs',
  'history',
  'blame',
  'whoami',
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

function delegateDenial(args: unknown, roles: readonly RoleDefinition[]): string | undefined {
  if (isRecord(args) && args.role !== undefined && typeof args.role !== 'string') {
    return refuse('delegate', 'the role argument is not a string')
  }
  const requested = isRecord(args) && typeof args.role === 'string' && args.role !== '' ? args.role : undefined
  let role =
    requested === undefined
      ? roles.find(entry => entry.builtin === 'general')
      : roles.find(entry => entry.id === requested)
  if (role === undefined) {
    return refuse(
      'delegate',
      requested === undefined ? 'no read-only role is the default' : `unknown role "${requested}"`,
    )
  }
  try {
    role = resolveDelegationOverrides(role, isRecord(args) ? args : {})
  } catch (error) {
    return refuse('delegate', error instanceof Error ? error.message : 'invalid one-shot overrides')
  }
  if (!role.readOnly) return refuse('delegate', `role "${role.id}" is not read-only`)
  // A runner role always starts fresh in its CLI's read-only mode, so it never copies the parent conversation.
  if (role.runner === undefined && forkInheritsHistory(role)) {
    return refuse('delegate', `role "${role.id}" would copy the parent conversation into the child`)
  }
  return undefined
}

/**
 * Whether a read-only agent may run this tool call.
 * @param name - the tool's public name.
 * @param args - the call's arguments (`delegate` is judged from them).
 * @param roles - the session's selectable roles, used only for `delegate`.
 * @param sandboxMode - the session's latest sandbox mode. `bash`, `pwsh`, and `run_code` run only when it is `read-only`.
 * @returns a denial the model should see, or undefined to allow the call.
 */
export function readOnlyCallDenial(
  name: string,
  args: unknown,
  roles: readonly RoleDefinition[],
  sandboxMode?: string,
): string | undefined {
  if (name === 'delegate') return delegateDenial(args, roles)
  if (FILE_SHELLS.has(name) && sandboxMode !== 'read-only') {
    return refuse(name, 'the file sandbox is not read-only, so this call could change files')
  }
  if (ALLOWED_TOOLS.has(name)) return undefined
  if (DENIED_TOOLS.has(name) || name.startsWith('stagehand_')) {
    return refuse(name, 'it can change state outside the read-only file sandbox')
  }
  const tokens = tokensOf(name)
  if (tokens.some(token => WRITE_TOKENS.has(token))) return refuse(name, 'its name marks it as a write')
  if (tokens.some(token => READ_TOKENS.has(token))) return undefined
  return refuse(
    name,
    'its name does not identify it as read-only, and MCP read-only annotations are not visible to plugins',
  )
}
