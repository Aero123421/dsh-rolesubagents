/**
 * Regressions for the review's fail-closed bypasses. Each case is a path that
 * used to leave a read-only agent able to write, or a fork able to copy history.
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/host/index.ts'
import { pinFailed } from '../src/host/readonly.ts'
import { readRole, writeRole } from '../src/host/records.ts'
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

describe('an activation holds unmatched children of that parent', () => {
  function childOf(world: ReturnType<typeof boot>['world'], id: string, parentSession: string | undefined): FakeAgent {
    return world.newAgent(id, {
      origin: 'subagent',
      ...(parentSession === undefined ? {} : { parentSession }),
      delegationDepth: 1,
    })
  }

  it('denies every tool until activation returns that other id, then applies the read-only role', async () => {
    const { world, parent } = boot()
    let during: Array<string | undefined> = []
    world.subagents.startActivation.mockImplementation(async spec => {
      const child = childOf(world, 'during-other', spec.request.parent.session.id)
      world.children.push(child)
      world.emitCreated(child, 'startup')
      expect(modes(child.session)).toEqual([])
      during = [call(child, 'bash'), call(child, 'write')]
      return { childId: child.id }
    })
    await registeredTool(parent).execute({ ...ARGS, role: 'reviewer' }, execContext(parent))
    expect(during[0]).toMatch(/not bound/)
    expect(during[0]).toMatch(/refused/)
    expect(during[1]).toMatch(/refused/)
    const child = world.children[0]
    expect(child).toBeDefined()
    if (child === undefined) return
    expect(readRole(child.session)).toMatchObject({ id: 'reviewer', readOnly: true })
    expect(modes(child.session).at(-1)).toEqual({ mode: 'read-only' })
    expect(call(child, 'write')).toMatch(/refused/)
    expect(call(child, 'bash')).toBeUndefined()
  })

  it('does not pin a writable role while the unmatched child is held', async () => {
    const { world, parent } = boot()
    let during: string | undefined
    world.subagents.startActivation.mockImplementation(async spec => {
      const child = childOf(world, 'during-worker', spec.request.parent.session.id)
      world.children.push(child)
      world.emitCreated(child, 'startup')
      during = call(child, 'bash')
      expect(modes(child.session)).toEqual([])
      return { childId: child.id }
    })
    await registeredTool(parent).execute({ ...ARGS, role: 'worker' }, execContext(parent))
    expect(during).toMatch(/refused/)
    const child = world.children[0]
    expect(child).toBeDefined()
    if (child === undefined) return
    expect(readRole(child.session)).toMatchObject({ id: 'worker', readOnly: false })
    expect(modes(child.session)).toEqual([])
    expect(child.guards).toHaveLength(0)
  })

  it('releases a third id instead of stopping it, and still roles the reserved child', async () => {
    const { world, parent } = boot()
    const official = childOf(world, 'official-other', 'session-someone-else')
    let during: string | undefined
    world.subagents.startActivation.mockImplementation(async spec => {
      const third = childOf(world, 'third-id', spec.request.parent.session.id)
      world.children.push(third)
      world.emitCreated(third, 'startup')
      during = call(third, 'write')
      expect(modes(third.session)).toEqual([])
      const reserved = childOf(world, spec.childId ?? 'reserved', spec.request.parent.session.id)
      world.children.push(reserved)
      world.emitCreated(reserved, 'startup')
      world.emitCreated(official, 'startup')
      return { childId: reserved.id }
    })
    await registeredTool(parent).execute({ ...ARGS, role: 'reviewer' }, execContext(parent))
    expect(during).toMatch(/refused/)
    const third = world.children[0]
    const reserved = world.children[1]
    expect(third?.cancel).not.toHaveBeenCalled()
    expect(third?.dispose).not.toHaveBeenCalled()
    expect(third?.guards).toHaveLength(0)
    expect(third?.guards[0]?.({ name: 'write', arguments: {} })).toBeUndefined()
    expect(modes(third?.session ?? fakeSession('missing'))).toEqual([])
    expect(reserved).toBeDefined()
    if (reserved === undefined || third === undefined) return
    expect(readRole(reserved.session)?.id).toBe('reviewer')
    expect(readRole(third.session)).toBeUndefined()
    expect(official.cancel).not.toHaveBeenCalled()
    expect(official.dispose).not.toHaveBeenCalled()
    expect(official.guards).toHaveLength(0)
    expect(official.guards[0]?.({ name: 'write', arguments: {} })).toBeUndefined()
  })

  it('lets a same-parent official child and another plugin child write after the call, and does not stop them', async () => {
    const { world, parent } = boot()
    let duringOfficial: string | undefined
    let duringPlugin: string | undefined
    world.subagents.startActivation.mockImplementation(async spec => {
      const official = childOf(world, 'official-same', spec.request.parent.session.id)
      const pluginChild = world.newAgent('other-plugin', {
        parentSession: spec.request.parent.session.id,
        delegationDepth: 1,
      })
      const teams = childOf(world, 'teams-same-window', undefined)
      world.children.push(official, pluginChild, teams)
      world.emitCreated(official, 'startup')
      world.emitCreated(pluginChild, 'startup')
      world.emitCreated(teams, 'startup')
      duringOfficial = call(official, 'write')
      duringPlugin = call(pluginChild, 'write')
      expect(teams.guards).toHaveLength(0)
      expect(teams.guards[0]?.({ name: 'write', arguments: {} })).toBeUndefined()
      expect(modes(official.session)).toEqual([])
      expect(modes(pluginChild.session)).toEqual([])
      const ours = childOf(world, spec.childId ?? 'ours', spec.request.parent.session.id)
      world.children.push(ours)
      world.emitCreated(ours, 'startup')
      return { childId: ours.id }
    })
    await registeredTool(parent).execute({ ...ARGS, role: 'reviewer' }, execContext(parent))
    expect(duringOfficial).toMatch(/refused/)
    expect(duringPlugin).toMatch(/refused/)
    const official = world.children[0]
    const pluginChild = world.children[1]
    const teams = world.children[2]
    const ours = world.children[3]
    for (const child of [official, pluginChild, teams]) {
      expect(child).toBeDefined()
      if (child === undefined) continue
      expect(child.cancel).not.toHaveBeenCalled()
      expect(child.dispose).not.toHaveBeenCalled()
      expect(child.guards).toHaveLength(0)
      expect(child.guards[0]?.({ name: 'write', arguments: {} })).toBeUndefined()
      expect(modes(child.session)).toEqual([])
      expect(readRole(child.session)).toBeUndefined()
    }
    expect(ours).toBeDefined()
    if (ours !== undefined) expect(readRole(ours.session)?.id).toBe('reviewer')
  })

  it('guards a child with no parentSession when the reservation or the returned id matches', async () => {
    const { world, parent } = boot()
    world.subagents.startActivation.mockImplementation(async spec => {
      const reserved = childOf(world, spec.childId ?? 'reserved-no-parent', undefined)
      world.children.push(reserved)
      world.emitCreated(reserved, 'startup')
      return { childId: reserved.id }
    })
    await registeredTool(parent).execute({ ...ARGS, role: 'reviewer' }, execContext(parent))
    const reserved = world.children[0]
    expect(reserved).toBeDefined()
    if (reserved === undefined) return
    expect(reserved.session.header.parentSession).toBeUndefined()
    expect(readRole(reserved.session)?.id).toBe('reviewer')
    expect(call(reserved, 'write')).toMatch(/refused/)

    world.subagents.startActivation.mockImplementation(async _spec => {
      const returned = childOf(world, 'returned-no-parent', undefined)
      world.children.push(returned)
      world.emitCreated(returned, 'startup')
      expect(returned.guards).toHaveLength(0)
      return { childId: returned.id }
    })
    await registeredTool(parent).execute({ ...ARGS, role: 'reviewer' }, execContext(parent))
    const returned = world.children[1]
    expect(returned).toBeDefined()
    if (returned === undefined) return
    expect(readRole(returned.session)?.id).toBe('reviewer')
    expect(call(returned, 'write')).toMatch(/refused/)
    expect(returned.cancel).not.toHaveBeenCalled()
  })

  it('releases a same-parent child created while finish is still waiting', async () => {
    const { world, parent } = boot()
    let late: FakeAgent | undefined
    let heldDuring = 0
    world.subagents.startActivation.mockImplementation(async spec => {
      const child = childOf(world, 'during-other', spec.request.parent.session.id)
      const original = child.session.append.bind(child.session)
      child.session.append = (type, data) => {
        const event = original(type, data)
        if (late === undefined && type === 'sandbox/mode') {
          queueMicrotask(() => {
            late = childOf(world, 'arrived-during-finish', spec.request.parent.session.id)
            world.emitCreated(late, 'startup')
            heldDuring = late.guards.length
          })
        }
        return event
      }
      world.children.push(child)
      world.emitCreated(child, 'startup')
      return { childId: child.id }
    })
    await registeredTool(parent).execute({ ...ARGS, role: 'reviewer' }, execContext(parent))
    expect(late).toBeDefined()
    expect(heldDuring).toBe(1)
    expect(late?.cancel).not.toHaveBeenCalled()
    expect(late?.dispose).not.toHaveBeenCalled()
    expect(late?.guards).toHaveLength(0)
    if (late !== undefined) expect(modes(late.session)).toEqual([])
    const started = world.children[0]
    expect(started).toBeDefined()
    if (started !== undefined) expect(readRole(started.session)?.id).toBe('reviewer')
  })

  it('leaves a parentless child and another parent untouched during activation', async () => {
    const { world, parent } = boot()
    const teams = childOf(world, 'teams-member', undefined)
    const other = childOf(world, 'other-parent', 'session-someone-else')
    world.subagents.startActivation.mockImplementation(async spec => {
      world.emitCreated(teams, 'startup')
      world.emitCreated(other, 'startup')
      const child = childOf(world, spec.childId ?? 'real', spec.request.parent.session.id)
      world.children.push(child)
      world.emitCreated(child, 'startup')
      return { childId: child.id }
    })
    await registeredTool(parent).execute({ ...ARGS, role: 'reviewer' }, execContext(parent))
    expect(teams.guards).toHaveLength(0)
    expect(other.guards).toHaveLength(0)
    expect(modes(teams.session)).toEqual([])
    expect(modes(other.session)).toEqual([])
    expect(teams.cancel).not.toHaveBeenCalled()
    expect(teams.dispose).not.toHaveBeenCalled()
    expect(other.cancel).not.toHaveBeenCalled()
    expect(other.dispose).not.toHaveBeenCalled()
  })

  it('releases an unbound child when activation throws', async () => {
    const { world, parent } = boot()
    let third: FakeAgent | undefined
    world.subagents.startActivation.mockImplementation(async spec => {
      third = childOf(world, 'third-throw', spec.request.parent.session.id)
      world.emitCreated(third, 'startup')
      throw new Error('provider failed')
    })
    await expect(registeredTool(parent).execute({ ...ARGS, role: 'reviewer' }, execContext(parent))).rejects.toThrow(
      /provider failed/,
    )
    expect(third?.cancel).not.toHaveBeenCalled()
    expect(third?.dispose).not.toHaveBeenCalled()
    expect(third?.guards).toHaveLength(0)
    if (third !== undefined) expect(modes(third.session)).toEqual([])
  })
})

describe('reservations are cleaned up without a timer', () => {
  async function reserveWithoutCreated(world: ReturnType<typeof boot>['world'], parent: FakeAgent): Promise<FakeAgent> {
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
    if (late === undefined) throw new Error('no child')
    return late
  }

  it('drops the reservation when the parent is disposed, so a later created is not pinned', async () => {
    const { world, parent } = boot()
    let stray: FakeAgent | undefined
    let reservedId = ''
    world.subagents.startActivation.mockImplementation(async spec => {
      stray = world.newAgent('stray-parent-gone', {
        origin: 'subagent',
        parentSession: spec.request.parent.session.id,
        delegationDepth: 1,
      })
      world.emitCreated(stray, 'startup')
      world.emitDisposed(parent)
      reservedId = spec.childId ?? 'reserved-late'
      return { childId: reservedId }
    })
    await registeredTool(parent).execute({ ...ARGS, role: 'reviewer' }, execContext(parent))
    expect(stray?.cancel).not.toHaveBeenCalled()
    expect(stray?.dispose).not.toHaveBeenCalled()
    expect(stray?.guards).toHaveLength(0)
    const late = world.newAgent(reservedId, {
      origin: 'subagent',
      parentSession: parent.session.id,
      delegationDepth: 1,
    })
    world.emitCreated(late, 'startup')
    expect(readRole(late.session)).toBeUndefined()
    expect(late.guards).toHaveLength(0)
    expect(modes(late.session)).toEqual([])
  })

  it('drops the reservation when the reserved child is disposed before agent/created', async () => {
    const { world, parent } = boot()
    const late = await reserveWithoutCreated(world, parent)
    world.emitDisposed(late)
    world.emitCreated(late, 'startup')
    expect(readRole(late.session)).toBeUndefined()
    expect(late.guards).toHaveLength(0)
    expect(modes(late.session)).toEqual([])
  })

  it('drops the reservation when the plugin unloads', async () => {
    const { world, parent } = boot()
    const late = await reserveWithoutCreated(world, parent)
    world.teardown()
    world.emitCreated(late, 'startup')
    expect(readRole(late.session)).toBeUndefined()
    expect(late.guards).toHaveLength(0)
    expect(modes(late.session)).toEqual([])
  })

  it('releases an unbound child when the plugin unloads during activation', async () => {
    const { world, parent } = boot()
    let stray: FakeAgent | undefined
    world.subagents.startActivation.mockImplementation(async spec => {
      stray = world.newAgent('during-unload', {
        origin: 'subagent',
        parentSession: spec.request.parent.session.id,
        delegationDepth: 1,
      })
      world.emitCreated(stray, 'startup')
      world.teardown()
      return { childId: stray.id }
    })
    await expect(registeredTool(parent).execute({ ...ARGS, role: 'reviewer' }, execContext(parent))).rejects.toThrow(
      /could not be matched/,
    )
    expect(stray?.cancel).not.toHaveBeenCalled()
    expect(stray?.dispose).not.toHaveBeenCalled()
    expect(stray?.guards).toHaveLength(0)
  })

  it('still applies the role when created arrives long after activation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    try {
      const { world, parent } = boot()
      const late = await reserveWithoutCreated(world, parent)
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      world.emitCreated(late, 'startup')
      expect(readRole(late.session)).toMatchObject({ id: 'reviewer', readOnly: true })
      expect(modes(late.session).at(-1)).toEqual({ mode: 'read-only' })
      expect(call(late, 'write')).toMatch(/refused/)
      expect(call(late, 'bash')).toBeUndefined()
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
    expect(call(explorer, 'send_message', { agent_id: reviewer.session.id, message: 'status update' })).toBeUndefined()
    expect(call(explorer, 'send_message', { agent_ids: [reviewer.session.id] })).toBeUndefined()
    expect(call(explorer, 'send_message', { agent_ids: [reviewer.session.id, parent.session.id] })).toMatch(
      /destination is not a read-only/,
    )
    expect(call(explorer, 'send_message', { note: reviewer.session.id })).toMatch(/destination is not a read-only/)
    expect(
      call(explorer, 'send_message', {
        agent_id: reviewer.session.id,
        message: `see ${parent.session.id}`,
        trace_id: '12345678-1234-1234-1234-123456789abc',
      }),
    ).toBeUndefined()
    expect(call(explorer, 'send_message', { agent_id: '12345678-1234-1234-1234-123456789abc' })).toMatch(
      /destination is not a read-only/,
    )

    const worker = await delegate('worker')
    world.agents = [parent, reviewer, explorer, worker]
    const readable = reviewer.session.id
    const writable = worker.session.id
    const hidden: Record<string, unknown>[] = [
      { id: writable },
      { destination: writable },
      { agents: [writable] },
      { subagent_id: writable },
      { metadata: { agent_id: writable } },
    ]
    for (const extra of hidden) {
      expect(call(explorer, 'send_message', { agent_id: readable, ...extra })).toMatch(/destination is not a read-only/)
    }
    expect(
      call(explorer, 'send_message', {
        agent_id: readable,
        id: '12345678-1234-1234-1234-123456789abc',
      }),
    ).toBeUndefined()
  })

  it('accepts a resumed read-only session that only the sessions service still lists', async () => {
    const { world, delegate } = boot()
    const explorer = await delegate('explorer')
    const resumed = fakeSession('resumed-peer')
    resumed.append('sandbox/mode', { mode: 'read-only' })
    writeRole(resumed, REVIEWER)
    world.sessions.set(resumed.id, resumed)
    world.agents = [explorer]
    expect(call(explorer, 'send_message', { agent_id: resumed.id })).toBeUndefined()
    expect(call(explorer, 'send_message', { agent_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })).toMatch(
      /destination is not a read-only/,
    )
  })

  it('refuses every tool when this session log cannot be read', async () => {
    const { delegate } = boot()
    const child = await delegate('reviewer')
    child.session.snapshotEvents = () => {
      throw new Error('log closed')
    }
    expect(() => call(child, 'read')).not.toThrow()
    expect(call(child, 'read')).toMatch(/session log could not be read/)
    expect(call(child, 'bash')).toMatch(/session log could not be read/)
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

  it('refuses parent speech that is not only a turn boundary', async () => {
    const taskFork = builtinRole('fork', { forkScope: 'task', readOnly: true })
    const seeds: unknown[] = [
      [{ type: 'user/message', data: { text: 'from the parent' } }],
      [{ type: 'assistant/message' }],
      [{ type: 'developer/message' }],
      [{ type: 'system/message' }],
      [{ type: 'tool/call' }],
      [{ type: 'tool/result' }],
      [{ type: 'compaction/summary' }],
      [{ type: 'turn/end' }],
    ]
    for (const seed of seeds) {
      const { world, delegate } = boot([GENERAL, taskFork])
      world.providers.set(
        'spawn',
        fakeProvider('spawn', {
          inheritsParentContext: false,
          prepareContinuable: async () => ({ seed: seed as readonly unknown[] }),
        }),
      )
      await expect(delegate('fork')).rejects.toThrow(/provider "spawn" copies it/)
      expect(world.subagents.startActivation).not.toHaveBeenCalled()
    }
  })

  it('refuses parent-content events and unknown types in the seed', async () => {
    const taskFork = builtinRole('fork', { forkScope: 'task', readOnly: true })
    const seeds: unknown[] = [
      [{ type: 'agent/inbox/spliced', data: { inserted: [{ role: 'user', content: 'from the parent' }] } }],
      [{ type: 'team/message/queued', data: { message: { content: [{ type: 'text', text: 'ping' }] } } }],
      [{ type: 'team/message/delivered', data: { messageId: 'm1', targetId: 'child' } }],
      [{ type: 'feedback/message-put', data: { item: { note: 'wrong answer' } } }],
      [{ type: 'feedback/record', data: { text: 'please review' } }],
      [{ type: 'goal/change', data: { goal: { objective: 'finish the parent task' } } }],
      [{ type: 'command/run', data: { name: 'compact' } }],
      [{ type: 'session/title', data: { title: 'the parent conversation' } }],
      [{ type: 'schedule/change', data: { operation: 'create' } }],
      [{ type: 'request/header', data: { header: { tools: [] } } }],
      [{ type: 'mystery/blob' }],
      [{ weird: true }],
      [null],
      ['not-an-event'],
    ]
    for (const seed of seeds) {
      const { world, delegate } = boot([GENERAL, taskFork])
      world.providers.set(
        'spawn',
        fakeProvider('spawn', {
          inheritsParentContext: false,
          prepareContinuable: async () => ({ seed: seed as readonly unknown[] }),
        }),
      )
      await expect(delegate('fork')).rejects.toThrow(/provider "spawn" copies it/)
      expect(world.subagents.startActivation).not.toHaveBeenCalled()
    }
  })

  it('starts when the seed is only sandbox setup or a plugin record', async () => {
    const taskFork = builtinRole('fork', { forkScope: 'task', readOnly: true })
    const { world, delegate } = boot([GENERAL, taskFork])
    world.providers.set(
      'spawn',
      fakeProvider('spawn', {
        inheritsParentContext: false,
        prepareContinuable: async () => ({
          seed: [
            { type: 'sandbox/mode', data: { mode: 'read-only' } },
            { type: 'plugin:dsh-rolesubagents/roles', data: {} },
            { type: 'approval/policy' },
            { type: 'permission/preset', data: { preset: 'auto' } },
            { type: 'session/end-seed' },
            { type: 'agent-preset/selected', data: { agentPreset: 'default' } },
            { type: 'subagent/descriptor', data: { provider: 'spawn', mode: 'one-shot' } },
            { type: 'subagent/model-selection-policy', data: { allowedModels: [] } },
            { type: 'working-directory/change', data: { cwd: '/workspace' } },
            {
              type: 'agent/inbox/spliced',
              data: {
                inserted: [{ role: 'user', content: 'cwd', source: { kind: 'working-directory' } }],
              },
            },
          ],
        }),
      }),
    )
    const child = await delegate('fork')
    expect(readRole(child.session)?.id).toBe('fork')
    expect(world.subagents.startActivation).toHaveBeenCalledTimes(1)
  })

  it('stops a child whose log contains a parent message that is not a turn', async () => {
    const taskFork = builtinRole('fork', { forkScope: 'task', readOnly: true })
    const { world, parent } = boot([GENERAL, taskFork])
    const activationDispose = vi.fn(async () => {})
    world.subagents.startActivation.mockImplementation(async spec => {
      const id = spec.childId ?? 'seeded'
      const session = fakeSession(id)
      session.log.push({ type: 'user/message', seq: 0, time: 0, data: { text: 'from the parent' } })
      world.sessions.set(id, session)
      const child = world.newAgent(id, {
        origin: 'subagent',
        parentSession: spec.request.parent.session.id,
        delegationDepth: 1,
      })
      child.session.log.push({ type: 'user/message', seq: 0, time: 0, data: { text: 'from the parent' } })
      world.children.push(child)
      world.agents = [...world.agents, child]
      return { childId: id, dispose: activationDispose }
    })
    await expect(registeredTool(parent).execute({ ...ARGS, role: 'fork' }, execContext(parent))).rejects.toThrow(
      /already contains it/,
    )
    expect(world.children[0]?.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(world.children[0]?.dispose).toHaveBeenCalledTimes(1)
    expect(activationDispose).toHaveBeenCalledTimes(1)
  })

  it('stops a child whose log contains an unknown event', async () => {
    const taskFork = builtinRole('fork', { forkScope: 'task', readOnly: true })
    const { world, parent } = boot([GENERAL, taskFork])
    const activationDispose = vi.fn(async () => {})
    world.subagents.startActivation.mockImplementation(async spec => {
      const id = spec.childId ?? 'mystery'
      const child = world.newAgent(id, {
        origin: 'subagent',
        parentSession: spec.request.parent.session.id,
        delegationDepth: 1,
      })
      child.session.log.push({ type: 'mystery/blob', seq: 0, time: 0, data: {} })
      world.children.push(child)
      world.agents = [...world.agents, child]
      return { childId: child.id, dispose: activationDispose }
    })
    await expect(registeredTool(parent).execute({ ...ARGS, role: 'fork' }, execContext(parent))).rejects.toThrow(
      /already contains it/,
    )
    expect(activationDispose).toHaveBeenCalledTimes(1)
    expect(world.children[0]?.cancel).toHaveBeenCalledWith({ kind: 'user' })
    expect(world.children[0]?.dispose).toHaveBeenCalledTimes(1)
  })

  it('stops a child whose log contains a team message or feedback note', async () => {
    const taskFork = builtinRole('fork', { forkScope: 'task', readOnly: true })
    const leaks = [
      { type: 'team/message/queued', data: { message: { content: [] } } },
      { type: 'feedback/message-put', data: { item: { note: 'from the parent' } } },
      {
        type: 'agent/inbox/spliced',
        data: { inserted: [{ role: 'user', content: 'parent prompt', source: { kind: 'user' } }] },
      },
    ]
    for (const leak of leaks) {
      const { world, parent } = boot([GENERAL, taskFork])
      const activationDispose = vi.fn(async () => {})
      world.subagents.startActivation.mockImplementation(async spec => {
        const id = spec.childId ?? 'leaked'
        const child = world.newAgent(id, {
          origin: 'subagent',
          parentSession: spec.request.parent.session.id,
          delegationDepth: 1,
        })
        child.session.log.push({ ...leak, seq: 0, time: 0 })
        world.children.push(child)
        world.agents = [...world.agents, child]
        return { childId: child.id, dispose: activationDispose }
      })
      await expect(registeredTool(parent).execute({ ...ARGS, role: 'fork' }, execContext(parent))).rejects.toThrow(
        /already contains it/,
      )
      expect(activationDispose).toHaveBeenCalledTimes(1)
      expect(world.children[0]?.cancel).toHaveBeenCalledWith({ kind: 'user' })
    }
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
