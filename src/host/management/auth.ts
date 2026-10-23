/** Administration is an explicit Host capability, not a workspace-file write loophole. */
import type { AccessLevel } from '../../shared/cli/types.ts'
import { accessOfSandboxMode } from '../external/policy.ts'
import type { AgentPort, SandboxPolicyPort } from '../ports.ts'
import { lastSandboxMode } from '../readonly.ts'
import { ManagementFailure } from './settings.ts'

export function managementAuthorization(deps: {
  readonly isDisposed: () => boolean
  readonly isCurrentAgent: (agent: AgentPort) => boolean
  readonly isRecordedChild: (agent: AgentPort) => boolean
  readonly isReadOnly: (agent: AgentPort) => boolean
  readonly sandboxPolicy: () => SandboxPolicyPort | undefined
}) {
  return (agent: AgentPort | undefined, mutation: boolean): AccessLevel => {
    if (!agent || deps.isDisposed() || !deps.isCurrentAgent(agent))
      throw new ManagementFailure('caller-unavailable', 'A live calling parent session is required.')
    const header = agent.session.header
    const depth = header.delegationDepth
    // parentSession alone is generic fork lineage, not proof of a delegated child.
    if (
      header.origin === 'subagent' ||
      (depth !== undefined && (!Number.isSafeInteger(depth) || depth !== 0)) ||
      deps.isRecordedChild(agent)
    ) {
      throw new ManagementFailure('child-not-authorized', 'Child agents cannot administer role configuration.')
    }
    const readonly = deps.isReadOnly(agent) || lastSandboxMode(agent.session) === 'read-only'
    let mode: string | undefined
    try {
      mode = deps.sandboxPolicy()?.resolve({ session: agent.session })?.mode
    } catch {
      /* Unknown administration authority is not writable. */
    }
    const known = mode === 'read-only' || mode === 'workspace-write' || mode === 'danger-full-access'
    const ceiling = readonly ? 'read-only' : accessOfSandboxMode(mode)
    if (mutation && !known && !readonly)
      throw new ManagementFailure(
        'caller-policy-unavailable',
        'The caller file policy must be resolved before role administration can write settings.',
      )
    if (mutation && ceiling === 'read-only')
      throw new ManagementFailure(
        'read-only-caller',
        'A read-only caller cannot change role configuration or its active catalog.',
      )
    return ceiling
  }
}
