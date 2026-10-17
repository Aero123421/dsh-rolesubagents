/**
 * dsh-rolesubagents — Host plugin entry.
 *
 * Mounted by the bundle patch as the `rolesubagents` row. For every Agent it
 * fixes the Session's role list (first meeting records the current settings),
 * registers the role-aware `delegate` tool in that Agent's own scope, and, for
 * each child the tool starts, records the child's role in the `rolesubagents`
 * storage domain and pins the read-only sandbox before the child's first
 * request and, while that
 * role is read-only, appends `read-only` again whenever a later `sandbox/mode`
 * selects anything else. A guard on that agent refuses write-like MCP and
 * plugin tools. The role's instructions reach the child as runtime context, so
 * the child's system prompt and tools stay identical to its parent's.
 */

import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_ROLES,
  normalizeSettings,
  type RoleDefinition,
  type RoleSettings,
  roleContextText,
  selectableRoles,
} from '../shared/roles.ts'
import type { AgentPort, HostContext, SessionPort } from './ports.ts'
import { holdReadOnly, lastSandboxMode, readOnlyCallDenial, sandboxModeOf } from './readonly.ts'
import { createRoleState } from './state.ts'
import { buildTool, type PendingChild, TOOL_NAME } from './tool.ts'
import { workflowTool } from './workflow.ts'

export const name = 'dsh-rolesubagents'
export const inject = ['tools', 'subagents', 'systemPrompt', 'agents', 'storageDomain']

/** Runtime-context position: right after the official subagent delegation statement (120). */
const ROLE_CONTEXT_ORDER = 121

/** A live config field: a Volatile reference under the Loader, a plain value in tests. */
type Live<T> = T | { get(): T }

export interface Config {
  /** Master switch for new Sessions. */
  enabled: Live<boolean>
  /** Role definitions; normalized on every read. */
  roles: Live<readonly unknown[]>
  /** Model-only default for workflow children; null means inherit. */
  workflowModel: Live<unknown>
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
  workflowModel: z.any().default(null).volatile(),
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
  snapshot: RoleSettings
  workflow?: () => void
  workflowOriginal?: import('@deepseek-ai/dsh-tools').ToolDefinition
  workflowEpoch?: number
  tool?: () => void
  guard?: () => void
}

export function apply(ctx: HostContext, config: Partial<Config> = {}): void {
  const spawnProvider = config.spawnProvider ?? 'spawn'
  const forkProvider = config.forkProvider ?? 'fork'
  const state = createRoleState(ctx)
  let active = true
  let stateReady = false
  void state.ready.then(() => {
    stateReady = true
    if (state.degraded) {
      ctx.logger.warn(
        `rolesubagents: role state is kept in memory only: ${state.degradedReason ?? 'storage unavailable'}`,
      )
    }
  })
  const pending = new Map<string, PendingChild>()
  const installed = new Map<AgentPort, Prepared>()
  const sessions = new Map<string, SessionState>()
  /** Sessions whose live role is read-only, including the moment before the role record is written. */
  const readOnlySessions = new WeakSet<SessionPort>()
  const queuedPins = new WeakSet<SessionPort>()
  let lastProblems = ''

  const currentSettings = (): RoleSettings => {
    const { settings, problems } = normalizeSettings({
      enabled: read(config.enabled, true),
      roles: read(config.roles, DEFAULT_ROLES as unknown[]),
      workflowModel: read(config.workflowModel, null),
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
    // A live Agent may request runtime context while an HMR reload is still
    // opening storage. Do not cache "no role" before the stored image exists.
    if (!stateReady) return undefined
    const sessionState = stateOf(agent.session.id)
    if (sessionState.role === undefined) sessionState.role = state.readRole(agent.session) ?? null
    return sessionState.role ?? undefined
  }

  /** The role list an Agent's Session runs with, recording one when the Session has none yet. */
  const snapshotFor = (agent: AgentPort): RoleSettings => {
    const recorded = state.readSnapshot(agent.session)
    if (recorded !== undefined) return recorded
    const parentId = agent.session.header.parentSession
    const parentSession = parentId === undefined ? undefined : ctx.get('sessions')?.get(parentId)
    const snapshot = (parentSession === undefined ? undefined : state.readSnapshot(parentSession)) ?? currentSettings()
    state.writeSnapshot(agent.session, snapshot)
    return snapshot
  }

  const isReadOnlySession = (session: SessionPort): boolean => {
    if (readOnlySessions.has(session)) return true
    return state.readRole(session)?.readOnly === true
  }

  const disposePrepared = (prepared: Prepared | undefined): void => {
    prepared?.guard?.()
    prepared?.workflow?.()
    prepared?.tool?.()
  }

  // An external tool change invalidates in O(1), not by rebuilding every
  // Agent's registry during workflow fan-out. Refresh only at the next prompt
  // or execution for that Agent. Old captured wrappers re-resolve too, so a
  // removed/restricted workflow cannot execute through a stale shadow.
  let workflowEpoch = 0
  let refreshingWorkflow = false
  const refreshWorkflow = (agent: AgentPort, prepared: Prepared): void => {
    const { snapshot } = prepared
    if (!snapshot.enabled || snapshot.workflowModel === undefined || prepared.workflowEpoch === workflowEpoch) return
    if (refreshingWorkflow) throw new Error('workflow refresh is already in progress')
    refreshingWorkflow = true
    prepared.workflowOriginal = undefined
    try {
      prepared.workflow?.()
      prepared.workflow = undefined
      const original = agent.ctx.tools.get?.('workflow', agent)
      if (original !== undefined) {
        const wrapped = workflowTool(original, snapshot.workflowModel, () => {
          if (installed.get(agent) !== prepared) return undefined
          refreshWorkflow(agent, prepared)
          return prepared.workflowOriginal
        })
        prepared.workflow = agent.ctx.tools.register(wrapped)
        prepared.workflowOriginal = original
      }
    } catch (error) {
      ctx.logger.warn(
        `rolesubagents: could not decorate workflow for agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      prepared.workflowEpoch = workflowEpoch
      refreshingWorkflow = false
    }
  }

  const install = (agent: AgentPort, snapshot: RoleSettings): void => {
    if (installed.has(agent)) return
    const definition = buildTool(snapshot, { ctx, spawnProvider, forkProvider, pending, state })
    const prepared: Prepared = { snapshot }
    try {
      if (definition !== undefined) {
        prepared.tool = agent.ctx.tools.register(definition)
        stateOf(agent.session.id).toolInstalled = true
      }
      const role = roleOf(agent)
      if (role?.readOnly === true) {
        readOnlySessions.add(agent.session)
        prepared.guard = agent.ctx.tools.guard(call =>
          readOnlyCallDenial(call.name, call.arguments, selectableRoles(snapshot), lastSandboxMode(agent.session)),
        )
      }
    } catch (error) {
      disposePrepared(prepared)
      stateOf(agent.session.id).toolInstalled = false
      throw error
    }
    installed.set(agent, prepared)
    refreshWorkflow(agent, prepared)
  }

  const pinReadOnly = (agent: AgentPort): void => {
    readOnlySessions.add(agent.session)
    holdReadOnly(agent.session)
  }

  const onCreated = (agent: AgentPort): void => {
    const child = pending.get(agent.id)
    if (child !== undefined) {
      // Pin the sandbox first: if it fails, the error escapes `guarded` and
      // aborts the child's creation instead of letting it run writable.
      // The creation source does not matter; a reserved child is this plugin's.
      if (child.role.readOnly) pinReadOnly(agent)
      state.writeRole(agent.session, child.role)
      state.writeSnapshot(agent.session, child.snapshot)
      stateOf(agent.session.id).role = child.role
      install(agent, child.snapshot)
      return
    }
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
      const prepared = installed.get(agent)
      if (prepared !== undefined) refreshWorkflow(agent, prepared)
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

  const guarded = (agent: AgentPort, _source: string): void => {
    let readOnly = pending.get(agent.id)?.role.readOnly === true || readOnlySessions.has(agent.session)
    try {
      readOnly ||= state.readRole(agent.session)?.readOnly === true
      onCreated(agent)
    } catch (error) {
      // Both newly delegated and resumed read-only children must have their
      // guard and sandbox pin installed before queued work can start.
      if (readOnly) throw error
      // Anything else only costs this Agent the tool; a throw would abort its creation.
      ctx.logger.warn(
        `rolesubagents: could not prepare agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const stopCreated = ctx.on('agent/created', async ({ agent, source }) => {
    // DSH awaits this serial event before releasing the Agent's first turn.
    // Reading early would overwrite a saved snapshot and cache a missing role.
    await state.ready
    if (!active) return
    guarded(agent, source)
    await state.flush()
  })
  const stopTools = ctx.on('tools/change', () => {
    if (!refreshingWorkflow) workflowEpoch++
  })
  const stopDisposed = ctx.on('agent/disposed', ({ agent }) => {
    const prepared = installed.get(agent)
    installed.delete(agent)
    disposePrepared(prepared)
    sessions.delete(agent.session.id)
  })
  const stopSession = ctx.on('session/event', (session, event) => {
    if (event.type !== 'sandbox/mode' || sandboxModeOf(event.data) === 'read-only') return
    if (!isReadOnlySession(session) || queuedPins.has(session)) return
    queuedPins.add(session)
    // Attached Sessions forbid append reentry while notifying observers.
    // The tool guard refuses shell execution while the latest mode is writable;
    // restore the mode once this synchronous publication has finished.
    queueMicrotask(() => {
      queuedPins.delete(session)
      if (!active) return
      try {
        if (isReadOnlySession(session)) holdReadOnly(session)
      } catch (error) {
        ctx.logger.warn(
          `rolesubagents: could not re-pin read-only on session ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })
  })
  // Agents that already exist are prepared once the stored state is readable.
  void state.ready
    .then(async () => {
      if (!active) return
      for (const agent of ctx.agents.list()) guarded(agent, 'resume')
      await state.flush()
    })
    .catch(error => ctx.logger.warn(`rolesubagents: could not restore active agents: ${String(error)}`))

  const unsubscribe = (stop: unknown): void => {
    if (typeof stop === 'function') stop()
  }

  ctx.effect(
    () => async () => {
      active = false
      unsubscribe(stopCreated)
      unsubscribe(stopTools)
      unsubscribe(stopDisposed)
      unsubscribe(stopSession)
      for (const prepared of installed.values()) disposePrepared(prepared)
      installed.clear()
      sessions.clear()
      pending.clear()
      await state.close()
    },
    'rolesubagents: scoped tools',
  )
}
