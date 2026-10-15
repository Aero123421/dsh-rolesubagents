import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import type { SessionPort } from '../src/host/ports.ts'
import {
  holdReadOnly,
  lastSandboxMode,
  markPinFailed,
  pinFailed,
  type ReadOnlyGate,
  readOnlyCallDenial,
  releasePinFailure,
  SANDBOX_ASSUMED_TOOLS,
  sandboxModeOf,
  toolOrigin,
} from '../src/host/readonly.ts'
import {
  FORK_INHERIT_WARNING,
  forkInheritsHistory,
  normalizeSettings,
  type RoleDefinition,
  selectableRoles,
} from '../src/shared/roles.ts'

const EXPLORER: RoleDefinition = {
  id: 'explorer',
  enabled: true,
  description: '',
  instructions: '',
  context: 'spawn',
  readOnly: true,
}
const WORKER: RoleDefinition = {
  id: 'worker',
  enabled: true,
  description: '',
  instructions: '',
  context: 'spawn',
  readOnly: false,
}
const FORK: RoleDefinition = {
  id: 'fork',
  enabled: true,
  builtin: 'fork',
  description: '',
  instructions: '',
  context: 'fork',
  forkScope: 'full',
  readOnly: true,
}
const TASK: RoleDefinition = { ...FORK, id: 'task', builtin: undefined, forkScope: 'task' }
const ROLES = [EXPLORER, WORKER, FORK, TASK]

function logSession(id = 's'): SessionPort & { log: { type: string; data: unknown }[] } {
  const log: { type: string; data: unknown }[] = []
  return {
    id,
    header: {},
    log,
    snapshotEvents: () => log,
    append(_type, data) {
      log.push({ type: 'sandbox/mode', data })
      return data
    },
  }
}

describe('sandbox mode hold', () => {
  it('appends read-only once when the log has no mode or a wider mode', () => {
    const session = logSession()
    holdReadOnly(session)
    expect(lastSandboxMode(session)).toBe('read-only')
    holdReadOnly(session)
    expect(session.log).toEqual([{ type: 'sandbox/mode', data: { mode: 'read-only' } }])
    session.append('sandbox/mode', { mode: 'workspace-write' })
    holdReadOnly(session)
    expect(session.log.map(event => sandboxModeOf(event.data))).toEqual(['read-only', 'workspace-write', 'read-only'])
  })

  it('stops when a nested writer keeps replacing the pin', () => {
    const log: { type: string; data: unknown }[] = []
    const session: SessionPort = {
      id: 'hostile',
      header: {},
      snapshotEvents: () => log,
      append() {
        log.push({ type: 'sandbox/mode', data: { mode: 'danger-full-access' } })
        return undefined
      },
    }
    expect(() => holdReadOnly(session)).toThrow(/stayed "danger-full-access"/)
    expect(log).toHaveLength(8)
  })
})

describe('read-only tool gate', () => {
  const open: ReadOnlyGate = { mode: 'read-only', pinFailed: false, origin: 'inherited' }
  const deny = (name: string, args: unknown = {}, gate: Partial<ReadOnlyGate> = {}) =>
    readOnlyCallDenial(name, args, ROLES, { ...open, ...gate })

  it('allows only the known host tools', () => {
    expect(deny('bash')).toBeUndefined()
    expect(deny('read')).toBeUndefined()
    expect(deny('web_search')).toBeUndefined()
    expect(deny('web_fetch')).toBeUndefined()
    expect(deny('cordis_inspect_query')).toBeUndefined()
    expect(deny('run_code', {}, { origin: 'reserved' })).toBeUndefined()
    expect(deny('write')).toMatch(/its name marks it as a write/)
    expect(deny('edit')).toMatch(/its name marks it as a write/)
    expect(deny('plugin_manager')).toMatch(/not an allowlisted read-only tool/)
    expect(deny('todo_write')).toMatch(/its name marks it as a write/)
    expect(deny('stagehand_act')).toMatch(/its name marks it as a write/)
  })

  it('does not treat query or fetch as permission, and refuses a write token beside a read-like word', () => {
    for (const name of ['postgres_query', 'mcp__db__query', 'http_fetch', 'search_query', 'get_user']) {
      expect(deny(name)).toMatch(/not an allowlisted read-only tool/)
    }
    expect(deny('check_and_merge')).toMatch(/its name marks it as a write/)
    expect(deny('search_and_destroy')).toMatch(/its name marks it as a write/)
    expect(deny('mcp__fs__read_file')).toMatch(/not an allowlisted read-only tool/)
    expect(deny('mcp__fs__write_file')).toMatch(/its name marks it as a write/)
    expect(deny('mcp__fs__get_and_delete')).toMatch(/its name marks it as a write/)
    expect(deny('mcp__notes__frobnicate')).toMatch(/not an allowlisted read-only tool/)
    expect(deny('other_plugin_lookup')).toMatch(/not an allowlisted read-only tool/)
    expect(deny('other_plugin_update_issue')).toMatch(/its name marks it as a write/)
  })

  it('refuses every tool when the pin failed or the live mode is not read-only', () => {
    expect(deny('bash', {}, { pinFailed: true })).toMatch(/could not be restored/)
    expect(deny('run_code', {}, { pinFailed: true, origin: 'reserved' })).toMatch(/could not be restored/)
    expect(deny('delegate', { role: 'explorer' }, { pinFailed: true })).toMatch(/could not be restored/)
    expect(deny('bash', {}, { mode: 'workspace-write' })).toMatch(/sandbox mode is not read-only/)
    expect(deny('run_code', {}, { mode: 'danger-full-access', origin: 'reserved' })).toMatch(
      /sandbox mode is not read-only/,
    )
    expect(deny('read', {}, { mode: undefined })).toMatch(/sandbox mode is not read-only/)
  })

  it('refuses a tool whose registration is not the inherited host tool', () => {
    expect(deny('bash', {}, { origin: 'shadow' })).toMatch(/registration is not the inherited host tool/)
    expect(deny('read', {}, { origin: 'unknown' })).toMatch(/registration is not the inherited host tool/)
    expect(deny('run_code', {}, { origin: 'shadow' })).toMatch(/registration is not the inherited host tool/)
    expect(toolOrigin('run_code', undefined, undefined)).toBe('reserved')
    expect(toolOrigin('bash', undefined, undefined)).toBe('unknown')
    const inherited = { name: 'bash' } as ToolDefinition
    expect(toolOrigin('bash', inherited, inherited)).toBe('inherited')
    expect(toolOrigin('bash', { name: 'bash' } as ToolDefinition, inherited)).toBe('shadow')
  })

  it('allows send_message and interrupt_agent only toward a read-only destination', () => {
    expect(deny('send_message', { agent_id: 'parent' })).toMatch(/destination is not a read-only agent/)
    expect(deny('interrupt_agent', {})).toMatch(/destination is not a read-only agent/)
    expect(deny('send_message', { agent_id: 'child' }, { destinationReadOnly: true })).toBeUndefined()
    expect(deny('interrupt_agent', { agent_id: 'child' }, { destinationReadOnly: true })).toBeUndefined()
    expect(deny('send_message', { agent_id: 'child' }, { destinationReadOnly: true, origin: 'shadow' })).toMatch(
      /registration is not the inherited host tool/,
    )
  })

  it('refuses delegation to a writable role or a full fork, and allows a read-only task fork', () => {
    expect(deny('delegate', { role: 'worker' })).toMatch(/not read-only/)
    expect(deny('delegate', { role: 'fork' })).toMatch(/copy the parent conversation/)
    expect(deny('delegate', { role: 'explorer' })).toBeUndefined()
    expect(deny('delegate', {})).toMatch(/no read-only role is the default/)
    expect(deny('delegate', { role: 'task' })).toBeUndefined()
    expect(deny('delegate', { role: 'missing' })).toMatch(/unknown role/)
  })

  it('refuses delegate when its registration is not this plugin', () => {
    expect(deny('delegate', { role: 'explorer' }, { origin: 'shadow' })).toMatch(
      /registration is not the inherited host tool/,
    )
    expect(deny('delegate', { role: 'explorer' }, { origin: 'unknown' })).toMatch(
      /registration is not the inherited host tool/,
    )
    expect(deny('delegate', { role: 'explorer' })).toBeUndefined()
  })

  it('allows sandbox-assumed tools only while the live mode is read-only', () => {
    for (const name of SANDBOX_ASSUMED_TOOLS) {
      const origin = name === 'run_code' ? 'reserved' : 'inherited'
      expect(deny(name, {}, { origin, mode: 'read-only' })).toBeUndefined()
      expect(deny(name, {}, { origin, mode: 'workspace-write' })).toMatch(/sandbox mode is not read-only/)
      expect(deny(name, {}, { origin, mode: undefined })).toMatch(/sandbox mode is not read-only/)
    }
  })

  it('denies the same session id until the failure is released', () => {
    const first = logSession('pin-stuck')
    const later = logSession('pin-stuck')
    expect(pinFailed(later)).toBe(false)
    markPinFailed(first)
    expect(pinFailed(later)).toBe(true)
    expect(deny('bash', {}, { pinFailed: pinFailed(later) })).toMatch(/could not be restored/)
    releasePinFailure(first)
    expect(pinFailed(later)).toBe(false)
    expect(pinFailed(logSession('pin-stuck'))).toBe(false)
  })
})

describe('fork scope normalization', () => {
  it('keeps full and task, switches an invalid scope off, and drops a scope on a spawn role', () => {
    const full = normalizeSettings({
      enabled: true,
      roles: [
        { id: 'general', builtin: 'general', context: 'spawn', readOnly: false, description: '', instructions: '' },
        {
          id: 'fork',
          builtin: 'fork',
          context: 'fork',
          forkScope: 'task',
          readOnly: false,
          description: '',
          instructions: '',
        },
        { id: 'wide', context: 'fork', forkScope: 'sideways', readOnly: false, description: '', instructions: '' },
        { id: 'fresh', context: 'spawn', forkScope: 'task', readOnly: false, description: '', instructions: '' },
      ],
    })
    expect(full.settings.roles.find(role => role.id === 'fork')).toMatchObject({ forkScope: 'task', enabled: true })
    const wide = full.settings.roles.find(role => role.id === 'wide')
    expect(wide).toMatchObject({ forkScope: 'task', enabled: false, context: 'fork' })
    expect(wide === undefined ? undefined : forkInheritsHistory(wide)).toBe(false)
    expect(selectableRoles(full.settings).map(role => role.id)).not.toContain('wide')
    expect(full.settings.roles.find(role => role.id === 'fresh')?.forkScope).toBeUndefined()
    expect(full.problems.map(problem => problem.code)).toEqual(['invalid-fork-scope', 'spawn-fork-scope-ignored'])
    expect(full.problems.map(problem => problem.message).join('\n')).toMatch(
      /switched off and does not inherit history/,
    )
    expect(FORK_INHERIT_WARNING).toMatch(/untrusted data/)
  })
})
