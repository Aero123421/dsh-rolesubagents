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
import type { CliId } from '../shared/cli/index.ts'
import type { ProbeResult } from './external/types.ts'
import { createManagementAudit } from './management/audit.ts'
import { managementAuthorization } from './management/auth.ts'
import { createManagementCatalog, type CatalogDeps } from './management/catalog.ts'
import { createRoleManagement } from './management/service.ts'
import { roleCatalogRevision } from './management/session.ts'
import {
  ManagementFailure,
  managementSettings,
  ownManagementNamespace,
  ownManagementRawConfig,
} from './management/settings.ts'
import { mountManagementRemote } from './management/remote.ts'
import { buildManagementTool, MANAGEMENT_TOOL_NAME } from './management/tool.ts'
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
  /** Separate live permission for AI role administration; never inherited through a Session snapshot. */
  allowAiRoleManagement?: Live<boolean>
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
  allowAiRoleManagement: z.boolean().default(false).volatile(),
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
  delegateEpoch: number
  lifetime: AbortController
  refreshingRoles?: boolean
  management?: () => void
  managementGuard?: () => void
  managementDeny?: () => void
}

/** Test and integration seams; the Host never passes these. */
export interface ApplyOptions {
  /** Replaces the adapter registry (the integration harness uses a test adapter). */
  readonly adapters?: AdapterLookup
  /** Only isolated tests bypass Loader entry ownership resolution. Never supplied by the Host. */
  readonly managementNamespace?: () => string | undefined
  readonly managementRawConfig?: () => unknown
}

export function apply(ctx: HostContext, config: Partial<Config> = {}, options: ApplyOptions = {}): void {
  const spawnProvider = config.spawnProvider ?? 'spawn'
  const forkProvider = config.forkProvider ?? 'fork'
  const state = createRoleState(ctx)
  /** Set by the effect cleanup: late callbacks (storage opening, probe import) must not touch an inactive context. */
  let disposed = false
  let stateReady = false
  void state.ready.then(() => {
    stateReady = true
  })
  const disposedAgents = new WeakSet<AgentPort>()
  /** Run work after the store is ready, unless the plugin was unloaded first; never rejects. */
  const whenReady = (label: string, task: () => void | Promise<void>): void => {
    state.ready
      .then(async () => {
        if (disposed) return
        try {
          await task()
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
  /** Undisposed external runs; drained on unload, even when their results already settled. */
  const runs: RunTracker = new Set()
  /** Aborted on unload: a delegation still starting (executable lookup, files, pre-flight) then never spawns. */
  const lifetime = new AbortController()
  const pending = new Map<string, PendingChild>()
  const installed = new Map<AgentPort, Prepared>()
  /** Shield tentative storage candidates until validation/publication (also across Agent replacement). */
  const refreshingCatalogs = new Map<string, RoleSettings>()
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
    // A prompt/authorization read can precede storage opening; do not cache an incomplete image.
    if (!stateReady) return undefined
    const sessionState = stateOf(agent.session.id)
    if (sessionState.role === undefined) sessionState.role = state.readRole(agent.session) ?? null
    return sessionState.role ?? undefined
  }

  /** The role list an Agent's Session runs with, recording one when the Session has none yet. */
  const snapshotFor = (agent: AgentPort): RoleSettings => {
    const committed = refreshingCatalogs.get(agent.session.id)
    if (committed) return committed
    const recorded = state.readSnapshot(agent.session)
    if (recorded !== undefined) return recorded
    const parentId = agent.session.header.parentSession
    const parentSession = parentId === undefined ? undefined : ctx.get('sessions')?.get(parentId)
    const snapshot =
      (parentId === undefined ? undefined : refreshingCatalogs.get(parentId)) ??
      (parentSession === undefined ? undefined : state.readSnapshot(parentSession)) ??
      currentSettings()
    state.writeSnapshot(agent.session, snapshot)
    return snapshot
  }

  const isReadOnlySession = (session: SessionPort): boolean => {
    if (readOnlySessions.has(session)) return true
    return state.readRole(session)?.readOnly === true
  }

  const disposePrepared = (prepared: Prepared | undefined): void => {
    prepared?.lifetime.abort()
    prepared?.guard?.()
    prepared?.workflow?.()
    prepared?.tool?.()
    prepared?.management?.()
    prepared?.managementGuard?.()
    prepared?.managementDeny?.()
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
    engine: {
      subprocess: () => ctx.get('subprocess'),
      sandbox: () => ctx.get('sandbox'),
      logger: ctx.logger,
      runs,
      lifetime: lifetime.signal,
    },
    adapters: options.adapters ?? defaultAdapterLookup,
    cliSettings: () => currentSettings().clis,
  }

  const audit = createManagementAudit(() => ctx.get('storageDomain'))
  const referenceProbes = new Map<CliId, { result: ProbeResult; settings: string; fetchedAt: string }>()
  const referenceCatalog = createManagementCatalog({
    llm: () => ctx.get('llm') as ReturnType<CatalogDeps['llm']>,
    hostEnv: process.env,
    cliSettings: () => currentSettings().clis,
    sandboxAvailable: () => typeof ctx.get('sandbox')?.confine === 'function',
    cachedProbe: cli => {
      const cached = referenceProbes.get(cli)
      if (!cached || cached.settings !== JSON.stringify(currentSettings().clis?.[cli] ?? {})) return undefined
      return { models: cached.result.models, found: cached.result.found, fetchedAt: cached.fetchedAt }
    },
  })
  const authorizeManagement = managementAuthorization({
    isDisposed: () => disposed,
    isCurrentAgent: agent => installed.has(agent),
    isRecordedChild: agent => pending.has(agent.id) || roleOf(agent) !== undefined,
    isReadOnly: agent => isReadOnlySession(agent.session),
    sandboxPolicy: () => ctx.get('sandboxPolicy'),
  })
  function registerDelegate(agent: AgentPort, prepared: Prepared): void {
    const epoch = ++prepared.delegateEpoch
    const snapshot = prepared.snapshot
    prepared.tool?.()
    prepared.tool = undefined
    stateOf(agent.session.id).toolInstalled = false
    const definition = buildTool(snapshot, {
      ctx,
      spawnProvider,
      forkProvider,
      pending,
      state,
      external,
      lifetime: AbortSignal.any([lifetime.signal, prepared.lifetime.signal]),
      isAlive: caller => !disposed && caller === agent && installed.get(agent) === prepared,
      isCurrent: caller =>
        !disposed &&
        caller === agent &&
        installed.get(agent) === prepared &&
        prepared.delegateEpoch === epoch &&
        prepared.snapshot === snapshot,
    })
    if (definition) {
      prepared.tool = agent.ctx.tools.register(definition)
      stateOf(agent.session.id).toolInstalled = true
    }
  }
  const currentRefreshes = new Set<Promise<void>>()
  const namespace = options.managementNamespace ?? ownManagementNamespace(ctx)
  const roleSettings = managementSettings({
    settings: () => ctx.get('settings'),
    namespace,
    rawConfig:
      options.managementRawConfig ?? (options.managementNamespace ? undefined : ownManagementRawConfig(ctx, namespace)),
  })
  const management = createRoleManagement({
    lifetime: lifetime.signal,
    settings: roleSettings,
    authorize: authorizeManagement,
    catalog: referenceCatalog,
    audit,
    active: agent => {
      const prepared = installed.get(agent)
      return prepared
        ? {
            revision: roleCatalogRevision(prepared.snapshot),
            enabled: prepared.snapshot.enabled,
            roles: prepared.snapshot.roles,
          }
        : undefined
    },
    async applyCurrent(agent, roles, expectedSessionRevision, revalidate) {
      revalidate()
      const prepared = installed.get(agent)!
      const previous = prepared.snapshot
      const oldRevision = roleCatalogRevision(previous)
      if (oldRevision !== expectedSessionRevision)
        return {
          applied: false,
          durable: false,
          revision: oldRevision,
          code: 'session-revision-conflict',
          outcome: 'unchanged',
        }
      if (prepared.refreshingRoles || refreshingCatalogs.has(agent.session.id))
        return {
          applied: false,
          durable: false,
          revision: oldRevision,
          code: 'session-refresh-busy',
          outcome: 'unchanged',
        }
      if (state.degraded)
        return {
          applied: false,
          durable: false,
          revision: oldRevision,
          code: 'session-storage-unavailable',
          outcome: 'unchanged',
        }
      const next = { ...previous, roles: structuredClone(roles) as RoleDefinition[] }
      const nextRevision = roleCatalogRevision(next)
      prepared.refreshingRoles = true
      refreshingCatalogs.set(agent.session.id, previous)
      let finish = () => {}
      const settled = new Promise<void>(resolve => {
        finish = resolve
      })
      currentRefreshes.add(settled)
      let attempted = false
      let persisted = false
      let rebound = false
      try {
        await state.flush()
        if (state.degraded)
          return {
            applied: false,
            durable: false,
            revision: oldRevision,
            code: 'session-storage-unavailable',
            outcome: 'unchanged',
          }
        revalidate()
        if (nextRevision === oldRevision && (prepared.tool !== undefined || selectableRoles(previous).length === 0))
          return { applied: true, durable: true, revision: oldRevision, outcome: 'applied' }
        attempted = true
        state.writeSnapshot(agent.session, next)
        await state.flush()
        persisted = true
        revalidate()
        rebound = true
        prepared.snapshot = next
        registerDelegate(agent, prepared)
        return { applied: true, durable: true, revision: nextRevision, outcome: 'applied' }
      } catch (error) {
        prepared.snapshot = previous
        if (rebound && !disposed && installed.get(agent) === prepared) {
          try {
            registerDelegate(agent, prepared)
          } catch {
            ctx.logger.warn('rolesubagents: could not restore the delegate catalog after a failed refresh')
          }
        }
        let restored = !attempted
        if (attempted) {
          try {
            state.writeSnapshot(agent.session, previous)
            await state.flush()
            restored = true
          } catch {
            /* No shared transaction: restoration may be unconfirmed. */
          }
        }
        return {
          applied: false,
          durable: false,
          revision: oldRevision,
          code: !restored
            ? 'session-rollback-unconfirmed'
            : error instanceof ManagementFailure
              ? error.code
              : persisted
                ? 'delegate-refresh-failed'
                : 'session-storage-failed',
          outcome: !restored ? 'unknown' : attempted ? 'restored' : 'unchanged',
        }
      } finally {
        prepared.refreshingRoles = false
        finish()
        currentRefreshes.delete(settled)
        refreshingCatalogs.delete(agent.session.id)
      }
    },
  })
  const managementChild = (agent: AgentPort): boolean =>
    agent.session.header.origin === 'subagent' ||
    (agent.session.header.delegationDepth ?? 0) !== 0 ||
    pending.has(agent.id) ||
    roleOf(agent) !== undefined
  const refreshManagement = (agent: AgentPort, prepared: Prepared): void => {
    if (managementChild(agent)) {
      prepared.management?.()
      prepared.management = undefined
      if (read(config.allowAiRoleManagement, false)) {
        prepared.managementGuard ??= agent.ctx.tools.guard(call =>
          call.name === MANAGEMENT_TOOL_NAME || call.name.endsWith(`.${MANAGEMENT_TOOL_NAME}`)
            ? 'Child agents cannot administer role configuration.'
            : undefined,
        )
        prepared.managementDeny ??= agent.ctx.tools.restrict?.({ deny: [MANAGEMENT_TOOL_NAME] })
      }
      return
    }
    if (read(config.allowAiRoleManagement, false) && management.available(agent)) {
      if (!prepared.management) {
        const definition = buildManagementTool(
          agent,
          management,
          () => !disposed && installed.get(agent) === prepared && prepared.management !== undefined,
        )
        prepared.management = agent.ctx.tools.register(definition)
      }
    } else {
      prepared.management?.()
      prepared.management = undefined
    }
  }
  const install = (agent: AgentPort, snapshot: RoleSettings): void => {
    if (installed.has(agent)) return
    const prepared: Prepared = { snapshot, delegateEpoch: 0, lifetime: new AbortController() }
    installed.set(agent, prepared)
    registerDelegate(agent, prepared)
    const role = roleOf(agent)
    if (role?.readOnly === true) {
      readOnlySessions.add(agent.session)
      prepared.guard = agent.ctx.tools.guard(call =>
        readOnlyCallDenial(
          call.name,
          call.arguments,
          selectableRoles(prepared.snapshot),
          lastSandboxMode(agent.session),
        ),
      )
    }
    refreshWorkflow(agent, prepared)
    refreshManagement(agent, prepared)
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
    if (roleOf(agent)?.readOnly === true) pinReadOnly(agent)
    const snapshot = snapshotFor(agent)
    install(agent, snapshot)
  }

  ctx.systemPrompt.context({
    name: 'rolesubagents:role',
    order: ROLE_CONTEXT_ORDER,
    interpolate: false,
    required: true,
    text: ({ agent }) => {
      if (disposed || agent === undefined || disposedAgents.has(agent)) return ''
      const prepared = installed.get(agent)
      if (prepared !== undefined) {
        refreshWorkflow(agent, prepared)
        refreshManagement(agent, prepared)
      }
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

  const guarded = async (agent: AgentPort, _source: string): Promise<void> => {
    await state.ready
    if (disposed || disposedAgents.has(agent)) return
    let failClosed = pending.get(agent.id)?.role.readOnly === true || readOnlySessions.has(agent.session)
    try {
      failClosed ||= state.readRole(agent.session)?.readOnly === true
      onCreated(agent)
      // Native agent/created is serially awaited before the first turn.
      await state.flush()
    } catch (error) {
      if (disposed || disposedAgents.has(agent)) return
      const prepared = installed.get(agent)
      installed.delete(agent)
      disposePrepared(prepared)
      stateOf(agent.session.id).toolInstalled = false
      // Restored roles must fail closed just like reserved children, including partial installation.
      if (failClosed) throw error
      // Anything else only costs this Agent the tool; a throw would abort its creation.
      ctx.logger.warn(
        `rolesubagents: could not prepare agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const stopCreated = ctx.on('agent/created', ({ agent, source }) => guarded(agent, source))
  const stopTools = ctx.on('tools/change', () => {
    if (!disposed && !refreshingWorkflow) workflowEpoch++
  })
  // Volatile commits update all live references before this event. Visibility follows on/off;
  // execution independently checks the authoritative settings descriptor and its CAS revision.
  const onDynamic = ctx.on.bind(ctx) as unknown as (event: string, listener: (...args: unknown[]) => void) => unknown
  const stopManagement = onDynamic('loader/volatile-update', () => {
    if (disposed) return
    referenceCatalog.invalidate()
    if (!read(config.allowAiRoleManagement, false)) management.revoke()
    for (const [agent, prepared] of installed) refreshManagement(agent, prepared)
  })
  const stopModelCatalog = onDynamic('llm/adapters-updated', () => {
    if (!disposed) referenceCatalog.invalidate('dsh')
  })
  const repins = new Set<SessionPort>()
  const stopDisposed = ctx.on('agent/disposed', ({ agent }) => {
    if (disposed) return
    disposedAgents.add(agent)
    repins.delete(agent.session)
    management.disposeAgent(agent)
    const prepared = installed.get(agent)
    installed.delete(agent)
    disposePrepared(prepared)
    sessions.delete(agent.session.id)
  })
  const stopSession = ctx.on('session/event', (session, event) => {
    if (disposed || event.type !== 'sandbox/mode' || sandboxModeOf(event.data) === 'read-only') return
    if (!isReadOnlySession(session) || repins.has(session)) return
    repins.add(session)
    // Session publication is synchronous and non-reentrant. Append only after every listener saw the event.
    queueMicrotask(() => {
      if (!repins.delete(session) || disposed) return
      try {
        holdReadOnly(session)
      } catch (error) {
        ctx.logger.warn(
          `rolesubagents: could not re-pin read-only on session ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    })
  })
  // Already-live agents have no creation caller to reject; clean up and log each failure independently.
  whenReady('preparing existing agents', async () => {
    for (const agent of ctx.agents.list()) {
      try {
        await guarded(agent, 'resume')
      } catch (error) {
        if (!disposed) ctx.logger.warn(`rolesubagents: could not prepare existing agent ${agent.id}: ${String(error)}`)
      }
    }
  })

  // Adapter housekeeping (e.g. stale generated files) runs once per plugin start; failures are only logged.
  for (const adapter of new Set(Object.values(CLI_ADAPTERS))) {
    const housekeeping = adapter.housekeeping?.bind(adapter)
    if (housekeeping === undefined) continue
    Promise.resolve()
      .then(() => {
        if (!disposed) return housekeeping(process.env.HOME ?? homedir())
      })
      .catch(error => {
        if (disposed) return
        ctx.logger.warn(
          `rolesubagents: ${adapter.descriptor.displayName} housekeeping failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
  }

  void mountRoleDisplayService(ctx, { state, isDisposed: () => disposed, lifetime: lifetime.signal })

  void mountManagementRemote(ctx, {
    isDisposed: () => disposed,
    writeSafety: revision => roleSettings.writeSafety(revision),
  })
  void mountProbeService(ctx, {
    subprocess: () => ctx.get('subprocess'),
    adapters: options.adapters ?? defaultAdapterLookup,
    cliSettings: () => currentSettings().clis,
    isDisposed: () => disposed,
    onResult: (result, admittedSettings) => {
      if (disposed) return
      referenceProbes.set(result.cli, {
        result,
        settings: JSON.stringify(admittedSettings[result.cli] ?? {}),
        fetchedAt: new Date().toISOString(),
      })
      referenceCatalog.invalidate(result.cli)
    },
  })

  const unsubscribe = (stop: unknown): void => {
    if (typeof stop === 'function') stop()
  }

  ctx.effect(
    () => () => {
      disposed = true
      repins.clear()
      lifetime.abort(new Error('the rolesubagents plugin was unloaded'))
      const runClosings = [...runs].map(async run => {
        try {
          await run.dispose()
        } catch (error) {
          ctx.logger.warn(
            `rolesubagents: could not stop external run ${run.id}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      })
      runs.clear()
      unsubscribe(stopCreated)
      unsubscribe(stopTools)
      unsubscribe(stopManagement)
      unsubscribe(stopModelCatalog)
      management.dispose()
      const auditClosing = audit
        .close()
        .catch(() => ctx.logger.warn('rolesubagents: could not close role-management audit storage'))
      unsubscribe(stopDisposed)
      unsubscribe(stopSession)
      for (const prepared of installed.values()) disposePrepared(prepared)
      installed.clear()
      sessions.clear()
      pending.clear()
      return Promise.allSettled([...runClosings, ...currentRefreshes])
        .then(async () => {
          await auditClosing
          await state.close()
        })
        .catch(() => ctx.logger.warn('rolesubagents: could not close Session role storage'))
    },
    'rolesubagents: scoped tools',
  )
}
