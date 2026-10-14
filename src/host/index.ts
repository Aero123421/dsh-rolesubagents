/**
 * dsh-rolesubagents — Host plugin entry.
 *
 * Mounted by the bundle patch as the `rolesubagents` row. For every Agent it
 * fixes the Session's role list (first meeting records the current settings),
 * registers the role-aware `delegate` tool in that Agent's own scope, and, for
 * each child the tool starts, writes the child's role into the child's log and
 * pins the read-only sandbox before the child's first request. The role's
 * instructions reach the child as runtime context, so the child's system
 * prompt and tools stay identical to its parent's.
 */

import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_ROLES,
  normalizeSettings,
  type RoleDefinition,
  type RoleSettings,
  roleContextText,
} from '../shared/roles.ts'
import type { AgentPort, HostContext } from './ports.ts'
import { readRole, readRolesSnapshot, writeRole, writeRolesSnapshot } from './records.ts'
import { buildTool, type PendingChild, TOOL_NAME } from './tool.ts'

export const name = 'dsh-rolesubagents'
export const inject = ['tools', 'subagents', 'systemPrompt', 'agents']

/** Runtime-context position: right after the official subagent delegation statement (120). */
const ROLE_CONTEXT_ORDER = 121

/** A live config field: a Volatile reference under the Loader, a plain value in tests. */
type Live<T> = T | { get(): T }

export interface Config {
  /** Master switch for new Sessions. */
  enabled: Live<boolean>
  /** Role definitions; normalized on every read. */
  roles: Live<readonly unknown[]>
  /** Provider used by fresh roles. */
  spawnProvider: string
  /** Provider used by fork roles. */
  forkProvider: string
}

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  roles: z
    .array(z.any())
    .default(DEFAULT_ROLES.map(role => ({ ...role })))
    .volatile(),
  spawnProvider: z.string().default('spawn'),
  forkProvider: z.string().default('fork'),
})

function read<T>(value: Live<T> | undefined, fallback: T): T {
  if (value === undefined) return fallback
  if (typeof value === 'object' && value !== null && 'get' in value && typeof value.get === 'function')
    return value.get()
  return value as T
}

interface SessionState {
  role?: RoleDefinition | null
  /** Whether this plugin's tool is registered for the Session's Agent. */
  toolInstalled: boolean
}

export function apply(ctx: HostContext, config: Partial<Config> = {}): void {
  const spawnProvider = config.spawnProvider ?? 'spawn'
  const forkProvider = config.forkProvider ?? 'fork'
  const pending = new Map<string, PendingChild>()
  const installed = new Map<AgentPort, () => void>()
  const sessions = new Map<string, SessionState>()
  let lastProblems = ''

  const currentSettings = (): RoleSettings => {
    const { settings, problems } = normalizeSettings({
      enabled: read(config.enabled, true),
      roles: read(config.roles, DEFAULT_ROLES as unknown[]),
    })
    const summary = problems.map(problem => problem.message).join('; ')
    if (summary !== '' && summary !== lastProblems) ctx.logger.warn(`rolesubagents: settings adjusted: ${summary}`)
    lastProblems = summary
    return settings
  }

  const stateOf = (id: string): SessionState => {
    let state = sessions.get(id)
    if (state === undefined) {
      state = { toolInstalled: false }
      sessions.set(id, state)
    }
    return state
  }

  const roleOf = (agent: AgentPort): RoleDefinition | undefined => {
    const state = stateOf(agent.session.id)
    if (state.role === undefined) state.role = readRole(agent.session) ?? null
    return state.role ?? undefined
  }

  /** The role list an Agent's Session runs with, recording one when the Session has none yet. */
  const snapshotFor = (agent: AgentPort): RoleSettings => {
    const recorded = readRolesSnapshot(agent.session)
    if (recorded !== undefined) return recorded
    const parentId = agent.session.header.parentSession
    const parentSession = parentId === undefined ? undefined : ctx.get('sessions')?.get(parentId)
    const snapshot = (parentSession === undefined ? undefined : readRolesSnapshot(parentSession)) ?? currentSettings()
    writeRolesSnapshot(agent.session, snapshot)
    return snapshot
  }

  const install = (agent: AgentPort, snapshot: RoleSettings): void => {
    if (installed.has(agent)) return
    const definition = buildTool(snapshot, { ctx, spawnProvider, forkProvider, pending })
    if (definition === undefined) return
    installed.set(agent, agent.ctx.tools.register(definition))
    stateOf(agent.session.id).toolInstalled = true
  }

  const onCreated = (agent: AgentPort, source: string): void => {
    const child = pending.get(agent.id)
    if (child !== undefined && source === 'startup') {
      // Pin the sandbox first: if it fails, the error escapes `guarded` and
      // aborts the child's creation instead of letting it run writable.
      if (child.role.readOnly) agent.session.append('sandbox/mode', { mode: 'read-only' })
      writeRole(agent.session, child.role)
      writeRolesSnapshot(agent.session, child.snapshot)
      stateOf(agent.session.id).role = child.role
      install(agent, child.snapshot)
      return
    }
    install(agent, snapshotFor(agent))
  }

  ctx.systemPrompt.context({
    name: 'rolesubagents:role',
    order: ROLE_CONTEXT_ORDER,
    interpolate: false,
    required: true,
    text: ({ agent }) => {
      if (agent === undefined) return ''
      const lines: string[] = []
      const role = roleOf(agent)
      if (role !== undefined) {
        const text = roleContextText(role)
        if (text !== '') lines.push(text)
      }
      const depth = agent.session.header.delegationDepth ?? 0
      const maxDepth = ctx.subagents.resolveMaxDepth(undefined)
      if (depth > 0 && maxDepth !== undefined && stateOf(agent.session.id).toolInstalled) {
        const remaining = Math.max(0, maxDepth - depth)
        lines.push(
          `Delegation depth for \`${TOOL_NAME}\`: current ${depth}, maximum ${maxDepth}, remaining levels ${remaining}.` +
            (remaining === 0 ? ` Do not call \`${TOOL_NAME}\` at this depth; carry out the work directly.` : ''),
        )
      }
      return lines.join('\n\n')
    },
  })

  const guarded = (agent: AgentPort, source: string): void => {
    try {
      onCreated(agent, source)
    } catch (error) {
      // A read-only child must not start writable: abort its creation.
      if (pending.get(agent.id)?.role.readOnly === true && source === 'startup') throw error
      // Anything else only costs this Agent the tool; a throw would abort its creation.
      ctx.logger.warn(
        `rolesubagents: could not prepare agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  ctx.on('agent/created', ({ agent, source }) => guarded(agent, source))
  ctx.on('agent/disposed', ({ agent }) => {
    installed.get(agent)?.()
    installed.delete(agent)
    sessions.delete(agent.session.id)
  })
  for (const agent of ctx.agents.list()) guarded(agent, 'resume')

  ctx.effect(
    () => () => {
      for (const dispose of installed.values()) dispose()
      installed.clear()
      sessions.clear()
      pending.clear()
    },
    'rolesubagents: scoped tools',
  )
}
