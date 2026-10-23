/** One authority for model-facing role administration; no caller-controlled namespaces or config paths. */
import { randomUUID } from 'node:crypto'
import { CLI_IDS, isCliId, type AccessLevel } from '../../shared/cli/index.ts'
import { RoleManagementError, previewRoleChanges, type RoleChange } from '../../shared/role-management.ts'
import { normalizeSettings, ROLE_ID_PATTERN, type RoleDefinition } from '../../shared/roles.ts'
import type { AgentPort } from '../ports.ts'
import type { ManagementAudit, ManagementAuditEntry } from './audit.ts'
import type { createManagementCatalog } from './catalog.ts'
import { ManagementFailure, type managementSettings } from './settings.ts'
import { roleManagementHelp } from './help.ts'

export interface ActiveRoleCatalog {
  readonly revision: string
  readonly enabled: boolean
  readonly roles: readonly RoleDefinition[]
}
export interface CurrentCatalogResult {
  readonly applied: boolean
  readonly durable: boolean
  readonly revision: string
  readonly code?: string
  readonly outcome?: 'applied' | 'unchanged' | 'restored' | 'persisted-not-published' | 'unknown'
}
export interface ManagementDeps {
  readonly settings: ReturnType<typeof managementSettings>
  readonly authorize: (agent: AgentPort | undefined, mutation: boolean) => AccessLevel
  readonly catalog: ReturnType<typeof createManagementCatalog>
  readonly active: (agent: AgentPort) => ActiveRoleCatalog | undefined
  readonly applyCurrent: (
    agent: AgentPort,
    roles: readonly RoleDefinition[],
    expectedSessionRevision: string,
    revalidate: () => void,
  ) => Promise<CurrentCatalogResult>
  readonly audit: Pick<ManagementAudit, 'list' | 'append'>
  readonly now?: () => number
  readonly token?: () => string
  readonly planTtlMs?: number
  readonly lifetime?: AbortSignal
  readonly metadataTimeoutMs?: number
}
export type ManagementReply = Readonly<Record<string, unknown>>
interface Plan {
  readonly owner: AgentPort
  readonly expires: number
  readonly revision: number
  readonly changes: readonly RoleChange[]
  result?: ManagementReply
  pending?: Promise<ManagementReply>
}
const ACTIONS = ['help', 'list', 'get', 'capabilities', 'models', 'preview', 'apply', 'apply_current'] as const
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const ownKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every(k => keys.includes(k))
function fixed(code: string, text: string): never {
  throw new ManagementFailure(code, text)
}
const revision = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : fixed('invalid-request', 'A settings revision returned by list/get is required.')
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max
const mutation = (action: string) => action === 'preview' || action === 'apply' || action === 'apply_current'
function knownRoles(value: Readonly<Record<string, unknown>>) {
  const result = normalizeSettings({ enabled: true, roles: value.roles })
  return {
    roles: result.settings.roles,
    repairNeeded: result.problems.length > 0,
    problems: result.problems.map(p => ({
      code: p.code,
      ...(typeof p.id === 'string' && ROLE_ID_PATTERN.test(p.id) ? { id: p.id } : {}),
    })),
  }
}
function summary(role: RoleDefinition) {
  const { instructions, description, ...rest } = role
  return { ...rest, description: description.slice(0, 250), instructionsCharacters: instructions.length }
}
function safeDiff(diff: ReturnType<typeof previewRoleChanges>['diff']) {
  return diff.map(d => ({
    op: d.op,
    id: d.id,
    fields: d.fields,
    ...(d.before ? { before: summary(d.before) } : {}),
    ...(d.after ? { after: summary(d.after) } : {}),
  }))
}
export function managementError(error: unknown): ManagementReply {
  if (record(error) && error.code === 'catalog-invalidated')
    return {
      ok: false,
      code: 'catalog-invalidated',
      message: 'Model metadata changed during lookup. Request fresh metadata before selecting a model.',
    }
  if (error instanceof ManagementFailure || error instanceof RoleManagementError) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      ...(error instanceof RoleManagementError && error.issues ? { issues: error.issues } : {}),
    }
  }
  return {
    ok: false,
    code: 'management-failed',
    message: 'Role administration could not complete. Read the current role settings before retrying.',
  }
}

export function createRoleManagement(deps: ManagementDeps) {
  const plans = new Map<string, Plan>()
  const actors = new Map<AgentPort, AbortController>()
  let closed = false
  const now = deps.now ?? Date.now
  const token = deps.token ?? randomUUID
  const ttl = deps.planTtlMs ?? 10 * 60_000
  function allowed(agent: AgentPort | undefined, write: boolean) {
    if (closed) fixed('management-unavailable', 'Role management is no longer active.')
    const ceiling = deps.authorize(agent, write)
    const current = deps.settings.read()
    if (!current.allowed) fixed('management-disabled', 'AI role management is disabled in the plugin settings.')
    if (write && !current.literalRolesSupported)
      fixed(
        'expression-backed-role-settings',
        'Executable or unsupported role configuration cannot be safely rewritten as evaluated values. Edit the native profile instead.',
      )
    return { agent: agent!, ceiling, current }
  }
  function active(agent: AgentPort) {
    try {
      const current = deps.active(agent)
      return current
        ? {
            available: true,
            revision: current.revision,
            enabled: current.enabled,
            roleIds: current.roles.filter(r => r.enabled).map(r => r.id),
          }
        : { available: false }
    } catch {
      return { available: false }
    }
  }
  async function audit(
    agent: AgentPort,
    operation: ManagementAuditEntry['operation'],
    ids: readonly string[],
    fields: readonly string[],
    before: number,
    after: number,
  ) {
    try {
      return await deps.audit.append({
        id: token(),
        at: new Date(now()).toISOString(),
        sessionId: agent.session.id,
        agentId: agent.id,
        operation,
        roleIds: ids,
        fields: [...new Set(fields)],
        baseRevision: before,
        observedRevision: after,
      })
    } catch {
      return false
    }
  }
  function parse(raw: unknown): Record<string, unknown> & { action: (typeof ACTIONS)[number] } {
    if (!record(raw) || typeof raw.action !== 'string' || !ACTIONS.includes(raw.action as (typeof ACTIONS)[number]))
      fixed('invalid-request', 'Choose a supported manage_roles action.')
    const args = raw as Record<string, unknown> & { action: (typeof ACTIONS)[number] }
    const keys: Record<(typeof ACTIONS)[number], readonly string[]> = {
      help: ['action'],
      list: ['action'],
      get: ['action', 'id'],
      capabilities: ['action', 'target'],
      models: ['action', 'target', 'provider', 'query', 'limit', 'offset', 'refresh'],
      preview: ['action', 'expectedRevision', 'changes'],
      apply: ['action', 'planId'],
      apply_current: ['action', 'expectedRevision', 'expectedSessionRevision'],
    }
    if (!ownKeys(args, keys[args.action]))
      fixed(
        'invalid-request',
        'This action contains unsupported fields; configuration paths and permission switches are not accepted.',
      )
    return args
  }
  async function executeUnsafe(
    actor: AgentPort | undefined,
    raw: unknown,
    signal?: AbortSignal,
  ): Promise<ManagementReply> {
    const args = parse(raw)
    const { agent, ceiling, current } = allowed(actor, mutation(args.action))
    signal?.throwIfAborted()
    if (args.action === 'help') return roleManagementHelp()
    if (args.action === 'list') {
      const projection = knownRoles(current.value)
      const history = await deps.audit.list().catch(() => ({ entries: [], durable: false }))
      allowed(agent, false)
      return {
        ok: true,
        kind: 'roles',
        revision: current.revision,
        globalEnabled: current.value.enabled !== false,
        ...projection,
        roles: projection.roles.map(summary),
        currentSession: active(agent),
        appliesTo: 'new-root-sessions-unless-explicitly-applied',
        history,
      }
    }
    if (args.action === 'get') {
      if (!text(args.id, 32) || !ROLE_ID_PATTERN.test(args.id)) fixed('invalid-request', 'A valid role id is required.')
      const projection = knownRoles(current.value)
      const role = projection.roles.find(r => r.id === args.id)
      if (!role) fixed('role-not-found', 'The saved role does not exist.')
      return {
        ok: true,
        kind: 'role',
        revision: current.revision,
        role,
        repairNeeded: projection.repairNeeded,
        currentSession: active(agent),
      }
    }
    if (args.action === 'capabilities') {
      if (args.target !== undefined && args.target !== 'dsh' && !isCliId(args.target))
        fixed('invalid-request', `Choose dsh or a supported CLI (${CLI_IDS.join(', ')}).`)
      const value = await deps.catalog.capabilities(args.target as 'dsh' | (typeof CLI_IDS)[number] | undefined)
      signal?.throwIfAborted()
      allowed(agent, false)
      return {
        ok: true,
        kind: 'capabilities',
        revision: current.revision,
        value,
        scope: 'role-definitions-only',
        forbidden: [
          'management-switch',
          'plugin-switch',
          'cli-executable',
          'environment',
          'credentials',
          'arbitrary-agent-preset',
        ],
        currentSession: active(agent),
      }
    }
    if (args.action === 'models') {
      if (args.target !== 'dsh' && !isCliId(args.target)) fixed('invalid-request', 'Choose a supported model target.')
      for (const field of ['provider', 'query'] as const)
        if (args[field] !== undefined && !text(args[field], 256))
          fixed('invalid-request', 'The model provider/query is invalid.')
      for (const field of ['limit', 'offset'] as const)
        if (
          args[field] !== undefined &&
          (typeof args[field] !== 'number' || !Number.isSafeInteger(args[field]) || args[field] < 0)
        )
          fixed('invalid-request', 'Model pagination must use nonnegative integers.')
      if (args.refresh !== undefined && typeof args.refresh !== 'boolean')
        fixed('invalid-request', 'refresh must be boolean.')
      const value = await deps.catalog.models(
        {
          target: args.target as 'dsh' | (typeof CLI_IDS)[number],
          ...(args.provider === undefined ? {} : { provider: args.provider as string }),
          ...(args.query === undefined ? {} : { query: args.query as string }),
          ...(args.limit === undefined ? {} : { limit: args.limit as number }),
          ...(args.offset === undefined ? {} : { offset: args.offset as number }),
          ...(args.refresh === undefined ? {} : { refresh: args.refresh as boolean }),
        },
        signal,
      )
      signal?.throwIfAborted()
      allowed(agent, false)
      return { ok: true, kind: 'models', revision: current.revision, value }
    }
    if (args.action === 'preview') {
      if (revision(args.expectedRevision) !== current.revision)
        fixed('revision-conflict', 'Settings changed. Read the current catalog before previewing.')
      if (!Array.isArray(args.changes)) fixed('invalid-request', 'A bounded list of role changes is required.')
      let changes: readonly RoleChange[]
      try {
        changes = structuredClone(args.changes) as RoleChange[]
      } catch {
        return fixed('invalid-request', 'Role changes must contain only configuration data.')
      }
      const result = previewRoleChanges(current.value, changes, ceiling)
      for (const [id, plan] of plans) if (plan.expires <= now()) plans.delete(id)
      if (plans.size >= 100 || [...plans.values()].filter(p => p.owner === agent).length >= 20)
        fixed('too-many-plans', 'Too many pending plans. Apply an existing plan or wait for expiry.')
      const planId = token()
      const expires = now() + ttl
      plans.set(planId, { owner: agent, expires, revision: current.revision, changes })
      return {
        ok: true,
        kind: 'preview',
        planId,
        revision: current.revision,
        expiresAt: new Date(expires).toISOString(),
        changes: safeDiff(result.diff),
        noChange: result.diff.length === 0,
        currentSession: active(agent),
        nextAction: 'apply',
        appliesTo: 'new-root-sessions-unless-explicitly-applied',
      }
    }
    if (args.action === 'apply') {
      if (!text(args.planId, 128)) fixed('invalid-request', 'A preview plan id is required.')
      const plan = plans.get(args.planId)
      if (!plan || plan.owner !== agent)
        fixed('plan-unavailable', 'This preview plan does not belong to the current live caller.')
      if (plan.expires <= now()) {
        plans.delete(args.planId)
        fixed('plan-expired', 'The preview expired. Read and preview again.')
      }
      if (plan.result) return { ...plan.result, replayed: true }
      if (plan.pending) return plan.pending
      plan.pending = (async () => {
        const fresh = allowed(agent, true)
        if (fresh.current.revision !== plan.revision)
          fixed(
            'revision-conflict',
            'Settings changed after preview. Create a new preview; no automatic retry was made.',
          )
        const result = previewRoleChanges(fresh.current.value, plan.changes, fresh.ceiling)
        signal?.throwIfAborted()
        if (!result.diff.length)
          return {
            ok: true,
            kind: 'applied',
            globalSaved: true,
            noChange: true,
            revision: fresh.current.revision,
            currentSession: active(agent),
            currentApplied: false,
          }
        const write = await deps.settings.writeRoles(fresh.current, result.rawRoles)
        const observed = write.observed?.revision
        const durableAudit = await audit(
          agent,
          'roles-change',
          result.diff.map(d => d.id),
          result.diff.flatMap(d => d.fields),
          plan.revision,
          observed ?? plan.revision,
        )
        return {
          ok: true,
          kind: 'applied',
          globalSaved: true,
          noChange: false,
          ...(observed === undefined ? { revisionUnknown: true } : { revision: observed }),
          auditDurable: durableAudit,
          changes: safeDiff(result.diff),
          currentApplied: false,
          currentSession: active(agent),
          nextAction:
            'Read the latest roles, then apply_current explicitly if wanted. Existing children and other sessions are unchanged.',
        }
      })()
      try {
        plan.result = await plan.pending
        return plan.result
      } finally {
        plan.pending = undefined
      }
    }
    if (revision(args.expectedRevision) !== current.revision)
      fixed('revision-conflict', 'Saved roles changed. Read them again before applying to this session.')
    if (!text(args.expectedSessionRevision, 128))
      fixed('invalid-request', 'The current session catalog revision is required.')
    const validated = previewRoleChanges(current.value, [], ceiling)
    signal?.throwIfAborted()
    const expectedSessionRevision = args.expectedSessionRevision
    const revalidate = () => {
      const fresh = allowed(agent, true)
      if (signal?.aborted)
        fixed('operation-aborted', 'Current-session refresh was interrupted; read its state before retrying.')
      if (fresh.current.namespace !== current.namespace || fresh.current.revision !== current.revision)
        fixed('revision-conflict', 'Saved settings changed during current-session refresh. Read them again.')
      if (deps.active(agent)?.revision !== expectedSessionRevision)
        fixed('session-revision-conflict', 'The current session catalog changed during refresh.')
    }
    let result: CurrentCatalogResult
    try {
      revalidate()
      result = await deps.applyCurrent(agent, validated.roles, expectedSessionRevision, revalidate)
    } catch (error) {
      return {
        ok: false,
        kind: 'current-applied',
        globalSaved: true,
        currentApplied: false,
        currentOutcome: 'unknown',
        sessionDurable: false,
        code: error instanceof ManagementFailure ? error.code : 'current-apply-failed',
        revision: current.revision,
        currentSession: active(agent),
        message:
          'The global roles remain saved. Current-session refresh could not be confirmed; read the current session state before retrying.',
      }
    }
    const currentAfter = active(agent)
    const durableAudit = result.applied
      ? await audit(
          agent,
          'apply-current',
          validated.roles.map(r => r.id),
          ['current-session-role-catalog'],
          current.revision,
          current.revision,
        )
      : false
    return {
      ok: result.applied,
      kind: 'current-applied',
      globalSaved: true,
      currentApplied: result.applied,
      sessionDurable: result.durable,
      sessionOutcome: result.outcome ?? (result.applied ? 'applied' : 'unknown'),
      sessionRevision: result.revision,
      ...(result.code ? { code: result.code } : {}),
      auditDurable: durableAudit,
      revision: current.revision,
      currentSession: currentAfter,
      appliesTo: 'future-delegations-of-this-parent-only',
      nextAction: result.applied
        ? 'enabled' in currentAfter && currentAfter.enabled === false
          ? 'The catalog is updated, but role delegation is disabled in this Session snapshot. Start a new root conversation after enabling it in the UI.'
          : 'Use the refreshed delegate tool on the next model/tool boundary; already-bound programs, existing children and other sessions are unchanged.'
        : 'The saved global roles remain saved. Read the current session state before retrying.',
    }
  }
  return {
    available(agent: AgentPort) {
      try {
        allowed(agent, false)
        return true
      } catch {
        return false
      }
    },
    async execute(agent: AgentPort | undefined, args: unknown, signal?: AbortSignal): Promise<ManagementReply> {
      let timer: ReturnType<typeof setTimeout> | undefined
      let combined: AbortSignal | undefined
      try {
        if (closed) fixed('management-unavailable', 'Role management is no longer active.')
        deps.authorize(agent, false)
        let actor = actors.get(agent!)
        if (!actor) {
          actor = new AbortController()
          actors.set(agent!, actor)
        }
        const signals = [actor.signal, ...(signal ? [signal] : []), ...(deps.lifetime ? [deps.lifetime] : [])]
        if (record(args) && args.action === 'models') {
          const deadline = new AbortController()
          const timeout = Math.max(1, Math.min(30_000, deps.metadataTimeoutMs ?? 10_000))
          timer = setTimeout(
            () =>
              deadline.abort(
                new ManagementFailure('metadata-timeout', 'Model metadata retrieval exceeded its time limit.'),
              ),
            timeout,
          )
          signals.push(deadline.signal)
        }
        combined = AbortSignal.any(signals)
        return await executeUnsafe(agent, args, combined)
      } catch (error) {
        if (error instanceof ManagementFailure || error instanceof RoleManagementError) return managementError(error)
        if (combined?.aborted)
          return combined.reason instanceof ManagementFailure
            ? managementError(combined.reason)
            : {
                ok: false,
                code: 'operation-aborted',
                message:
                  'Role management was interrupted. Read the current settings before retrying any admitted write.',
              }
        return managementError(error)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    },
    disposeAgent(agent: AgentPort) {
      actors.get(agent)?.abort()
      actors.delete(agent)
      for (const [id, plan] of plans) if (plan.owner === agent) plans.delete(id)
    },
    revoke() {
      for (const actor of actors.values()) actor.abort()
      actors.clear()
      plans.clear()
    },
    dispose() {
      closed = true
      for (const actor of actors.values()) actor.abort()
      actors.clear()
      plans.clear()
      deps.catalog.invalidate()
    },
  }
}
export type RoleManagement = ReturnType<typeof createRoleManagement>
