import { describe, expect, it } from 'vitest'
import { managementAuthorization } from '../src/host/management/auth.ts'
import { ManagementFailure } from '../src/host/management/settings.ts'
import type { AgentPort, SandboxPolicyPort, SessionPort } from '../src/host/ports.ts'
import { fakeAgent, fakeSession } from './host-fakes.ts'

function setup(header: SessionPort['header'] = {}) {
  const agent = fakeAgent('owner', fakeSession('session-owner', header))
  const state = {
    disposed: false,
    current: true,
    recorded: false,
    readOnly: false,
    mode: 'workspace-write',
    policy: true,
  }
  const policy: SandboxPolicyPort = { resolve: () => ({ mode: state.mode, workspaceRoot: '/fixture/workspace' }) }
  const authorize = managementAuthorization({
    isDisposed: () => state.disposed,
    isCurrentAgent: candidate => state.current && candidate === agent,
    isRecordedChild: () => state.recorded,
    isReadOnly: () => state.readOnly,
    sandboxPolicy: () => (state.policy ? policy : undefined),
  })
  return { agent, state, authorize }
}
function denied(run: () => unknown, code: string) {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(ManagementFailure)
    expect((error as ManagementFailure).code).toBe(code)
    return
  }
  throw new Error('authorization unexpectedly allowed')
}

describe('role management caller authorization', () => {
  it('allows ordinary workspace parent management without elevating its ceiling', () => {
    const t = setup()
    expect(t.authorize(t.agent, true)).toBe('workspace-write')
    expect(t.authorize(t.agent, false)).toBe('workspace-write')
    expect(t.state.mode).toBe('workspace-write')
  })
  it('allows a user fork with parentSession lineage, not a delegated child', () => {
    const t = setup({ parentSession: 'earlier-root', origin: 'web', delegationDepth: 0 })
    expect(t.authorize(t.agent, true)).toBe('workspace-write')
  })
  it.each([
    { origin: 'subagent' },
    { origin: 'subagent', delegationDepth: 0 },
    { origin: 'web', delegationDepth: 1 },
    { delegationDepth: -1 },
    { delegationDepth: Number.NaN },
    { delegationDepth: Number.POSITIVE_INFINITY },
    { delegationDepth: 0.5 },
    { delegationDepth: Number.MAX_SAFE_INTEGER + 1 },
  ])('denies persisted delegated or malformed depth metadata %j', header => {
    const t = setup(header)
    denied(() => t.authorize(t.agent, false), 'child-not-authorized')
    denied(() => t.authorize(t.agent, true), 'child-not-authorized')
  })
  it('denies a recorded child even if its header looks like a root', () => {
    const t = setup({ origin: 'web', delegationDepth: 0 })
    t.state.recorded = true
    denied(() => t.authorize(t.agent, false), 'child-not-authorized')
  })
  it('requires the actual current live agent identity, not only a matching id', () => {
    const t = setup()
    denied(() => t.authorize(undefined, false), 'caller-unavailable')
    denied(() => t.authorize(fakeAgent(t.agent.id, t.agent.session), false), 'caller-unavailable')
    t.state.current = false
    denied(() => t.authorize(t.agent, true), 'caller-unavailable')
    t.state.current = true
    t.state.disposed = true
    denied(() => t.authorize(t.agent, false), 'caller-unavailable')
  })
  it.each(['role', 'event', 'policy'] as const)('allows metadata but rejects writes for a read-only %s', source => {
    const t = setup()
    if (source === 'role') t.state.readOnly = true
    if (source === 'event') t.agent.session.append('sandbox/mode', { mode: 'read-only' })
    if (source === 'policy') t.state.mode = 'read-only'
    expect(t.authorize(t.agent, false)).toBe('read-only')
    denied(() => t.authorize(t.agent, true), 'read-only-caller')
  })
  it('uses current policy on every execution, with missing policy never granting full access', () => {
    const t = setup()
    t.state.mode = 'danger-full-access'
    expect(t.authorize(t.agent, true)).toBe('full-access')
    t.state.policy = false
    denied(() => t.authorize(t.agent, true), 'caller-policy-unavailable')
    expect(t.authorize(t.agent, false)).toBe('workspace-write')
    t.state.policy = true
    t.state.mode = 'read-only'
    denied(() => t.authorize(t.agent, true), 'read-only-caller')
  })
  it('does not accept an argument-supplied or structurally forged caller as authority', () => {
    const t = setup()
    const forged = { id: t.agent.id, session: t.agent.session, ctx: t.agent.ctx } as AgentPort
    denied(() => t.authorize(forged, true), 'caller-unavailable')
  })
})
