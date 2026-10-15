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
import {
  buildTool,
  discardPending,
  discardReservation,
  discardReservationsFor,
  type PendingChild,
  TOOL_NAME,
} from './tool.ts'

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
  /** True while the guard denies every tool because the child is not bound yet. */
  held?: boolean
}

interface Inflight {
  readonly parentAgentId: string
  readonly parentSessionId: string
  readonly reservedId: string
  readonly role: RoleDefinition
  readonly snapshot: RoleSettings
  readonly unbound: AgentPort[]
}

const ID_TOKEN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/** Denial shown while a delegated child is still waiting to be bound to this activation. */
const UNBOUND_DENIAL =
  'read-only role: this delegated child is not bound to its reservation and was refused. Do not retry it; report what should change instead.'

/** Argument keys whose values name an agent or session. Plurals and nesting count. */
const DESTINATION_KEYS = new Set([
  'agent_id',
  'agentId',
  'agent_ids',
  'agentIds',
  'session_id',
  'sessionId',
  'session_ids',
  'sessionIds',
  'target',
  'target_id',
  'targetId',
  'target_ids',
  'targetIds',
  'target_agent_id',
  'targetAgentId',
  'target_agent_ids',
  'targetAgentIds',
  'to',
  'recipient',
  'recipients',
  'parent_id',
  'parentId',
  'parent_ids',
  'parentIds',
])

/** Body and metadata. A trace id or a parent id written here is not a destination. */
const BODY_KEYS = new Set([
  'message',
  'messages',
  'text',
  'content',
  'contents',
  'prompt',
  'prompts',
  'description',
  'title',
  'body',
  'note',
  'notes',
  'metadata',
  'meta',
  'trace',
  'trace_id',
  'traceId',
  'trace_ids',
  'traceIds',
  'span_id',
  'spanId',
  'request_id',
  'requestId',
])

function collectDestinations(value: unknown, into: string[], depth: number, asDestination: boolean): void {
  if (depth > 8) return
  if (typeof value === 'string') {
    if (asDestination && value !== '') into.push(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDestinations(item, into, depth + 1, asDestination)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      if (BODY_KEYS.has(key)) continue
      collectDestinations(child, into, depth + 1, asDestination || DESTINATION_KEYS.has(key))
    }
  }
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
  /** Activations this plugin has started and not yet settled. */
  const inflight: Inflight[] = []
  let activationHooks: {
    begin(flight: { parent: AgentPort; reservedId: string; role: RoleDefinition; snapshot: RoleSettings }): void
    finish(reservedId: string, returnedId: string | undefined): Promise<void>
  } = {
    begin() {},
    async finish() {},
  }
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

  const knownSessions = (): Map<string, SessionPort> => {
    const sessionsById = new Map<string, SessionPort>()
    const add = (id: string, session: SessionPort) => {
      if (id !== '') sessionsById.set(id, session)
    }
    const service = ctx.get('sessions')
    if (service?.list !== undefined) {
      for (const session of service.list()) add(session.id, session)
    }
    for (const agent of ctx.agents.list()) {
      add(agent.id, agent.session)
      add(agent.session.id, agent.session)
    }
    for (const agent of seenAgents.values()) {
      add(agent.id, agent.session)
      add(agent.session.id, agent.session)
    }
    return sessionsById
  }

  const sessionForId = (sessionsById: Map<string, SessionPort>, id: string): SessionPort | undefined => {
    const known = sessionsById.get(id)
    if (known !== undefined) return known
    const loaded = ctx.get('sessions')?.get(id)
    if (loaded !== undefined) sessionsById.set(id, loaded)
    return loaded
  }

  /**
   * Destination fields name an agent or session. Body and metadata do not.
   * An unknown id in a destination field cannot be judged and fails closed.
   * A known id has to be read-only, including a session that is still listed
   * after its agent has gone.
   */
  const destinationsAreReadOnly = (args: unknown): boolean => {
    const destinations: string[] = []
    collectDestinations(args, destinations, 0, false)
    if (destinations.length === 0) return false
    const sessionsById = knownSessions()
    const referenced = new Set<SessionPort>()
    const idToken = new RegExp(ID_TOKEN, 'gi')
    for (const value of destinations) {
      const direct = sessionForId(sessionsById, value)
      if (direct !== undefined) referenced.add(direct)
      for (const [id, session] of sessionsById) {
        if (id.length >= 8 && value.includes(id)) referenced.add(session)
      }
      idToken.lastIndex = 0
      for (const token of value.match(idToken) ?? []) {
        const known = sessionForId(sessionsById, token)
        if (known === undefined) return false
        referenced.add(known)
      }
      const recognized = [...sessionsById.keys()].some(id => value === id || (id.length >= 8 && value.includes(id)))
      if (!recognized) return false
    }
    if (referenced.size === 0) return false
    for (const session of referenced) {
      if (!sessionIsReadOnly(session)) return false
    }
    return true
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
        activation: {
          begin: flight => activationHooks.begin(flight),
          finish: (reservedId, returnedId) => activationHooks.finish(reservedId, returnedId),
        },
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
        try {
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
        } catch {
          return `read-only role: \`${call.name}\` was refused (the session log could not be read). Do not retry it; report what should change instead.`
        }
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

  /** Drop the temporary deny-all guard so the real read-only guard can take its place. */
  const clearHold = (agent: AgentPort): void => {
    const prepared = installed.get(agent)
    if (prepared?.held !== true) return
    prepared.guard?.()
    prepared.guard = undefined
    prepared.held = false
  }

  /** Apply a reserved child. The creation source is irrelevant: a late or retitled event still matches the id. */
  const applyChild = (agent: AgentPort, child: PendingChild): void => {
    clearHold(agent)
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

  /**
   * The latest open activation whose parent is this child's parent.
   * DSH 0.2.1-alpha.3 publishes `agent/created` as `{ agent, source }` only.
   * `startActivation` returns `{ childId, dispose }`. The child's
   * `subagent/descriptor` names the shared spawn or fork provider, and the
   * tool call id is not copied onto the child. A same-parent child therefore
   * cannot be proved to be ours until its id is the reservation or the id
   * activation returns. A child with no parentSession is not held here; the
   * reservation match and {@link activationHooks.finish} still guard it when
   * the id matches.
   */
  const flightFor = (agent: AgentPort): Inflight | undefined => {
    const parent = agent.session.header.parentSession
    if (parent === undefined) return undefined
    for (let index = inflight.length - 1; index >= 0; index--) {
      const flight = inflight[index]
      if (flight !== undefined && (flight.parentSessionId === parent || flight.parentAgentId === parent)) return flight
    }
    return undefined
  }

  const hasRoleRecord = (agent: AgentPort): boolean => {
    try {
      return readRole(agent.session) !== undefined
    } catch {
      return false
    }
  }

  /** Refuse every tool until the child is bound. The sandbox stays untouched until then. */
  const holdClosed = (agent: AgentPort, flight: Inflight): void => {
    install(agent, flight.snapshot)
    const prepared = installed.get(agent)
    if (prepared !== undefined && prepared.guard === undefined) {
      prepared.held = true
      prepared.guard = agent.ctx.tools.guard(() => UNBOUND_DENIAL)
    }
  }

  /** Drop the temporary refusal and leave the child as one this plugin did not start. */
  const releaseHold = (agent: AgentPort): void => {
    clearHold(agent)
    if (hasRoleRecord(agent)) return
    const snapshot = snapshotFor(agent)
    install(agent, snapshot)
    if (roleOf(agent)?.readOnly === true) pinReadOnly(agent)
  }

  const sameAgent = (agent: AgentPort, id: string | undefined): boolean =>
    id !== undefined && (agent.id === id || agent.session.id === id)

  const reservationFor = (
    agent: AgentPort,
    reservedId: string,
    returnedId: string | undefined,
  ): PendingChild | undefined =>
    pending.get(agent.id) ??
    pending.get(agent.session.id) ??
    pending.get(reservedId) ??
    (returnedId === undefined ? undefined : pending.get(returnedId))

  activationHooks = {
    begin(input) {
      inflight.push({
        parentAgentId: input.parent.id,
        parentSessionId: input.parent.session.id,
        reservedId: input.reservedId,
        role: input.role,
        snapshot: input.snapshot,
        unbound: [],
      })
    },
    async finish(reservedId, returnedId) {
      const index = inflight.findIndex(flight => flight.reservedId === reservedId)
      const flight = index < 0 ? undefined : inflight[index]
      if (flight === undefined) return
      const matches = (agent: AgentPort): boolean => sameAgent(agent, reservedId) || sameAgent(agent, returnedId)
      const handled = new Set<AgentPort>()
      const agentFor = (id: string | undefined): AgentPort | undefined => {
        if (id === undefined) return undefined
        const listed = ctx.agents.list().find(candidate => candidate.id === id || candidate.session.id === id)
        return listed ?? seenAgents.get(id)
      }
      const take = (): AgentPort[] => {
        const batch: AgentPort[] = []
        const queued = new Set<AgentPort>()
        const push = (agent: AgentPort | undefined): void => {
          if (agent === undefined || handled.has(agent) || queued.has(agent)) return
          queued.add(agent)
          batch.push(agent)
        }
        for (const agent of flight.unbound) push(agent)
        // A parentless child is not held, but a matching reservation or
        // returned id is still ours.
        push(agentFor(reservedId))
        push(agentFor(returnedId))
        return batch
      }
      try {
        let idleYields = 0
        while (idleYields < 1) {
          const batch = take()
          if (batch.length === 0) {
            // A child created while this wait runs is still on the open flight.
            await Promise.resolve()
            idleYields += 1
            if (take().length === 0) break
            idleYields = 0
            continue
          }
          idleYields = 0
          for (const agent of batch) {
            handled.add(agent)
            if (!matches(agent)) {
              releaseHold(agent)
              continue
            }
            const child = reservationFor(agent, reservedId, returnedId)
            if (child === undefined) {
              if (installed.get(agent)?.held === true) releaseHold(agent)
              continue
            }
            clearHold(agent)
            discardReservation(pending, child)
            applyChild(agent, child)
          }
        }
      } finally {
        for (const agent of flight.unbound) {
          if (installed.get(agent)?.held === true) releaseHold(agent)
        }
        const at = inflight.indexOf(flight)
        if (at >= 0) inflight.splice(at, 1)
      }
    },
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
    const flight = flightFor(agent)
    // No role record yet, and this parent has an activation open: refuse every
    // tool until that call returns. Push first so finish can release the hold.
    // The sandbox stays as the child left it until the id is confirmed ours.
    if (flight !== undefined && !hasRoleRecord(agent)) {
      flight.unbound.push(agent)
      holdClosed(agent, flight)
      return
    }
    // No reservation and no role record, and not our open activation.
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
    discardReservationsFor(pending, agent)
    const parentIds = new Set([agent.id, agent.session.id])
    for (let index = inflight.length - 1; index >= 0; index--) {
      const flight = inflight[index]
      if (flight === undefined) continue
      const at = flight.unbound.indexOf(agent)
      if (at >= 0) flight.unbound.splice(at, 1)
      if (!parentIds.has(flight.parentAgentId) && !parentIds.has(flight.parentSessionId)) continue
      const orphans = flight.unbound.splice(0)
      inflight.splice(index, 1)
      for (const child of orphans) releaseHold(child)
    }
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
      const orphans = inflight.splice(0).flatMap(flight => flight.unbound)
      for (const child of orphans) clearHold(child)
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
