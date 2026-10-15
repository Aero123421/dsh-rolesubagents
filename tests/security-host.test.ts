import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/host/index.ts'
import { ROLE_RECORD, ROLES_RECORD } from '../src/host/records.ts'
import { FORK_INHERIT_WARNING, FORK_RESULT_WARNING, FORK_TASK_CONTEXT } from '../src/shared/roles.ts'
import {
  builtinRole,
  execContext,
  fakeAgent,
  fakeWorld,
  recordsOf,
  registeredTool,
  role,
  type FakeSession,
} from './host-fakes.ts'

vi.mock('@deepseek-ai/dsh-session', () => import('./host-fakes.ts').then(module => module.sessionModule()))
vi.mock('@deepseek-ai/dsh-tools', () => import('./host-fakes.ts').then(module => module.toolsModule()))

const GENERAL = builtinRole('general')
const FORK = builtinRole('fork')
const WORKER = role('worker', {
  description: 'Implements one change.',
  instructions: 'Change only what you were given.',
})
const EXPLORER = role('explorer', { description: 'Reads.', instructions: 'Look.', readOnly: true })
const REVIEWER = role('reviewer', { description: 'Judges.', instructions: 'Judge.', readOnly: true })
const ROLES = [GENERAL, FORK, WORKER, EXPLORER, REVIEWER]
const ARGS = { description: 'check things', prompt: 'please check the things' }
const SANDBOX = 'sandbox/mode'

function modes(session: FakeSession): unknown[] {
  return recordsOf(session, SANDBOX)
}

function boot(roles = ROLES) {
  const world = fakeWorld()
  apply(world.ctx, { roles })
  const parent = world.newAgent('parent')
  world.emitCreated(parent)
  const delegate = async (roleId?: string) => {
    const tool = registeredTool(parent)
    await tool.execute({ ...ARGS, ...(roleId === undefined ? {} : { role: roleId }) }, execContext(parent))
    const child = world.children.at(-1)
    if (child === undefined) throw new Error('no child')
    return child
  }
  return { world, parent, delegate }
}

describe('read-only sandbox stays pinned', () => {
  it('re-appends read-only after a later sandbox/mode change', async () => {
    const { world, delegate } = boot()
    const child = await delegate('reviewer')
    expect(modes(child.session)).toEqual([{ mode: 'read-only' }])
    world.emitSandbox(child.session, 'workspace-write')
    world.emitSandbox(child.session, 'danger-full-access')
    await Promise.resolve()
    expect(modes(child.session)).toEqual([
      { mode: 'read-only' },
      { mode: 'workspace-write' },
      { mode: 'danger-full-access' },
      { mode: 'read-only' },
    ])
  })

  it('does not pin a role that is not read-only, including the parent', async () => {
    const { world, parent, delegate } = boot()
    const child = await delegate('worker')
    world.emitSandbox(child.session, 'workspace-write')
    world.emitSandbox(parent.session, 'danger-full-access')
    await Promise.resolve()
    expect(modes(child.session)).toEqual([{ mode: 'workspace-write' }])
    expect(modes(parent.session)).toEqual([{ mode: 'danger-full-access' }])
  })

  it('re-pins on resume when the stored mode is no longer read-only', async () => {
    const { delegate } = boot()
    const child = await delegate('reviewer')
    child.session.append('sandbox/mode', { mode: 'workspace-write' })
    const fresh = fakeWorld()
    apply(fresh.ctx, { roles: ROLES })
    const resumed = fakeAgent('resumed', child.session)
    fresh.emitCreated(resumed, 'resume')
    expect(modes(child.session).at(-1)).toEqual({ mode: 'read-only' })
    expect(resumed.guards).toHaveLength(1)
  })

  it('logs and leaves the session when a re-pin is rejected', async () => {
    const { world, delegate } = boot()
    const child = await delegate('reviewer')
    const original = child.session.append.bind(child.session)
    child.session.append = (type, data) => {
      if (data.mode === 'read-only') throw new Error('log closed')
      return original(type, data)
    }
    world.emitSandbox(child.session, 'workspace-write')
    await Promise.resolve()
    expect(world.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`could not re-pin read-only on session ${child.session.id}`),
    )
  })

  it('stops watching after the plugin is unloaded', async () => {
    const { world, delegate } = boot()
    const child = await delegate('reviewer')
    world.emitSandbox(child.session, 'workspace-write')
    world.teardown()
    await Promise.resolve()
    expect(modes(child.session).at(-1)).toEqual({ mode: 'workspace-write' })
  })
})

describe('read-only tool guard', () => {
  it('refuses MCP and plugin tools that are not allowlisted, and still allows known reads', async () => {
    const { delegate } = boot()
    const child = await delegate('reviewer')
    const guard = child.guards[0]
    if (guard === undefined) throw new Error('read-only child has no guard')
    expect(guard({ name: 'mcp__fs__write_file', arguments: {} })).toMatch(/refused/)
    expect(guard({ name: 'mcp__fs__read_file', arguments: {} })).toMatch(/refused/)
    expect(guard({ name: 'plugin_manager', arguments: {} })).toMatch(/refused/)
    expect(guard({ name: 'read', arguments: {} })).toBeUndefined()
    expect(guard({ name: 'web_fetch', arguments: {} })).toBeUndefined()
    expect(guard({ name: 'bash', arguments: {} })).toBeUndefined()
    expect(guard({ name: 'delegate', arguments: { role: 'worker' } })).toMatch(/not read-only/)
    expect(guard({ name: 'delegate', arguments: { role: 'explorer' } })).toBeUndefined()
    await expect(registeredTool(child).execute({ ...ARGS, role: 'worker' }, execContext(child))).rejects.toThrow(
      /not read-only/,
    )
    expect(child.guardDisposers[0]).not.toHaveBeenCalled()
  })

  it('does not install a guard on a writable child', async () => {
    const { parent, delegate } = boot()
    const child = await delegate('worker')
    expect(child.guards).toEqual([])
    expect(parent.guards).toEqual([])
  })

  it('removes the guard when the child is disposed', async () => {
    const { world, delegate } = boot()
    const child = await delegate('reviewer')
    world.emitDisposed(child)
    expect(child.guardDisposers[0]).toHaveBeenCalledTimes(1)
    expect(child.guards).toEqual([])
  })
})

describe('fork inheritance warning and task scope', () => {
  it('warns in the tool result and the child context when a fork copies history', async () => {
    const { world, parent, delegate } = boot()
    const child = await delegate('fork')
    expect(world.logger.warn).toHaveBeenCalledWith(expect.stringContaining('prompt injection'))
    expect(world.runtimeContext(child)).toBe(FORK_INHERIT_WARNING)
    const tool: ToolDefinition = registeredTool(parent)
    expect(tool.output.render({ ...ARGS, role: 'fork' }, { kind: 'activation', subagentId: 'abc' })).toEqual([
      { type: 'text', text: `started subagent abc\n${FORK_RESULT_WARNING}` },
    ])
    expect(recordsOf(child.session, ROLE_RECORD)).toEqual([expect.objectContaining({ version: 1 })])
    expect(recordsOf(child.session, ROLES_RECORD).length).toBe(1)
  })

  it('starts a task-scoped fork without the parent log and without the injection warning', async () => {
    const taskFork = builtinRole('fork', { forkScope: 'task' })
    const { world, parent, delegate } = boot([GENERAL, taskFork, WORKER, REVIEWER])
    const child = await delegate('fork')
    expect(world.subagents.startActivation.mock.calls.at(-1)?.[0].provider).toBe('spawn')
    expect(world.logger.warn).not.toHaveBeenCalled()
    expect(world.runtimeContext(child)).toBe(FORK_TASK_CONTEXT)
    const tool: ToolDefinition = registeredTool(parent)
    expect(tool.output.render({ ...ARGS, role: 'fork' }, { kind: 'activation', subagentId: 'abc' })).toEqual([
      { type: 'text', text: 'started subagent abc' },
    ])
  })
})
