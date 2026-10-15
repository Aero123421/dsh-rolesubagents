import { describe, expect, it } from 'vitest'
import { holdReadOnly, lastSandboxMode, readOnlyCallDenial, sandboxModeOf } from '../src/host/readonly.ts'
import type { SessionPort } from '../src/host/ports.ts'
import { FORK_INHERIT_WARNING, normalizeSettings, type RoleDefinition } from '../src/shared/roles.ts'

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
  const deny = (name: string, args: unknown = {}) => readOnlyCallDenial(name, args, ROLES)

  it('allows sandbox reads and refuses file mutations and external writes', () => {
    expect(deny('bash')).toBeUndefined()
    expect(deny('read')).toBeUndefined()
    expect(deny('web_search')).toBeUndefined()
    expect(deny('send_message')).toBeUndefined()
    expect(deny('write')).toMatch(/refused/)
    expect(deny('edit')).toMatch(/refused/)
    expect(deny('plugin_manager')).toMatch(/refused/)
    expect(deny('todo_write')).toMatch(/refused/)
    expect(deny('stagehand_act')).toMatch(/refused/)
  })

  it('stops MCP writes, allows MCP reads, and fails closed when the name is neither', () => {
    expect(deny('mcp__fs__read_file')).toBeUndefined()
    expect(deny('mcp__fs__write_file')).toMatch(/its name marks it as a write/)
    expect(deny('mcp__fs__get_and_delete')).toMatch(/write/)
    expect(deny('mcp__notes__frobnicate')).toMatch(/annotations are not visible/)
    expect(deny('other_plugin_lookup')).toBeUndefined()
    expect(deny('other_plugin_update_issue')).toMatch(/write/)
  })

  it('refuses delegation to a writable role or a full fork, and allows a read-only task fork', () => {
    expect(deny('delegate', { role: 'worker' })).toMatch(/not read-only/)
    expect(deny('delegate', { role: 'fork' })).toMatch(/copy the parent conversation/)
    expect(deny('delegate', { role: 'explorer' })).toBeUndefined()
    expect(deny('delegate', {})).toMatch(/no read-only role is the default/)
    expect(deny('delegate', { role: 'task' })).toBeUndefined()
    expect(deny('delegate', { role: 'missing' })).toMatch(/unknown role/)
  })
})

describe('fork scope normalization', () => {
  it('keeps full and task, repairs an invalid scope, and drops a scope on a spawn role', () => {
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
    expect(full.settings.roles.find(role => role.id === 'fork')).toMatchObject({ forkScope: 'task' })
    expect(full.settings.roles.find(role => role.id === 'wide')).toMatchObject({ forkScope: 'full' })
    expect(full.settings.roles.find(role => role.id === 'fresh')?.forkScope).toBeUndefined()
    expect(full.problems.map(problem => problem.code)).toEqual(['invalid-fork-scope', 'spawn-fork-scope-ignored'])
    expect(FORK_INHERIT_WARNING).toMatch(/untrusted data/)
  })
})
