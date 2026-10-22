import { describe, expect, it, vi } from 'vitest'
import type { MethodDecoratorContextLike, TypertModule } from '../src/host/external/probe-service.ts'
import type { HostContext } from '../src/host/ports.ts'
import { createRoleDisplayServiceClass, mountRoleDisplayService } from '../src/host/role-display-service.ts'
import { createRoleState, ROLE_RECORD } from '../src/host/state.ts'
import { ROLE_DISPLAY_SERVICE_NAME } from '../src/shared/role-display.ts'
import { appendRecord, builtinRole, fakeSession, fakeWorld, role } from './host-fakes.ts'

vi.mock('@deepseek-ai/dsh-storage-domain', () => import('./host-fakes.ts').then(m => m.storageDomainModule()))

function fakeTypert() {
  const constructed = vi.fn()
  const marked = vi.fn()
  class TypertRemoteService {
    constructor(...args: unknown[]) {
      constructed(...args)
    }
  }
  const Remote = (name: string) => (method: unknown, context: MethodDecoratorContextLike) => {
    context.addInitializer(function (this: unknown) {
      marked(name, method, this)
    })
  }
  return { module: { TypertRemoteService, Remote } as TypertModule, constructed, marked }
}

const signal = new AbortController().signal

function setup() {
  const world = fakeWorld()
  const state = createRoleState(world.ctx)
  let disposed = false
  const options = { state, isDisposed: () => disposed }
  const typert = fakeTypert()
  const Service = createRoleDisplayServiceClass(typert.module, options)
  const service = new Service(world.ctx)
  return {
    world,
    state,
    options,
    typert,
    Service,
    service,
    dispose: () => {
      disposed = true
    },
  }
}

describe('role display state', () => {
  it('reads durable and in-memory roles without a loaded child', async () => {
    const { world, state } = setup()
    state.writeRoleById('external-1', role('coder'))
    expect(state.readRoleById('external-1')?.id).toBe('coder')
    await state.flush()
    const reopened = createRoleState(world.ctx)
    await reopened.ready
    expect(reopened.readRoleById('external-1')?.id).toBe('coder')
    expect(reopened.readRoleById('missing')).toBeUndefined()
    await reopened.close()
    await state.close()
  })

  it('falls back only to already loaded legacy sessions and prefers durable state', async () => {
    const world = fakeWorld()
    const agent = world.newAgent('legacy')
    appendRecord(agent.session, ROLE_RECORD, { version: 1, role: role('reviewer') })
    const state = createRoleState(world.ctx)
    await state.ready
    expect(state.readRoleById(agent.session.id)?.id).toBe('reviewer')
    state.writeRole(agent.session, role('worker'))
    expect(state.readRoleById(agent.session.id)?.id).toBe('worker')
    expect(state.readRoleById('not-loaded')).toBeUndefined()
  })

  it('keeps id lookups usable without storage', async () => {
    const ctx = { get: () => undefined, logger: { warn: vi.fn() } } as unknown as HostContext
    const state = createRoleState(ctx)
    await state.ready
    state.writeRole(fakeSession('child'), role('worker'))
    expect(state.degraded).toBe(true)
    expect(state.readRoleById('child')?.id).toBe('worker')
  })
})

describe('role display Remote API', () => {
  it('marks query with stable parameter names and returns only allowlisted metadata', async () => {
    const { state, service, Service, typert, world } = setup()
    state.writeRoleById(
      'custom',
      role('reviewer', {
        description: 'private description',
        instructions: 'SECRET',
        model: { provider: 'private-provider', model: 'private-model' },
        runner: { cli: 'codex', permission: 'read-only' },
      }),
    )
    state.writeRoleById('builtin', builtinRole('fork'))
    expect(typert.constructed).toHaveBeenCalledWith(world.ctx, ROLE_DISPLAY_SERVICE_NAME)
    expect(typert.marked).toHaveBeenCalledWith('query', Service.prototype.query, service)
    expect(Service.prototype.query.toString()).toMatch(/^async query\(childIds, signal\)/)
    expect(await service.query(['custom', 'builtin', 'missing', 'custom'], signal)).toEqual([
      { roleId: 'reviewer', displayName: 'reviewer' },
      { roleId: 'fork', displayName: 'fork', builtin: 'fork' },
      null,
      { roleId: 'reviewer', displayName: 'reviewer' },
    ])
    expect(await service.query([], signal)).toEqual([])
  })

  it.each(
    [null, {}, 'id', [1], [''], ['a/b'], ['a b'], ['a\n'], ['a'.repeat(257)], Array(1), Array(101).fill('id')].map(
      input => [input],
    ),
  )('rejects malformed or oversized input before reading state: %j', async input => {
    const { service, state } = setup()
    const read = vi.spyOn(state, 'readRoleById')
    await expect(service.query(input, signal)).rejects.toThrow('childIds must be')
    expect(read).not.toHaveBeenCalled()
  })

  it('accepts boundary lengths and counts', async () => {
    const { service } = setup()
    expect(await service.query(Array(100).fill('a'.repeat(256)), signal)).toHaveLength(100)
  })

  it('waits for state readiness and rejects disposal during the wait', async () => {
    let resolve = () => {}
    const ready = new Promise<void>(done => {
      resolve = done
    })
    const readRoleById = vi.fn(() => role('worker'))
    let disposed = false
    const Service = createRoleDisplayServiceClass(fakeTypert().module, {
      state: { ready, readRoleById },
      isDisposed: () => disposed,
    })
    const result = new Service({}).query(['child'], signal)
    expect(readRoleById).not.toHaveBeenCalled()
    disposed = true
    resolve()
    await expect(result).rejects.toThrow('disposed')
    expect(readRoleById).not.toHaveBeenCalled()
  })

  it('rejects aborted requests and calls after disposal', async () => {
    const { service, dispose } = setup()
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(service.query(['child'], controller.signal)).rejects.toThrow('cancelled')
    dispose()
    await expect(service.query(['child'], signal)).rejects.toThrow('disposed')
  })

  it('mounts optionally and handles import, mount, and unload races', async () => {
    const { world, options, dispose, typert } = setup()
    const plugin = vi.fn()
    const ctx = Object.assign(Object.create(world.ctx) as HostContext, { plugin })
    const load = vi.fn(async () => typert.module)
    await mountRoleDisplayService(world.ctx, options, load)
    expect(load).not.toHaveBeenCalled()
    await mountRoleDisplayService(ctx, options, load)
    expect(plugin).toHaveBeenCalledTimes(1)
    const failing = async () => {
      throw new Error('missing optional package')
    }
    await mountRoleDisplayService(ctx, options, failing)
    await mountRoleDisplayService(ctx, options, failing)
    expect(world.logger.info).toHaveBeenCalledTimes(1)
    plugin.mockImplementationOnce(() => {
      throw new Error('mount failure')
    })
    await mountRoleDisplayService(ctx, options, load)
    expect(world.logger.warn).toHaveBeenCalledWith(expect.stringContaining('could not mount role display'))
    await mountRoleDisplayService(ctx, options, async () => {
      dispose()
      return typert.module
    })
    expect(plugin).toHaveBeenCalledTimes(2)
    await mountRoleDisplayService(ctx, options, load)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
