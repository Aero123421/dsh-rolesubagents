/**
 * The role-aware `delegate` tool. One definition is built per Agent from that
 * Session's recorded role list and registered in the Agent's own scope, so the
 * schema never changes inside a Session and a child carries the same
 * definition as its parent (identical tool prefix, shared prompt cache).
 */

import { randomUUID } from 'node:crypto'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { type RoleDefinition, type RoleSettings, roleListLine, selectableRoles } from '../shared/roles.ts'
import type { AgentPort, ChildAgentOptions, HostContext } from './ports.ts'

export const TOOL_NAME = 'delegate'

/** A child whose role is applied when its `agent/created` fires. */
export interface PendingChild {
  readonly role: RoleDefinition
  readonly snapshot: RoleSettings
}

export interface ToolDeps {
  readonly ctx: HostContext
  readonly spawnProvider: string
  readonly forkProvider: string
  /** Children started by this tool and not yet created, by reserved child id. */
  readonly pending: Map<string, PendingChild>
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
    'The subagent starts in the background and this tool immediately returns its id; the runtime notifies you when it finishes. The child reports results with `send_message`; use `send_message` to steer it while running or continue its conversation after it finishes. Start independent delegations together in one assistant message and keep working while they run. When only waiting remains, end your turn instead of sleeping or polling; the next result starts a new turn.',
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
      render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs, exec) {
      const args = rawArgs as unknown as ToolArgs
      const parent = (exec as { agent?: AgentPort }).agent
      if (parent === undefined) throw new Error('subagent tool requires a calling agent')
      const role = resolveRole(roles, args.role)
      const providerName = role.context === 'fork' ? deps.forkProvider : deps.spawnProvider
      const provider = deps.ctx.subagents.getProvider(providerName)
      if (provider === undefined) throw new Error(`subagent provider "${providerName}" is not available`)
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
      deps.pending.set(childId, { role, snapshot })
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
        return { kind: 'activation' as const, subagentId: started.childId }
      } finally {
        deps.pending.delete(childId)
      }
    },
  }) as ToolDefinition
}
