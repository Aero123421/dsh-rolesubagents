/**
 * One delegation to an external CLI, through DSH's official subagent service.
 *
 * DSH routes a start through a registered provider, and provider options
 * cannot be passed per call, so each delegation registers its own ephemeral
 * provider (`rolesubagents:<cli>:<roleId>:<uuid>`) whose `start` runs the
 * engine with this delegation's frozen settings, starts the activation, and
 * removes the registration again. Removal does not affect the started run
 * (verified against DSH's SubagentRuntime). DSH then owns the run: it notifies
 * the parent with the result, `interrupt_agent` aborts it, and it disposes it.
 *
 * External starts must not carry `childId`, `maxDepth`, `agentOptions` or
 * `agentPreset` (DSH rejects them for providers without those capabilities).
 */

import { randomUUID } from 'node:crypto'
import { type RoleDefinition, type RoleRunner, roleContextText, runnerTimeoutMs } from '../../shared/roles.ts'
import type { CliSettings } from '../../shared/runner.ts'
import type { AgentPort, ExternalProviderPort, HostContext, SubagentRunPort } from '../ports.ts'
import { type EngineDeps, startExternalRun } from './engine.ts'
import { assertCwdAllowed, assertUsableCwd, type Ceiling, type EffectivePermission } from './policy.ts'
import type { CliAdapter } from './types.ts'

/** Start capabilities of every external provider: none (DSH's `NO_START_CAPABILITIES`). */
export const NO_START_CAPABILITIES = Object.freeze({
  agentOptions: false,
  agentPreset: false,
  outputSchema: false,
  depthLimit: false,
} as const)

/** Everything one external delegation needs, decided before it starts. */
export interface ExternalDelegation {
  readonly ctx: HostContext
  readonly role: RoleDefinition & { runner: RoleRunner }
  readonly adapter: CliAdapter
  readonly settings: CliSettings
  readonly permission: EffectivePermission
  readonly ceiling: Ceiling
  readonly parent: AgentPort
  /** The delegate `description` argument (DSH's label). */
  readonly label: string
  /** The delegate `prompt` argument (the task). */
  readonly prompt: string
  /** The delegate `cwd` argument; DSH resolves it against the parent's directory. */
  readonly cwd?: string
  /** The tool call's signal (owns the start only). */
  readonly signal: AbortSignal
  readonly engine: EngineDeps
}

/**
 * Provider name for one delegation.
 * @param role - the runner role.
 * @returns `rolesubagents:<cli>:<roleId>:<uuid>`.
 */
export function ephemeralProviderName(role: RoleDefinition & { runner: RoleRunner }): string {
  return `rolesubagents:${role.runner.cli}:${role.id}:${randomUUID()}`
}

/**
 * Start one external delegation as a DSH activation delivered to the parent.
 * @param delegation - the frozen delegation.
 * @returns DSH's activation (its child id is the run id).
 * @throws when the subagent service cannot register providers, or when the start fails (safe messages).
 */
export async function startExternalDelegation(delegation: ExternalDelegation): Promise<{ childId: string }> {
  const { ctx, role, adapter, settings, permission, ceiling } = delegation
  const register = ctx.subagents.registerProvider?.bind(ctx.subagents)
  if (register === undefined) throw new Error("external roles need DSH's subagent provider registry")
  const name = ephemeralProviderName(role)
  const provider: ExternalProviderPort = {
    name,
    capabilities: NO_START_CAPABILITIES,
    inheritsParentContext: false,
    async start(request): Promise<SubagentRunPort> {
      const cwd = assertUsableCwd(request.cwd)
      assertCwdAllowed(cwd, permission.access, ceiling.workspaceRoot)
      return startExternalRun(
        {
          adapter,
          input: {
            runner: role.runner,
            preset: permission.preset,
            access: permission.access,
            instructions: roleContextText(role),
            task: delegation.prompt,
            cwd,
          },
          settings,
          timeoutMs: runnerTimeoutMs(role.runner),
          signal: request.signal,
          ...(ceiling.workspaceRoot === undefined ? {} : { workspaceRoot: ceiling.workspaceRoot }),
        },
        delegation.engine,
      )
    },
  }
  const unregister = register(provider)
  try {
    return await ctx.subagents.startActivation({
      provider: name,
      label: delegation.label,
      request: {
        prompt: [{ type: 'text', text: delegation.prompt }],
        parent: delegation.parent,
        ...(delegation.cwd === undefined ? {} : { cwd: delegation.cwd }),
      },
      signal: delegation.signal,
      delivery: 'parent',
    })
  } finally {
    // The disposer may be asynchronous (Cordis effects); a failure must not mask the start's outcome.
    try {
      void Promise.resolve(unregister()).catch(error => logUnregisterFailure(ctx, name, error))
    } catch (error) {
      logUnregisterFailure(ctx, name, error)
    }
  }
}

function logUnregisterFailure(ctx: HostContext, name: string, error: unknown): void {
  ctx.logger.warn(
    `rolesubagents: could not remove provider ${name}: ${error instanceof Error ? error.message : String(error)}`,
  )
}
