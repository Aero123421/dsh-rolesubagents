import { describe, expect, it, vi } from 'vitest'
import type { MethodDecoratorContextLike, TypertModule } from '../src/host/external/probe-service.ts'
import type { DomainPort, HostContext } from '../src/host/ports.ts'
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
  const lifetime = new AbortController()
  let disposed = false
  const options = { state, isDisposed: () => disposed, lifetime: lifetime.signal }
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
      lifetime.abort()
    },
  }
}

describe('role display saved identities', () => {
  it('reads durable roles by exact id without a loaded child; unknown/older externals stay unknown', async () => {
    const { world, state } = setup()
    state.writeRoleById('external-activation', role('coder'))
    state.writeRole(fakeSession('actual-session'), role('reviewer'))
    expect(state.readRoleById('external-activation')?.id).toBe('coder')
    await state.flush()
    const reopened = createRoleState(world.ctx)
    await reopened.ready
    expect(reopened.readRoleById('external-activation')?.id).toBe('coder')
    expect(reopened.readRoleById('actual-session')?.id).toBe('reviewer')
    for (const id of ['reserved-agent', 'cli-thread', 'coder', 'old-external'])
      expect(reopened.readRoleById(id)).toBeUndefined()
    await reopened.close()
    await state.close()
  })

  it('uses only explicit loaded legacy records, not names, parents or snapshots', async () => {
    const world = fakeWorld()
    const parent = world.newAgent('parent')
    const child = world.newAgent('reviewer', { parentSession: parent.session.id })
    appendRecord(parent.session, ROLE_RECORD, { version: 1, role: role('reviewer') })
    const state = createRoleState(world.ctx)
    await state.ready
    expect(state.readRoleById(parent.session.id)?.id).toBe('reviewer')
    expect(state.readRoleById(child.session.id)).toBeUndefined()
    state.writeRole(parent.session, role('worker'))
    expect(state.readRoleById(parent.session.id)?.id).toBe('worker')
    await state.close()
  })

  it('keeps by-id memory reads usable without storage and refuses writes once closed', async () => {
    const world = fakeWorld()
    delete world.services.storageDomain
    const state = createRoleState(world.ctx)
    await state.ready
    state.writeRoleById('external', role('worker'))
    expect(state.degraded).toBe(true)
    expect(state.readRoleById('external')?.id).toBe('worker')
    const closing = state.close()
    expect(() => state.writeRoleById('late', role('late'))).toThrow('closed')
    expect(state.readRoleById('late')).toBeUndefined()
    await closing
  })
})

describe('role display Remote API', () => {
  it('marks read-only methods with stable parameters and allowlists response fields', async () => {
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
    expect(typert.marked.mock.calls).toEqual([
      ['query', Service.prototype.query, service],
      ['externalRuns', Service.prototype.externalRuns, service],
    ])
    expect(Service.prototype.query.toString()).toMatch(/^async query\(childIds, signal\)/)
    const write = vi.spyOn(state, 'writeRoleById')
    expect(await service.query(['custom', 'builtin', 'missing', 'custom'], signal)).toEqual([
      { roleId: 'reviewer', displayName: 'reviewer' },
      { roleId: 'fork', displayName: 'fork', builtin: 'fork' },
      null,
      { roleId: 'reviewer', displayName: 'reviewer' },
    ])
    expect(await service.query([], signal)).toEqual([])
    expect(write).not.toHaveBeenCalled()
  })

  it.each(
    [
      null,
      {},
      'id',
      [1],
      [''],
      ['a/b'],
      ['a b'],
      ['a\n'],
      ['_bad'],
      ['a'.repeat(257)],
      Array(1),
      Array(101).fill('id'),
    ].map(input => [input]),
  )('rejects malformed or oversized inputs before reading state: %j', async input => {
    const { service, state } = setup()
    const read = vi.spyOn(state, 'readRoleById')
    await expect(service.query(input, signal)).rejects.toThrow('childIds must be')
    expect(read).not.toHaveBeenCalled()
  })

  it('accepts boundary lengths/counts and copies inputs before awaiting readiness', async () => {
    const { service } = setup()
    expect(await service.query(Array(100).fill('a'.repeat(256)), signal)).toHaveLength(100)
    const input = ['missing']
    const result = service.query(input, signal)
    input.push('changed')
    expect(await result).toEqual([null])
  })

  it('waits for actual persisted cold metadata, without rewriting rows', async () => {
    const world = fakeWorld()
    let open!: (domain: DomainPort) => void
    world.services.storageDomain = {
      open: () =>
        new Promise(resolve => {
          open = resolve
        }),
    }
    const state = createRoleState(world.ctx)
    const Service = createRoleDisplayServiceClass(fakeTypert().module, { state, isDisposed: () => false })
    const put = vi.fn(async () => {})
    const result = new Service({}).query(['cold'], signal)
    const read = vi.spyOn(state, 'readRoleById')
    await Promise.resolve()
    expect(read).not.toHaveBeenCalled()
    open({
      table: name => ({
        get: () => undefined,
        put,
        entries: () => (name === 'roles' ? [['cold', { version: 1, role: role('saved') }]] : []),
      }),
      close: async () => {},
    })
    expect(await result).toEqual([{ roleId: 'saved', displayName: 'saved' }])
    expect(put).not.toHaveBeenCalled()
    await state.close()
  })

  it('cancels a cold wait on request abort without cancelling other readers', async () => {
    let resolve!: () => void
    const ready = new Promise<void>(done => {
      resolve = done
    })
    const readRoleById = vi.fn(() => role('worker'))
    const Service = createRoleDisplayServiceClass(fakeTypert().module, {
      state: { ready, readRoleById },
      isDisposed: () => false,
    })
    const service = new Service({})
    const controller = new AbortController()
    const cancelled = service.query(['child'], controller.signal)
    const other = service.query(['child'], signal)
    controller.abort()
    await expect(cancelled).rejects.toThrow('cancelled')
    expect(readRoleById).not.toHaveBeenCalled()
    resolve()
    expect(await other).toEqual([{ roleId: 'worker', displayName: 'worker' }])
  })

  it.each(['plugin', 'service'] as const)(
    'cancels cold requests on %s disposal without waiting for storage',
    async kind => {
      const world = fakeWorld()
      const lifetime = new AbortController()
      const readRoleById = vi.fn(() => role('worker'))
      const Service = createRoleDisplayServiceClass(fakeTypert().module, {
        state: { ready: new Promise(() => {}), readRoleById },
        isDisposed: () => false,
        lifetime: lifetime.signal,
      })
      const service = new Service(world.ctx)
      const result = service.query(['child'], signal)
      if (kind === 'plugin') lifetime.abort()
      else await world.teardown()
      await expect(result).rejects.toThrow('cancelled')
      expect(readRoleById).not.toHaveBeenCalled()
      await expect(service.query(['child'], signal)).rejects.toThrow('disposed')
    },
  )

  it('rechecks disposal after readiness and before lookups', async () => {
    let resolve!: () => void
    let disposed = false
    const ready = new Promise<void>(done => {
      resolve = done
    })
    const readRoleById = vi.fn(() => role('worker'))
    const Service = createRoleDisplayServiceClass(fakeTypert().module, {
      state: { ready, readRoleById },
      isDisposed: () => disposed,
    })
    const result = new Service({}).query(['child'], signal)
    disposed = true
    resolve()
    await expect(result).rejects.toThrow('disposed')
    expect(readRoleById).not.toHaveBeenCalled()
  })

  it('mounts optionally, retries failed registration, and fences late imports', async () => {
    const { world, options, dispose, typert } = setup()
    const plugin = vi.fn()
    const ctx = Object.assign(Object.create(world.ctx) as HostContext, { plugin })
    const load = vi.fn(async () => typert.module)
    await mountRoleDisplayService(world.ctx, options, load)
    expect(load).not.toHaveBeenCalled()
    const failing = async () => {
      throw new Error('private dependency details')
    }
    await mountRoleDisplayService(ctx, options, failing)
    await mountRoleDisplayService(ctx, options, failing)
    expect(world.logger.info.mock.calls).toEqual([['rolesubagents: role display is unavailable']])
    plugin.mockImplementationOnce(() => {
      throw new Error('registration failure')
    })
    await mountRoleDisplayService(ctx, options, load)
    expect(world.logger.warn).toHaveBeenCalledWith('rolesubagents: could not mount role display')
    await mountRoleDisplayService(ctx, options, load)
    expect(plugin).toHaveBeenCalledTimes(2)
    await mountRoleDisplayService(ctx, options, async () => {
      dispose()
      return typert.module
    })
    await mountRoleDisplayService(ctx, options, load)
    expect(plugin).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
