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
 *
 * Roles with a `runner` run their child once on an external CLI instead
 * (`external/`): `delegate` starts it through an ephemeral DSH provider, and
 * this entry owns the live runs so they are disposed when the plugin unloads.
 * `ctx.subprocess` and `ctx.sandboxPolicy` are read lazily with `ctx.get`;
 * they are not in `inject` because DSH roles must keep working without them
 * (this Cordis version has no optional-inject form).
 */

import { homedir } from 'node:os'
import z from '@deepseek-ai/schemastery'
import {
  DEFAULT_ROLES,
  normalizeSettings,
  type RoleDefinition,
  type RoleSettings,
  roleContextText,
  selectableRoles,
} from '../shared/roles.ts'
import type { RunTracker } from './external/engine.ts'
import { mountProbeService } from './external/probe-service.ts'
import { type AdapterLookup, CLI_ADAPTERS, defaultAdapterLookup } from './external/registry.ts'
import type { AgentPort, HostContext, SessionPort } from './ports.ts'
import { holdReadOnly, lastSandboxMode, readOnlyCallDenial, sandboxModeOf } from './readonly.ts'
import { mountRoleDisplayService } from './role-display-service.ts'
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
  /** Per-CLI executable and forwarded variable names; normalized on every read. */
  clis: Live<unknown>
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
  clis: z.any().default({}).volatile(),
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

/** Test and integration seams; the Host never passes these. */
export interface ApplyOptions {
  /** Replaces the adapter registry (the integration harness uses a test adapter). */
  readonly adapters?: AdapterLookup
}

export function apply(ctx: HostContext, config: Partial<Config> = {}, options: ApplyOptions = {}): void {
  const spawnProvider = config.spawnProvider ?? 'spawn'
  const forkProvider = config.forkProvider ?? 'fork'
  const state = createRoleState(ctx)
  /** Set by the effect cleanup: late callbacks (storage opening, probe import) must not touch an inactive context. */
  let disposed = false
  /** Run work after the store is ready, unless the plugin was unloaded first; never rejects. */
  const whenReady = (label: string, task: () => void): void => {
    state.ready
      .then(() => {
        if (disposed) return
        try {
          task()
        } catch (error) {
          if (!disposed) {
            ctx.logger.warn(`rolesubagents: ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      })
      .catch(() => {
        // `ready` never rejects today; a future rejection must not become an unhandled rejection.
      })
  }
  whenReady('storage check', () => {
    if (state.degraded) {
      ctx.logger.warn(
        `rolesubagents: role state is kept in memory only: ${state.degradedReason ?? 'storage unavailable'}`,
      )
    }
  })
  /** Live external runs; disposed on unload (DSH does not stop them when a plugin unloads). */
  const runs: RunTracker = new Set()
  /** Aborted on unload: a delegation still starting (executable lookup, files, pre-flight) then never spawns. */
  const lifetime = new AbortController()
  const pending = new Map<string, PendingChild>()
  const installed = new Map<AgentPort, Prepared>()
  const sessions = new Map<string, SessionState>()
  /** Sessions whose live role is read-only, including the moment before the role record is written. */
  const readOnlySessions = new WeakSet<SessionPort>()
  let lastProblems = ''

  const currentSettings = (): RoleSettings => {
    const { settings, problems } = normalizeSettings({
      enabled: read(config.enabled, true),
      roles: read(config.roles, DEFAULT_ROLES as unknown[]),
      workflowModel: read(config.workflowModel, null),
      clis: read(config.clis, null),
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

  const external = {
    engine: { subprocess: () => ctx.get('subprocess'), logger: ctx.logger, runs, lifetime: lifetime.signal },
    adapters: options.adapters ?? defaultAdapterLookup,
    cliSettings: () => currentSettings().clis,
  }

  const install = (agent: AgentPort, snapshot: RoleSettings): void => {
    if (installed.has(agent)) return
    const definition = buildTool(snapshot, { ctx, spawnProvider, forkProvider, pending, state, external })
    const prepared: Prepared = { snapshot }
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
    try {
      onCreated(agent)
    } catch (error) {
      // A read-only child must not start writable: abort its creation.
      if (pending.get(agent.id)?.role.readOnly === true) throw error
      // Anything else only costs this Agent the tool; a throw would abort its creation.
      ctx.logger.warn(
        `rolesubagents: could not prepare agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const stopCreated = ctx.on('agent/created', ({ agent, source }) => guarded(agent, source))
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
    if (!isReadOnlySession(session)) return
    try {
      holdReadOnly(session)
    } catch (error) {
      ctx.logger.warn(
        `rolesubagents: could not re-pin read-only on session ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })
  // Agents that already exist are prepared once the stored state is readable.
  whenReady('preparing existing agents', () => {
    for (const agent of ctx.agents.list()) guarded(agent, 'resume')
  })

  // Adapter housekeeping (e.g. stale generated files) runs once per plugin start; failures are only logged.
  for (const adapter of new Set(Object.values(CLI_ADAPTERS))) {
    const housekeeping = adapter.housekeeping?.bind(adapter)
    if (housekeeping === undefined) continue
    Promise.resolve()
      .then(() => housekeeping(process.env.HOME ?? homedir()))
      .catch(error => {
        if (disposed) return
        ctx.logger.warn(
          `rolesubagents: ${adapter.descriptor.displayName} housekeeping failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
  }

  void mountRoleDisplayService(ctx, { state, isDisposed: () => disposed })

  void mountProbeService(ctx, {
    subprocess: () => ctx.get('subprocess'),
    adapters: options.adapters ?? defaultAdapterLookup,
    cliSettings: () => currentSettings().clis,
    isDisposed: () => disposed,
  })

  const unsubscribe = (stop: unknown): void => {
    if (typeof stop === 'function') stop()
  }

  ctx.effect(
    () => () => {
      disposed = true
      lifetime.abort(new Error('the rolesubagents plugin was unloaded'))
      for (const run of [...runs]) {
        run.dispose().catch(error => {
          ctx.logger.warn(
            `rolesubagents: could not stop external run ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
      }
      runs.clear()
      unsubscribe(stopCreated)
      unsubscribe(stopTools)
      unsubscribe(stopDisposed)
      unsubscribe(stopSession)
      for (const prepared of installed.values()) disposePrepared(prepared)
      installed.clear()
      sessions.clear()
      pending.clear()
      void state.close()
    },
    'rolesubagents: scoped tools',
  )
}
