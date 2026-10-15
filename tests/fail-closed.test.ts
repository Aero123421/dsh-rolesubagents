/**
 * Regressions for the review's fail-closed bypasses. Each case is a path that
 * used to leave a read-only agent able to write, or a fork able to copy history.
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/host/index.ts'
import { pinFailed } from '../src/host/readonly.ts'
import { readRole } from '../src/host/records.ts'
import {
  builtinRole,
  execContext,
  fakeAgent,
  fakeProvider,
  fakeWorld,
  inheritedTools,
  recordsOf,
  registeredTool,
  role,
  shareInheritedTool,
  type FakeAgent,
  type FakeSession,
} from './host-fakes.ts'

vi.mock('@deepseek-ai/dsh-session', () => import('./host-fakes.ts').then(module => module.sessionModule()))
vi.mock('@deepseek-ai/dsh-tools', () => import('./host-fakes.ts').then(module => module.toolsModule()))

const GENERAL = builtinRole('general')
const FORK = builtinRole('fork')
const WORKER = role('worker', { description: 'Implements.', instructions: 'Change it.' })
const EXPLORER = role('explorer', { description: 'Reads.', instructions: 'Look.', readOnly: true })
const REVIEWER = role('reviewer', { description: 'Judges.', instructions: 'Judge.', readOnly: true })
const ROLES = [GENERAL, FORK, WORKER, EXPLORER, REVIEWER]
const ARGS = { description: 'check things', prompt: 'please check the things' }

function modes(session: FakeSession): unknown[] {
  return recordsOf(session, 'sandbox/mode')
}

function boot(roles = ROLES) {
  const world = fakeWorld()
  apply(world.ctx, { roles })
  const parent = world.newAgent('parent')
  world.agents = [parent]
  world.emitCreated(parent)
  const delegate = async (roleId?: string) => {
    const tool = registeredTool(parent)
    await tool.execute({ ...ARGS, ...(roleId === undefined ? {} : { role: roleId }) }, execContext(parent))
    const child = world.children.at(-1)
    if (child === undefined) throw new Error('no child')
    world.agents = [...world.agents, child]
    return child
  }
  return { world, parent, delegate }
}

function guardOf(agent: FakeAgent) {
  const guard = agent.guards[0]
  if (guard === undefined) throw new Error(`agent ${agent.id} has no guard`)
  return guard
}

function call(agent: FakeAgent, name: string, args: unknown = {}) {
  return guardOf(agent)({ name, arguments: args })
}

/** Publish names for one assertion, then drop the ones this file added. */
async function withInherited(names: readonly string[], run: () => Promise<void> | void): Promise<void> {
  const added = names.filter(name => !inheritedTools.has(name))
  for (const name of names) shareInheritedTool(name)
  try {
    await run()
  } finally {
    for (const name of added) inheritedTools.delete(name)
  }
}

describe('allowlist, not a read-like token', () => {
  it('refuses query, fetch, merge, and destroy names even when the host registered them', async () => {
    const { delegate } = boot()
    const child = await delegate('reviewer')
    const names = ['postgres_query', 'mcp__db__query', 'http_fetch', 'check_and_merge', 'search_and_destroy']
    await withInherited(names, () => {
      expect(call(child, 'postgres_query')).toMatch(/not an allowlisted read-only tool/)
      expect(call(child, 'mcp__db__query')).toMatch(/not an allowlisted read-only tool/)
      expect(call(child, 'http_fetch')).toMatch(/not an allowlisted read-only tool/)
      expect(call(child, 'check_and_merge')).toMatch(/its name marks it as a write/)
      expect(call(child, 'search_and_destroy')).toMatch(/its name marks it as a write/)
      expect(call(child, 'web_fetch')).toBeUndefined()
      expect(call(child, 'cordis_inspect_query')).toBeUndefined()
    })
  })
})

describe('a failed re-pin closes every tool', () => {
  it('refuses bash and run_code after the re-pin gives up, including once the log looks read-only again', async () => {
    const { world, delegate } = boot()
    const child = await delegate('reviewer')
    child.session.append = () => {
      child.session.log.push({
        type: 'sandbox/mode',
        seq: child.session.log.length,
        time: 0,
        data: { mode: 'danger-full-access' },
      })
      return undefined
    }
    world.emitSandbox(child.session, 'workspace-write')
    await Promise.resolve()
    expect(world.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`could not re-pin read-only on session ${child.session.id}`),
    )
    expect(pinFailed(child.session)).toBe(true)
    expect(call(child, 'bash')).toMatch(/could not be restored/)
    expect(call(child, 'run_code')).toMatch(/could not be restored/)
    expect(call(child, 'delegate', { role: 'explorer' })).toMatch(/could not be restored/)
    child.session.log.push({
      type: 'sandbox/mode',
      seq: child.session.log.length,
      time: 0,
      data: { mode: 'read-only' },
    })
    expect(call(child, 'bash')).toMatch(/could not be restored/)
    expect(call(child, 'read')).toMatch(/could not be restored/)
  })

  it('aborts resume when the read-only pin is rejected', async () => {
    const { delegate } = boot()
    const child = await delegate('reviewer')
    child.session.log.push({
      type: 'sandbox/mode',
      seq: child.session.log.length,
      time: 0,
      data: { mode: 'workspace-write' },
    })
    const fresh = fakeWorld()
    const resumed = fakeAgent('resumed', child.session)
    fresh.agents = [resumed]
    resumed.session.append = () => {
      throw new Error('log closed')
    }
    expect(() => apply(fresh.ctx, { roles: ROLES })).toThrow(/log closed/)
    expect(pinFailed(child.session)).toBe(true)
  })

  it('aborts a resumed agent/created the same way', async () => {
    const { delegate } = boot()
    const child = await delegate('reviewer')
    child.session.log.push({
      type: 'sandbox/mode',
      seq: child.session.log.length,
      time: 0,
      data: { mode: 'danger-full-access' },
    })
    const fresh = fakeWorld()
    apply(fresh.ctx, { roles: ROLES })
    const resumed = fakeAgent('resumed-event', child.session)
    resumed.session.append = () => {
      throw new Error('log closed')
    }
    expect(() => fresh.emitCreated(resumed, 'resume')).toThrow(/log closed/)
  })
})

describe('child role does not depend on the creation source', () => {
  it('applies the reserved role when created reports source fork', async () => {
    const { world, delegate } = boot()
    world.subagents.startActivation.mockImplementation(async spec => {
      const child = world.newAgent(spec.childId ?? 'forked', {
        origin: 'subagent',
        parentSession: spec.request.parent.session.id,
        delegationDepth: 1,
      })
      world.children.push(child)
      world.emitCreated(child, 'fork')
      return { childId: child.id }
    })
    const child = await delegate('reviewer')
    expect(readRole(child.session)).toMatchObject({ id: 'reviewer', readOnly: true })
    expect(modes(child.session).at(-1)).toEqual({ mode: 'read-only' })
    expect(call(child, 'write')).toMatch(/refused/)
  })

  it('still applies the role when created arrives after activation returns', async () => {
    const { world, parent } = boot()
    let late: FakeAgent | undefined
    world.subagents.startActivation.mockImplementation(async spec => {
      late = world.newAgent(spec.childId ?? 'late', {
        origin: 'subagent',
        parentSession: spec.request.parent.session.id,
        delegationDepth: 1,
      })
      world.children.push(late)
      return { childId: late.id }
    })
    await registeredTool(parent).execute({ ...ARGS, role: 'reviewer' }, execContext(parent))
    expect(late).toBeDefined()
    if (late === undefined) return
    expect(readRole(late.session)).toBeUndefined()
    world.emitCreated(late, 'fork')
    expect(readRole(late.session)).toMatchObject({ id: 'reviewer', readOnly: true })
    expect(modes(late.session).at(-1)).toEqual({ mode: 'read-only' })
    expect(call(late, 'bash')).toBeUndefined()
  })

  it('pins an unclassified delegated child read-only and does not invent a role', async () => {
    const { world, parent } = boot()
    const child = world.newAgent('official', {
      origin: 'subagent',
      parentSession: parent.session.id,
      delegationDepth: 1,
    })
    world.emitCreated(child, 'fork')
    expect(readRole(child.session)).toBeUndefined()
    expect(modes(child.session)).toEqual([{ mode: 'read-only' }])
    expect(call(child, 'write')).toMatch(/refused/)
    expect(call(child, 'bash')).toBeUndefined()
    expect(world.runtimeContext(child)).not.toContain('Your role:')
  })
})

describe('coordination tools cannot reach a writable agent', () => {
  it('refuses send_message and interrupt_agent unless the destination is read-only', async () => {
    const { world, parent, delegate } = boot()
    const reviewer = await delegate('reviewer')
    const worker = await delegate('worker')
    const explorer = await delegate('explorer')
    world.agents = [parent, reviewer, worker, explorer]

    expect(call(reviewer, 'send_message', { agent_id: parent.session.id })).toMatch(/destination is not a read-only/)
    expect(call(reviewer, 'send_message', { agent_id: parent.id })).toMatch(/destination is not a read-only/)
    expect(call(reviewer, 'interrupt_agent', { agent_id: worker.session.id })).toMatch(/destination is not a read-only/)
    expect(call(reviewer, 'send_message', {})).toMatch(/destination is not a read-only/)
    expect(call(reviewer, 'interrupt_agent', { agent_id: 'missing-agent' })).toMatch(/destination is not a read-only/)
    expect(call(reviewer, 'send_message', { agent_id: reviewer.session.id })).toBeUndefined()
    expect(call(reviewer, 'interrupt_agent', { agent_id: explorer.id })).toBeUndefined()
  })
})

describe('an invalid fork scope cannot inherit history', () => {
  it('drops the role from the tool so it cannot be started as a full fork', async () => {
    const world = fakeWorld()
    apply(world.ctx, {
      roles: [
        GENERAL,
        FORK,
        { id: 'wide', context: 'fork', forkScope: 'sideways', readOnly: false, description: 'Wide.', instructions: '' },
      ],
    })
    const parent = world.newAgent('parent')
    world.emitCreated(parent)
    const tool = registeredTool(parent)
    const params = tool.parameters as { properties?: { role?: { enum?: string[] } } }
    expect(params.properties?.role?.enum).not.toContain('wide')
    await expect(tool.execute({ ...ARGS, role: 'wide' }, execContext(parent))).rejects.toThrow(
      /invalid arguments|unknown role/,
    )
    expect(world.subagents.startActivation).not.toHaveBeenCalled()
    expect(world.logger.warn).toHaveBeenCalledWith(expect.stringContaining('switched off and does not inherit history'))
  })
})

describe('task-only does not receive the parent history', () => {
  it('refuses a provider that copies the parent, before the child is started', async () => {
    const taskFork = builtinRole('fork', { forkScope: 'task', readOnly: true })
    const { world, delegate } = boot([GENERAL, taskFork])
    world.providers.set('spawn', fakeProvider('spawn', { inheritsParentContext: true }))
    await expect(delegate('fork')).rejects.toThrow(/provider "spawn" copies it/)
    expect(world.subagents.startActivation).not.toHaveBeenCalled()
  })

  it('refuses a provider that does not promise to skip the parent history', async () => {
    const taskFork = builtinRole('fork', { forkScope: 'task' })
    const { world, delegate } = boot([GENERAL, taskFork])
    const silent = fakeProvider('spawn')
    delete (silent as { inheritsParentContext?: boolean }).inheritsParentContext
    world.providers.set('spawn', silent)
    await expect(delegate('fork')).rejects.toThrow(/provider "spawn" copies it/)
    expect(world.subagents.startActivation).not.toHaveBeenCalled()
  })

  it('aborts a child whose log already contains a parent turn and then refuses its tools', async () => {
    const taskFork = builtinRole('fork', { forkScope: 'task', readOnly: true })
    const { world, delegate } = boot([GENERAL, taskFork])
    world.subagents.startActivation.mockImplementation(async spec => {
      const child = world.newAgent(spec.childId ?? 'seeded', {
        origin: 'subagent',
        parentSession: spec.request.parent.session.id,
        delegationDepth: 1,
      })
      child.session.log.push({ type: 'turn/end', seq: 0, time: 0, data: { reason: 'parent' } })
      world.children.push(child)
      world.emitCreated(child, 'fork')
      return { childId: child.id }
    })
    await expect(delegate('fork')).rejects.toThrow(/already contains it/)
    const child = world.children[0]
    expect(child).toBeDefined()
    if (child === undefined) return
    expect(call(child, 'bash')).toMatch(/could not be restored/)
    expect(call(child, 'read')).toMatch(/could not be restored/)
    expect(readRole(child.session)).toBeUndefined()
  })
})

describe('the guard closes the gap before the re-pin lands', () => {
  it('refuses bash and run_code while a wider mode is the latest event', async () => {
    const { world, delegate } = boot()
    const child = await delegate('reviewer')
    const seen: Array<string | undefined> = []
    const original = child.session.append.bind(child.session)
    child.session.append = (type, data) => {
      const event = original(type, data)
      if (data.mode === 'workspace-write') seen.push(call(child, 'bash'), call(child, 'run_code'))
      return event
    }
    world.emitSandbox(child.session, 'workspace-write')
    expect(seen[0]).toMatch(/sandbox mode is not read-only/)
    expect(seen[1]).toMatch(/sandbox mode is not read-only/)
    expect(call(child, 'bash')).toMatch(/sandbox mode is not read-only/)
    await Promise.resolve()
    expect(modes(child.session).at(-1)).toEqual({ mode: 'read-only' })
    expect(call(child, 'bash')).toBeUndefined()
    expect(call(child, 'run_code')).toBeUndefined()
  })
})

describe('a same-named registration does not inherit the allowlist', () => {
  it('refuses a shadowed bash or run_code and still allows the inherited read', async () => {
    const { delegate } = boot()
    const child = await delegate('reviewer')
    const runCode = inheritedTools.get('run_code')
    inheritedTools.delete('run_code')
    try {
      expect(call(child, 'run_code')).toBeUndefined()
      child.shadows.set('bash', { name: 'bash' } as ToolDefinition)
      child.shadows.set('run_code', { name: 'run_code' } as ToolDefinition)
      expect(call(child, 'bash')).toMatch(/registration is not the inherited host tool/)
      expect(call(child, 'run_code')).toMatch(/registration is not the inherited host tool/)
      expect(call(child, 'read')).toBeUndefined()
    } finally {
      if (runCode !== undefined) inheritedTools.set('run_code', runCode)
    }
  })
})
