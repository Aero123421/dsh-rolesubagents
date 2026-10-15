/**
 * dsh-rolesubagents — Host plugin entry.
 *
 * Mounted by the bundle patch as the `rolesubagents` row. For every Agent it
 * fixes the Session's role list (first meeting records the current settings),
 * registers the role-aware `delegate` tool in that Agent's own scope, and, for
 * each child the tool starts, writes the child's role into the child's log and
 * pins the read-only sandbox before the child's first request and, while that
 * role is read-only, appends `read-only` again whenever a later `sandbox/mode`
 * selects anything else. A guard on that agent allows only known inherited
 * tools, and only while the mode is still `read-only`. The role's instructions
 * reach the child as runtime context, so
 * the child's system prompt and tools stay identical to its parent's.
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_ROLES,
  forkInheritsHistory,
  normalizeSettings,
  type RoleDefinition,
  type RoleSettings,
  roleContextText,
  selectableRoles,
} from '../shared/roles.ts'
import type { AgentPort, HostContext, SessionPort, ToolLookup } from './ports.ts'
import {
  holdReadOnly,
  lastSandboxMode,
  markPinFailed,
  pinFailed,
  readOnlyCallDenial,
  releasePinFailure,
  sandboxModeOf,
  sessionHasParentTurns,
  toolOrigin,
} from './readonly.ts'
import { readRole, readRolesSnapshot, writeRole, writeRolesSnapshot } from './records.ts'
import { buildTool, discardPending, discardReservation, type PendingChild, TOOL_NAME } from './tool.ts'

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

interface Prepared {
  tool?: () => void
  guard?: () => void
  /** The `delegate` definition this plugin registered, when the role list has one. */
  delegate?: ToolDefinition
}

/** Argument names that choose an agent. Message text is not one of them. */
const DESTINATION_KEYS: ReadonlySet<string> = new Set([
  'agent_id',
  'agentId',
  'session_id',
  'sessionId',
  'target',
  'target_id',
  'targetId',
  'target_agent_id',
  'targetAgentId',
  'to',
  'recipient',
  'parent_id',
  'parentId',
])

function collectDestinationIds(value: unknown, into: string[], depth: number): void {
  if (depth > 6 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectDestinationIds(item, into, depth + 1)
    return
  }
  for (const [key, child] of Object.entries(value)) {
    if (DESTINATION_KEYS.has(key)) pushDestination(child, into, depth)
    else if (typeof child === 'object' && child !== null) collectDestinationIds(child, into, depth + 1)
  }
}

function pushDestination(value: unknown, into: string[], depth: number): void {
  if (typeof value === 'string') {
    if (value !== '') into.push(value)
    return
  }
  if (depth > 6) return
  if (Array.isArray(value)) {
    for (const item of value) pushDestination(item, into, depth + 1)
    return
  }
  if (typeof value === 'object' && value !== null) collectDestinationIds(value, into, depth + 1)
}

export function apply(ctx: HostContext, config: Partial<Config> = {}): void {
  const spawnProvider = config.spawnProvider ?? 'spawn'
  const forkProvider = config.forkProvider ?? 'fork'
  const pending = new Map<string, PendingChild>()
  const installed = new Map<AgentPort, Prepared>()
  const sessions = new Map<string, SessionState>()
  /** Agents already announced, so a reservation can be bound to an id that was not the one reserved. */
  const seenAgents = new Map<string, AgentPort>()
  let claimStarted: (id: string) => void = () => {}
  /** Sessions whose live role is read-only, including the moment before the role record is written. */
  const readOnlySessions = new WeakSet<SessionPort>()
  let lastProblems = ''
  /** Set when the child must not be published: a history leak or a failed read-only pin. */
  let abortCreation = false
  /** False after unload, so a re-pin already queued does not append into a dead plugin. */
  let alive = true
  /** Session ids whose re-pin is already queued. DSH rejects an append from inside `session/event`. */
  const repinScheduled = new Set<string>()

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

  const isReadOnlySession = (session: SessionPort): boolean => {
    if (readOnlySessions.has(session)) return true
    try {
      return readRole(session)?.readOnly === true
    } catch {
      return false
    }
  }

  const disposePrepared = (prepared: Prepared | undefined): void => {
    prepared?.guard?.()
    prepared?.tool?.()
  }

  const lookup = (tools: ToolLookup | undefined, name: string, scope?: AgentPort) => {
    if (tools === undefined || typeof tools.get !== 'function') return undefined
    return tools.get(name, scope)
  }

  /** The host or ancestor definition when it is the same object the agent would run. */
  const inheritedTool = (agent: AgentPort, name: string) => {
    const visible = lookup(agent.ctx.tools, name, agent)
    if (visible === undefined) return undefined
    const hostTool = lookup(ctx.tools, name)
    if (hostTool === visible) return visible
    const seen = new Set<string>()
    let parentId = agent.session.header.parentSession
    while (parentId !== undefined && !seen.has(parentId)) {
      seen.add(parentId)
      const parent = ctx.agents.list().find(candidate => candidate.id === parentId || candidate.session.id === parentId)
      if (parent === undefined) break
      const parentTool = lookup(parent.ctx.tools, name, parent)
      if (parentTool === visible) return visible
      parentId = parent.session.header.parentSession
    }
    return undefined
  }

  const sessionOf = (agentId: string): SessionPort | undefined => {
    const listed =
      ctx.agents.list().find(candidate => candidate.id === agentId || candidate.session.id === agentId) ??
      seenAgents.get(agentId)
    return ctx.get('sessions')?.get(agentId) ?? listed?.session
  }

  /**
   * A destination is read-only only when its live mode is `read-only`, the pin
   * has not failed, and the role mark agrees. A broken log is not read-only.
   */
  const sessionIsReadOnly = (session: SessionPort): boolean => {
    try {
      if (pinFailed(session)) return false
      if (lastSandboxMode(session) !== 'read-only') return false
      if (readOnlySessions.has(session)) return true
      return readRole(session)?.readOnly === true
    } catch {
      return false
    }
  }

  const destinationsAreReadOnly = (args: unknown): boolean => {
    const ids: string[] = []
    collectDestinationIds(args, ids, 0)
    if (ids.length === 0) return false
    return ids.every(id => {
      const session = sessionOf(id)
      return session !== undefined && sessionIsReadOnly(session)
    })
  }

  const install = (agent: AgentPort, snapshot: RoleSettings, forceGuard = false): void => {
    let prepared = installed.get(agent)
    if (prepared === undefined) {
      const definition = buildTool(snapshot, {
        ctx,
        spawnProvider,
        forkProvider,
        pending,
        claimStarted: id => claimStarted(id),
      })
      prepared = { delegate: definition }
      if (definition !== undefined) {
        prepared.tool = agent.ctx.tools.register(definition)
        stateOf(agent.session.id).toolInstalled = true
      }
      installed.set(agent, prepared)
    }
    const role = roleOf(agent)
    if ((forceGuard || role?.readOnly === true) && prepared.guard === undefined) {
      readOnlySessions.add(agent.session)
      const roles = selectableRoles(snapshot)
      const delegateDefinition = prepared.delegate
      prepared.guard = agent.ctx.tools.guard(call => {
        const visible = lookup(agent.ctx.tools, call.name, agent)
        const origin =
          call.name === TOOL_NAME
            ? visible !== undefined && delegateDefinition !== undefined && visible === delegateDefinition
              ? 'inherited'
              : 'shadow'
            : toolOrigin(call.name, visible, inheritedTool(agent, call.name))
        return readOnlyCallDenial(call.name, call.arguments, roles, {
          mode: lastSandboxMode(agent.session),
          pinFailed: pinFailed(agent.session),
          origin,
          destinationReadOnly: destinationsAreReadOnly(call.arguments),
        })
      })
    }
  }

  const pinReadOnly = (agent: AgentPort): void => {
    readOnlySessions.add(agent.session)
    try {
      holdReadOnly(agent.session)
    } catch (error) {
      markPinFailed(agent.session)
      throw error
    }
  }

  const isDelegatedChild = (agent: AgentPort): boolean => {
    const header = agent.session.header
    return header.parentSession !== undefined || header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0
  }

  /** Apply a reserved child. The creation source is irrelevant: a late or retitled event still matches the id. */
  const applyChild = (agent: AgentPort, child: PendingChild): void => {
    if (!forkInheritsHistory(child.role) && sessionHasParentTurns(agent.session)) {
      readOnlySessions.add(agent.session)
      install(agent, child.snapshot, true)
      markPinFailed(agent.session)
      abortCreation = true
      throw new Error(
        `role "${child.role.id}" must not inherit the parent conversation, but the child session already contains it`,
      )
    }
    stateOf(agent.session.id).role = child.role
    if (child.role.readOnly) readOnlySessions.add(agent.session)
    install(agent, child.snapshot)
    // Pin before the role records so a failed pin still leaves the sandbox event first when it succeeds,
    // and so the guard above is already installed if the pin throws.
    if (child.role.readOnly) pinReadOnly(agent)
    writeRole(agent.session, child.role)
    writeRolesSnapshot(agent.session, child.snapshot)
  }

  claimStarted = (id: string): void => {
    const child = pending.get(id)
    if (child === undefined) return
    const listed = ctx.agents.list().find(candidate => candidate.id === id || candidate.session.id === id)
    const agent = listed ?? seenAgents.get(id)
    if (agent === undefined) return
    discardReservation(pending, child)
    applyChild(agent, child)
  }

  const onCreated = (agent: AgentPort, _source: string): void => {
    seenAgents.set(agent.id, agent)
    seenAgents.set(agent.session.id, agent)
    const child = pending.get(agent.id) ?? pending.get(agent.session.id)
    if (child !== undefined) {
      discardReservation(pending, child)
      applyChild(agent, child)
      return
    }
    // No reservation and no role record: this child was not started here.
    // Official subagents, teams, and other plugins keep their own sandbox.
    const snapshot = snapshotFor(agent)
    install(agent, snapshot)
    if (roleOf(agent)?.readOnly === true) pinReadOnly(agent)
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
    abortCreation = false
    try {
      onCreated(agent, source)
    } catch (error) {
      // A read-only child, a failed pin, or a history leak must not start.
      // Resume uses the same path: a failed pin aborts that startup.
      // A delegated child whose log cannot be read cannot be classified, so it does not start.
      if (abortCreation || readOnlySessions.has(agent.session)) throw error
      let recordedReadOnly = false
      let unreadable = false
      try {
        recordedReadOnly = readRole(agent.session)?.readOnly === true
      } catch {
        unreadable = true
      }
      if (recordedReadOnly || (unreadable && isDelegatedChild(agent))) throw error
      ctx.logger.warn(
        `rolesubagents: could not prepare agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const stopCreated = ctx.on('agent/created', ({ agent, source }) => guarded(agent, source))
  const stopDisposed = ctx.on('agent/disposed', ({ agent }) => {
    releasePinFailure(agent.session)
    disposePrepared(installed.get(agent))
    installed.delete(agent)
    sessions.delete(agent.session.id)
    seenAgents.delete(agent.id)
    seenAgents.delete(agent.session.id)
  })
  const stopSession = ctx.on('session/event', (session, event) => {
    if (event.type !== 'sandbox/mode' || sandboxModeOf(event.data) === 'read-only') return
    if (!isReadOnlySession(session)) return
    // The wider mode is already in the log. DSH refuses an append that reenters this
    // notification, so the re-pin waits until the notification returns. The guard
    // denies every tool until that re-pin is the latest mode.
    if (repinScheduled.has(session.id)) return
    repinScheduled.add(session.id)
    queueMicrotask(() => {
      repinScheduled.delete(session.id)
      if (!alive || !isReadOnlySession(session)) return
      try {
        holdReadOnly(session)
      } catch (error) {
        // The wider mode stays committed. Refuse every tool rather than leave the session writable.
        markPinFailed(session)
        ctx.logger.warn(
          `rolesubagents: could not re-pin read-only on session ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })
  })
  for (const agent of ctx.agents.list()) guarded(agent, 'resume')

  const unsubscribe = (stop: unknown): void => {
    if (typeof stop === 'function') stop()
  }

  ctx.effect(
    () => () => {
      alive = false
      repinScheduled.clear()
      unsubscribe(stopCreated)
      unsubscribe(stopDisposed)
      unsubscribe(stopSession)
      for (const agent of installed.keys()) releasePinFailure(agent.session)
      for (const prepared of installed.values()) disposePrepared(prepared)
      installed.clear()
      sessions.clear()
      seenAgents.clear()
      discardPending(pending)
    },
    'rolesubagents: scoped tools',
  )
}
