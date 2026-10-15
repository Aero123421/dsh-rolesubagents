/**
 * The role-aware `delegate` tool. One definition is built per Agent from that
 * Session's recorded role list and registered in the Agent's own scope, so the
 * schema never changes inside a Session and a child carries the same
 * definition as its parent (identical tool prefix, shared prompt cache).
 */

import { randomUUID } from 'node:crypto'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  FORK_RESULT_WARNING,
  forkInheritsHistory,
  type RoleDefinition,
  type RoleSettings,
  roleListLine,
  selectableRoles,
} from '../shared/roles.ts'
import type { AgentPort, ChildAgentOptions, HostContext } from './ports.ts'
import {
  eventsHaveParentTurns,
  lastSandboxMode,
  pinFailed,
  readOnlyCallDenial,
  sessionHasParentTurns,
} from './readonly.ts'
import { readRole } from './records.ts'

export const TOOL_NAME = 'delegate'

/** A child whose role is applied when its `agent/created` fires. */
export interface PendingChild {
  readonly role: RoleDefinition
  readonly snapshot: RoleSettings
  /** Parent session the reservation belongs to. Dispose of that parent drops it. */
  readonly parentSessionId: string
}

/**
 * Drop one reservation, whichever id it is filed under.
 * @param pending - the table shared with `agent/created`.
 * @param child - the reservation object.
 */
export function discardReservation(pending: Map<string, PendingChild>, child: PendingChild): void {
  for (const [id, entry] of pending) {
    if (entry === child) pending.delete(id)
  }
}

/** Drop every reservation. Used when the plugin unloads. */
export function discardPending(pending: Map<string, PendingChild>): void {
  for (const child of new Set(pending.values())) discardReservation(pending, child)
}

/** Drop reservations owned by a disposed parent or child. */
export function discardReservationsFor(pending: Map<string, PendingChild>, agent: AgentPort): void {
  const ids = new Set([agent.id, agent.session.id])
  const drop: PendingChild[] = []
  for (const [id, child] of pending) {
    if (ids.has(id) || ids.has(child.parentSessionId)) drop.push(child)
  }
  for (const child of new Set(drop)) discardReservation(pending, child)
}

export interface ToolDeps {
  readonly ctx: HostContext
  readonly spawnProvider: string
  readonly forkProvider: string
  /** Children started by this tool and not yet created, by reserved child id. */
  readonly pending: Map<string, PendingChild>
  /**
   * Apply a reservation the provider already published under `id`.
   * Throws when that child must not keep running.
   */
  claimStarted?(id: string): void
  /**
   * Track one activation so a child announced under an unexpected id can be
   * held shut until the call returns, then bound or stopped.
   */
  activation?: {
    begin(flight: { parent: AgentPort; reservedId: string; role: RoleDefinition; snapshot: RoleSettings }): void
    finish(reservedId: string, returnedId: string | undefined): Promise<void>
  }
}

function findAgent(ctx: HostContext, id: string): AgentPort | undefined {
  return ctx.agents.list().find(candidate => candidate.id === id || candidate.session.id === id)
}

/** Stop a child that must not keep running. Failures are logged; the caller still throws its own error. */
export async function stopRunningChild(
  ctx: HostContext,
  started: { childId: string; dispose?: () => Promise<void> | void },
  agent: AgentPort | undefined,
): Promise<void> {
  const warn = (action: string, error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`rolesubagents: could not ${action} child ${started.childId}: ${detail}`)
  }
  if (agent?.cancel !== undefined) {
    try {
      agent.cancel({ kind: 'user' })
    } catch (error) {
      warn('cancel', error)
    }
  }
  if (agent?.dispose !== undefined) {
    try {
      await agent.dispose()
    } catch (error) {
      warn('dispose', error)
    }
  }
  if (started.dispose !== undefined) {
    try {
      await started.dispose()
    } catch (error) {
      warn('stop', error)
    }
  }
}

/**
 * The parent-facing tool description for one role list.
 * @param roles - selectable roles in configured order.
 * @returns the description text.
 */
export function toolDescription(roles: readonly RoleDefinition[]): string {
  const general = roles.some(role => role.builtin === 'general')
  return [
    'Delegate a task to a subagent: a separate agent that works in its own context and returns its result, not its intermediate steps. Pick the role that fits the task:',
    ...roles.map(roleListLine),
    general ? 'Omit `role` to use `general`.' : 'A `role` is required.',
    'The subagent starts in the background and this tool immediately returns its id; the runtime notifies you when it finishes. The child reports results with `send_message`; use `send_message` to steer it while running or continue its conversation after it finishes. A read-only agent may call `send_message` or `interrupt_agent` only when every destination id names a read-only agent whose sandbox is still read-only, so it cannot ask a writable agent to make a change. Start independent delegations together in one assistant message and keep working while they run. When only waiting remains, end your turn instead of sleeping or polling; the next result starts a new turn.',
  ].join('\n')
}

interface ToolArgs {
  description: string
  prompt: string
  role?: string
  cwd?: string
}

/**
 * Pick the role for one call.
 * @param roles - selectable roles.
 * @param requested - the model's `role` argument.
 * @returns the role.
 */
export function resolveRole(roles: readonly RoleDefinition[], requested: string | undefined): RoleDefinition {
  if (requested === undefined || requested === '') {
    const general = roles.find(role => role.builtin === 'general')
    if (general === undefined)
      throw new Error(`role is required; choose one of: ${roles.map(role => role.id).join(', ')}`)
    return general
  }
  const role = roles.find(entry => entry.id === requested)
  if (role === undefined)
    throw new Error(`unknown role "${requested}"; choose one of: ${roles.map(entry => entry.id).join(', ')}`)
  return role
}

/**
 * Build the tool for a Session's role list.
 * @param snapshot - the Session's recorded role list.
 * @param deps - services and the pending-child table.
 * @returns the definition, or undefined when no role is selectable.
 */
export function buildTool(snapshot: RoleSettings, deps: ToolDeps): ToolDefinition | undefined {
  const roles = selectableRoles(snapshot)
  if (roles.length === 0) return undefined
  const hasGeneral = roles.some(role => role.builtin === 'general')
  return defineTool({
    name: TOOL_NAME,
    description: toolDescription(roles),
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description:
          'The task for the subagent. Fresh roles do not see this conversation, so include everything they need. Fork roles already see its completed turns but not the current one, so state what is new, including anything from the current turn they need.',
      },
      role: {
        type: 'string',
        ...(hasGeneral ? {} : { required: true as const }),
        enum: roles.map(role => role.id),
        description: hasGeneral ? 'Role for this subagent. Omit to use `general`.' : 'Role for this subagent.',
      },
      cwd: {
        type: 'string',
        description:
          'Initial child working directory. Relative paths use your current directory; omitted inherits it. Later directory changes in either agent are independent.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'activation' },
          subagentId: { type: 'string', required: true },
        },
      },
      render: (args, value) => {
        const requested = typeof args === 'object' && args !== null && 'role' in args ? args.role : undefined
        let text = `started subagent ${value.subagentId}`
        if (typeof requested === 'string' || requested === undefined) {
          try {
            const chosen = resolveRole(roles, requested === '' ? undefined : requested)
            if (forkInheritsHistory(chosen)) text = `${text}\n${FORK_RESULT_WARNING}`
          } catch {
            // A rejected role never renders a successful start.
          }
        }
        return [{ type: 'text', text }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs, exec) {
      const args = rawArgs as unknown as ToolArgs
      const parent = (exec as { agent?: AgentPort }).agent
      if (parent === undefined) throw new Error('subagent tool requires a calling agent')
      const role = resolveRole(roles, args.role)
      if (readRole(parent.session)?.readOnly === true || pinFailed(parent.session)) {
        const denial = readOnlyCallDenial(TOOL_NAME, rawArgs, roles, {
          mode: lastSandboxMode(parent.session),
          pinFailed: pinFailed(parent.session),
          // `delegate` is judged from the role list; its own registration is this plugin's.
          origin: 'inherited',
        })
        if (denial !== undefined) throw new Error(denial)
      }
      const inheritsHistory = forkInheritsHistory(role)
      if (inheritsHistory) {
        deps.ctx.logger.warn(
          `rolesubagents: role "${role.id}" forks the parent conversation; inherited tool results can carry prompt injection`,
        )
      }
      const providerName = inheritsHistory ? deps.forkProvider : deps.spawnProvider
      const provider = deps.ctx.subagents.getProvider(providerName)
      if (provider === undefined) throw new Error(`subagent provider "${providerName}" is not available`)
      const copiesParent = () =>
        new Error(
          `role "${role.id}" must not inherit the parent conversation, but provider "${providerName}" copies it`,
        )
      if (!inheritsHistory && provider.inheritsParentContext !== false) throw copiesParent()
      const agentOptions: ChildAgentOptions | undefined =
        role.model === undefined
          ? undefined
          : {
              provider: role.model.provider,
              model: role.model.model,
              ...(role.model.reasoningEffort === undefined ? {} : { reasoningEffort: role.model.reasoningEffort }),
            }
      if (agentOptions !== undefined) {
        if (provider.capabilities.agentOptions !== true) {
          throw new Error(`role "${role.id}": provider "${providerName}" cannot set the child model`)
        }
        await deps.ctx.get('llm')?.resolveCallConfig(agentOptions, exec.signal)
      }
      if (
        role.agentPreset !== undefined &&
        (provider.capabilities.agentPreset !== true || provider.inheritsParentContext === true)
      ) {
        throw new Error(`role "${role.id}": provider "${providerName}" cannot mount agent preset "${role.agentPreset}"`)
      }
      const maxDepth = deps.ctx.subagents.resolveMaxDepth(undefined)
      const childId = randomUUID()
      if (!inheritsHistory && provider.prepareContinuable !== undefined) {
        let prepared: { seed?: readonly unknown[] } | undefined
        try {
          prepared = await provider.prepareContinuable({ parent, sessionId: childId, signal: exec.signal })
        } catch {
          throw copiesParent()
        }
        const seed = prepared?.seed
        if ((seed !== undefined && !Array.isArray(seed)) || eventsHaveParentTurns(seed ?? [])) throw copiesParent()
      }
      let activeId: string = childId
      let returnedId: string | undefined
      let settled = false
      deps.pending.set(childId, { role, snapshot, parentSessionId: parent.session.id })
      const settle = async (): Promise<void> => {
        if (settled) return
        settled = true
        await deps.activation?.finish(childId, returnedId)
      }
      deps.activation?.begin({ parent, reservedId: childId, role, snapshot })
      try {
        const started = await deps.ctx.subagents.startActivation({
          provider: providerName,
          childId,
          label: args.description,
          request: {
            prompt: [{ type: 'text', text: args.prompt }],
            parent,
            ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
            ...(role.agentPreset === undefined ? {} : { agentPreset: role.agentPreset }),
            ...(agentOptions === undefined ? {} : { agentOptions }),
            ...(maxDepth === undefined ? {} : { maxDepth }),
          },
          signal: exec.signal,
          delivery: 'parent',
        })
        // A provider may publish the child under a different id than the one reserved.
        // Rebind before claiming, so `agent/created` that already fired still gets the role.
        if (started.childId !== childId && deps.pending.has(childId)) {
          const kept = deps.pending.get(childId)
          deps.pending.delete(childId)
          if (kept !== undefined) {
            deps.pending.set(started.childId, kept)
            activeId = started.childId
          }
        }
        returnedId = started.childId
        // Settle while the activation is still open, so a child announced
        // during that wait is still attached to it. Claiming afterwards
        // covers an id that was not visible yet.
        const pendingBeforeFinish = deps.pending.has(activeId)
        try {
          await settle()
        } catch (error) {
          await stopRunningChild(deps.ctx, started, findAgent(deps.ctx, activeId) ?? findAgent(deps.ctx, childId))
          throw error
        }
        let bound = pendingBeforeFinish && !deps.pending.has(activeId)
        try {
          if (deps.pending.has(activeId)) {
            deps.claimStarted?.(activeId)
            bound = !deps.pending.has(activeId)
          }
        } catch (error) {
          await stopRunningChild(deps.ctx, started, findAgent(deps.ctx, activeId) ?? findAgent(deps.ctx, childId))
          throw error
        }
        const agent = findAgent(deps.ctx, returnedId) ?? findAgent(deps.ctx, childId)
        const sessions = deps.ctx.get('sessions')
        const session = agent?.session ?? sessions?.get(returnedId) ?? sessions?.get(childId)
        // Bound means this call's reservation was applied to the id activation returned.
        // A different id that is still unbound, with no agent and no session, fails closed.
        if (!bound && returnedId !== childId && agent === undefined && session === undefined) {
          await stopRunningChild(deps.ctx, started, undefined)
          throw new Error(`role "${role.id}" could not be matched to the started child "${returnedId}"`)
        }
        if (!inheritsHistory) {
          let leaked = false
          if (session !== undefined) {
            try {
              leaked = sessionHasParentTurns(session)
            } catch {
              leaked = true
            }
          }
          if (leaked) {
            await stopRunningChild(deps.ctx, started, agent)
            throw new Error(
              `role "${role.id}" must not inherit the parent conversation, but the child session already contains it`,
            )
          }
        }
        return { kind: 'activation' as const, subagentId: returnedId }
      } catch (error) {
        await settle()
        const child = deps.pending.get(childId) ?? deps.pending.get(activeId)
        if (child !== undefined) discardReservation(deps.pending, child)
        throw error
      }
    },
  }) as ToolDefinition
}
