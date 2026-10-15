/**
 * Regressions for the review's fail-closed bypasses. Each case is a path that
 * used to leave a read-only agent able to write, or a fork able to copy history.
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/host/index.ts'
import { pinFailed } from '../src/host/readonly.ts'
import { readRole } from '../src/host/records.ts'
import { RESERVATION_TTL_MS } from '../src/host/tool.ts'
import {
  builtinRole,
  execContext,
  fakeAgent,
  fakeProvider,
  fakeSession,
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

  it('does not pin an official child that this plugin did not start', async () => {
    const { world, parent } = boot()
    const child = world.newAgent('official', {
      origin: 'subagent',
      parentSession: parent.session.id,
      delegationDepth: 1,
    })
    world.emitCreated(child, 'fork')
    expect(readRole(child.session)).toBeUndefined()
    expect(modes(child.session)).toEqual([])
    expect(child.guards).toHaveLength(0)
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

  it('refuses a shadowed delegate and still allows the one this plugin registered', async () => {
    const { delegate } = boot()
    const child = await delegate('reviewer')
    expect(call(child, 'delegate', { role: 'explorer' })).toBeUndefined()
    child.shadows.set('delegate', { name: 'delegate' } as ToolDefinition)
    expect(call(child, 'delegate', { role: 'explorer' })).toMatch(/registration is not the inherited host tool/)
  })
})

describe('task-only stops a child that already has parent history', () => {
  it('cancels and disposes a visible child instead of only throwing', async () => {
    const taskFork = builtinRole('fork', { forkScope: 'task', readOnly: true })
    const { world, parent } = boot([GENERAL, taskFork])
    const activationDispose = vi.fn(async () => {})
    world.subagents.startActivation.mockImplementation(async spec => {
      const child = world.newAgent(spec.childId ?? 'seeded', {
        origin: 'subagent',
        parentSession: spec.request.parent.session.id,
        delegationDepth: 1,
      })
      child.session.log.push({ type: 'turn/end', seq: 0, time: 0, data: { reason: 'parent' } })
      world.children.push(child)
      world.agents = [...world.agents, child]
      return { childId: child.id, dispose: activationDispose }
    })
    await expect(registeredTool(parent).execute({ ...ARGS, role: 'fork' }, execContext(parent))).rejects.toThrow(
      /already contains it/,
    )
    const child = world.children[0]
    expect(child).toBeDefined()
    expect(child?.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(child?.dispose).toHaveBeenCalledTimes(1)
    expect(activationDispose).toHaveBeenCalledTimes(1)
  })

  it('still reports the history leak when stopping the child fails', async () => {
    const taskFork = builtinRole('fork', { forkScope: 'task', readOnly: true })
    const { world, parent } = boot([GENERAL, taskFork])
    const activationDispose = vi.fn(async () => {
      throw new Error('stop failed')
    })
    world.subagents.startActivation.mockImplementation(async spec => {
      const child = world.newAgent(spec.childId ?? 'seeded', {
        origin: 'subagent',
        parentSession: spec.request.parent.session.id,
        delegationDepth: 1,
      })
      child.dispose.mockRejectedValue(new Error('dispose failed'))
      child.session.log.push({ type: 'turn/end', seq: 0, time: 0, data: { reason: 'parent' } })
      world.children.push(child)
      world.agents = [...world.agents, child]
      return { childId: child.id, dispose: activationDispose }
    })
    await expect(registeredTool(parent).execute({ ...ARGS, role: 'fork' }, execContext(parent))).rejects.toThrow(
      /already contains it/,
    )
    expect(world.logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not dispose child'))
    expect(world.logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not stop child'))
  })

  it('disposes an activation whose session already contains a parent turn', async () => {
    const taskFork = builtinRole('fork', { forkScope: 'task', readOnly: true })
    const { world, parent } = boot([GENERAL, taskFork])
    const activationDispose = vi.fn(async () => {})
    world.subagents.startActivation.mockImplementation(async spec => {
      const id = spec.childId ?? 'seeded'
      const session = fakeSession(id)
      session.log.push({ type: 'turn/end', seq: 0, time: 0, data: { reason: 'parent' } })
      world.sessions.set(id, session)
      return { childId: id, dispose: activationDispose }
    })
    await expect(registeredTool(parent).execute({ ...ARGS, role: 'fork' }, execContext(parent))).rejects.toThrow(
      /already contains it/,
    )
    expect(activationDispose).toHaveBeenCalledTimes(1)
  })
})

describe('a returned child id still receives the reservation', () => {
  it('applies the role when agent/created names the id the provider returns', async () => {
    const { world, parent } = boot()
    world.subagents.startActivation.mockImplementation(async spec => {
      const child = world.newAgent('other-id', {
        origin: 'subagent',
        parentSession: spec.request.parent.session.id,
        delegationDepth: 1,
      })
      world.children.push(child)
      world.emitCreated(child, 'startup')
      return { childId: child.id }
    })
    await registeredTool(parent).execute({ ...ARGS, role: 'reviewer' }, execContext(parent))
    const child = world.children[0]
    expect(child).toBeDefined()
    if (child === undefined) return
    expect(readRole(child.session)).toMatchObject({ id: 'reviewer', readOnly: true })
    expect(modes(child.session).at(-1)).toEqual({ mode: 'read-only' })
    expect(call(child, 'write')).toMatch(/refused/)
  })

  it('fails closed when created consumed the reserved id but activation returns another', async () => {
    const { world, parent } = boot()
    const dispose = vi.fn(async () => {})
    world.subagents.startActivation.mockImplementation(async spec => {
      const reserved = world.newAgent(spec.childId ?? 'reserved', {
        origin: 'subagent',
        parentSession: spec.request.parent.session.id,
        delegationDepth: 1,
      })
      world.children.push(reserved)
      world.emitCreated(reserved, 'startup')
      return { childId: 'other-unseen', dispose }
    })
    await expect(registeredTool(parent).execute({ ...ARGS, role: 'reviewer' }, execContext(parent))).rejects.toThrow(
      /could not be matched/,
    )
    expect(dispose).toHaveBeenCalledTimes(1)
    const reserved = world.children[0]
    expect(reserved).toBeDefined()
    if (reserved === undefined) return
    expect(readRole(reserved.session)?.id).toBe('reviewer')
  })

  it('stops a history-inheriting fork when the returned id cannot be matched', async () => {
    const { world, parent } = boot()
    const dispose = vi.fn(async () => {})
    world.subagents.startActivation.mockResolvedValue({ childId: 'missing-fork', dispose })
    await expect(registeredTool(parent).execute({ ...ARGS, role: 'fork' }, execContext(parent))).rejects.toThrow(
      /could not be matched/,
    )
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('stops the child when the returned id matches neither an agent nor a session', async () => {
    const { world, parent } = boot()
    const dispose = vi.fn(async () => {})
    world.subagents.startActivation.mockResolvedValue({ childId: 'missing-child', dispose })
    await expect(registeredTool(parent).execute({ ...ARGS, role: 'reviewer' }, execContext(parent))).rejects.toThrow(
      /could not be matched/,
    )
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

describe('reservations are cleaned up', () => {
  it('drops a reservation when agent/created never arrives', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
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
      await vi.advanceTimersByTimeAsync(RESERVATION_TTL_MS)
      if (late === undefined) return
      world.emitCreated(late, 'startup')
      expect(readRole(late.session)).toBeUndefined()
      expect(late.guards).toHaveLength(0)
      expect(modes(late.session)).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the reservation until the cleanup delay when created is only late', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
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
      await vi.advanceTimersByTimeAsync(RESERVATION_TTL_MS - 1)
      if (late === undefined) return
      world.emitCreated(late, 'fork')
      expect(readRole(late.session)).toMatchObject({ id: 'reviewer', readOnly: true })
      expect(modes(late.session).at(-1)).toEqual({ mode: 'read-only' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('destination checks do not trust agent_id alone', () => {
  it('requires every destination id to be a live read-only agent', async () => {
    const { world, parent, delegate } = boot()
    const reviewer = await delegate('reviewer')
    const explorer = await delegate('explorer')
    world.agents = [parent, reviewer, explorer]

    expect(call(explorer, 'send_message', { agentId: reviewer.session.id })).toBeUndefined()
    expect(call(explorer, 'send_message', { agent_id: reviewer.id, session_id: parent.session.id })).toMatch(
      /destination is not a read-only/,
    )
    expect(call(explorer, 'interrupt_agent', { target: { agent_id: parent.id } })).toMatch(
      /destination is not a read-only/,
    )
    expect(
      call(explorer, 'send_message', { agent_id: reviewer.session.id, message: parent.session.id }),
    ).toBeUndefined()
  })

  it('refuses a destination whose log cannot be read', async () => {
    const { world, delegate } = boot()
    const reviewer = await delegate('reviewer')
    const explorer = await delegate('explorer')
    world.agents = [reviewer, explorer]
    reviewer.session.snapshotEvents = () => {
      throw new Error('log closed')
    }
    expect(() => call(explorer, 'send_message', { agent_id: reviewer.session.id })).not.toThrow()
    expect(call(explorer, 'send_message', { agent_id: reviewer.session.id })).toMatch(/destination is not a read-only/)
  })

  it('refuses a destination whose live mode is not read-only or whose pin failed', async () => {
    const { world, delegate } = boot()
    const reviewer = await delegate('reviewer')
    const explorer = await delegate('explorer')
    world.agents = [reviewer, explorer]
    world.emitSandbox(reviewer.session, 'workspace-write')
    expect(call(explorer, 'send_message', { agent_id: reviewer.session.id })).toMatch(/destination is not a read-only/)
    await Promise.resolve()
    expect(call(explorer, 'send_message', { agent_id: reviewer.session.id })).toBeUndefined()

    reviewer.session.append = () => {
      reviewer.session.log.push({
        type: 'sandbox/mode',
        seq: reviewer.session.log.length,
        time: 0,
        data: { mode: 'danger-full-access' },
      })
      return undefined
    }
    world.emitSandbox(reviewer.session, 'workspace-write')
    await Promise.resolve()
    reviewer.session.log.push({
      type: 'sandbox/mode',
      seq: reviewer.session.log.length,
      time: 0,
      data: { mode: 'read-only' },
    })
    expect(call(explorer, 'send_message', { agent_id: reviewer.id })).toMatch(/destination is not a read-only/)
  })
})

describe('a failed pin does not stick after the session is gone', () => {
  async function failPin(world: ReturnType<typeof boot>['world'], child: FakeAgent): Promise<void> {
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
    expect(pinFailed(child.session)).toBe(true)
  }

  it('releases the id when the agent is disposed', async () => {
    const { world, delegate } = boot()
    const child = await delegate('reviewer')
    await failPin(world, child)
    const id = child.session.id
    world.emitDisposed(child)
    expect(pinFailed(child.session)).toBe(false)
    expect(pinFailed(fakeSession(id))).toBe(false)
  })

  it('releases the id when the plugin unloads', async () => {
    const { world, delegate } = boot()
    const child = await delegate('reviewer')
    await failPin(world, child)
    const id = child.session.id
    world.teardown()
    expect(pinFailed(fakeSession(id))).toBe(false)
  })
})

describe('task-only inspects the provider seed', () => {
  it('refuses a seed that contains a parent turn even when the provider says it copies nothing', async () => {
    const taskFork = builtinRole('fork', { forkScope: 'task', readOnly: true })
    const { world, delegate } = boot([GENERAL, taskFork])
    world.providers.set(
      'spawn',
      fakeProvider('spawn', {
        inheritsParentContext: false,
        prepareContinuable: async () => ({ seed: [{ type: 'turn/end' }] }),
      }),
    )
    await expect(delegate('fork')).rejects.toThrow(/provider "spawn" copies it/)
    expect(world.subagents.startActivation).not.toHaveBeenCalled()
  })

  it('refuses when prepareContinuable throws, before the child is started', async () => {
    const taskFork = builtinRole('fork', { forkScope: 'task' })
    const { world, delegate } = boot([GENERAL, taskFork])
    world.providers.set(
      'spawn',
      fakeProvider('spawn', {
        inheritsParentContext: false,
        prepareContinuable: async () => {
          throw new Error('seed failed')
        },
      }),
    )
    await expect(delegate('fork')).rejects.toThrow(/provider "spawn" copies it/)
    expect(world.subagents.startActivation).not.toHaveBeenCalled()
  })

  it('starts when the seed is empty', async () => {
    const taskFork = builtinRole('fork', { forkScope: 'task', readOnly: true })
    const { world, delegate } = boot([GENERAL, taskFork])
    world.providers.set(
      'spawn',
      fakeProvider('spawn', {
        inheritsParentContext: false,
        prepareContinuable: async () => ({}),
      }),
    )
    const child = await delegate('fork')
    expect(readRole(child.session)?.id).toBe('fork')
    expect(world.subagents.startActivation).toHaveBeenCalledTimes(1)
  })
})
