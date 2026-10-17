import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/host/index.ts'
import { lastSandboxMode } from '../src/host/readonly.ts'
import { createRoleState } from '../src/host/state.ts'
import { builtinRole, fakeAgent, fakeSession, fakeWorld, registeredTool, role, settingsOf } from './host-fakes.ts'

vi.mock('@deepseek-ai/dsh-storage-domain', () => import('./host-fakes.ts').then(m => m.storageDomainModule()))
vi.mock('@deepseek-ai/dsh-tools', () => import('./host-fakes.ts').then(m => m.toolsModule()))

describe('storage startup and teardown', () => {
  it('waits for saved role state before preparing a resumed agent', async () => {
    const seed = fakeWorld()
    const saved = createRoleState(seed.ctx)
    const session = fakeSession('resumed-review')
    const reviewer = role('saved-reviewer', { readOnly: true, instructions: 'Keep the saved review criteria.' })
    const snapshot = settingsOf([builtinRole('general'), builtinRole('fork'), reviewer])
    await saved.ready
    saved.writeRole(session, reviewer)
    saved.writeSnapshot(session, snapshot)
    await saved.flush()
    await saved.close()

    const world = fakeWorld(seed.storage)
    let release!: () => void
    const opening = {
      promise: new Promise<void>(resolve => {
        release = resolve
      }),
    }
    world.services.storageDomain = {
      async open(spec) {
        await opening.promise
        return world.storage.facility.open(spec)
      },
    }
    apply(world.ctx, { roles: [builtinRole('general'), builtinRole('fork'), role('new-config')] })
    const resumed = fakeAgent('resumed', session)
    const prepared = world.emitCreated(resumed, 'resume')
    expect(resumed.register).not.toHaveBeenCalled()
    release()
    await prepared
    await world.settle()

    expect(registeredTool(resumed).description).toContain('saved-reviewer')
    expect(registeredTool(resumed).description).not.toContain('new-config')
    expect(world.runtimeContext(resumed)).toContain('Keep the saved review criteria.')
    expect(lastSandboxMode(session)).toBe('read-only')
    expect(resumed.guards[0]?.({ name: 'write', arguments: {} })).toMatch(/read-only/)
    expect(world.storedSnapshot(session.id)).toEqual({ version: 1, settings: snapshot })
    await world.teardown()
  })

  it('does not rewrite every saved session when reopening the storage domain', async () => {
    const world = fakeWorld()
    const session = fakeSession('already-saved')
    const saved = createRoleState(world.ctx)
    await saved.ready
    saved.writeSnapshot(session, settingsOf([builtinRole('general'), builtinRole('fork')]))
    saved.writeRole(session, role('review', { readOnly: true }))
    await saved.flush()
    await saved.close()

    const put = vi.fn()
    world.services.storageDomain = {
      async open(spec) {
        const domain = await world.storage.facility.open(spec)
        return {
          table(name) {
            const table = domain.table(name)
            return {
              ...table,
              put: async (key, value) => {
                put(name, key)
                await table.put(key, value)
              },
            }
          },
          close: () => domain.close(),
        }
      },
    }
    const reopened = createRoleState(world.ctx)
    await reopened.flush()
    expect(reopened.readRole(session)?.readOnly).toBe(true)
    expect(put).not.toHaveBeenCalled()
    await reopened.close()
  })

  it('does not install tools after the plugin was unloaded during storage opening', async () => {
    const world = fakeWorld()
    let release!: () => void
    const opening = {
      promise: new Promise<void>(resolve => {
        release = resolve
      }),
    }
    const closed = vi.fn()
    world.services.storageDomain = {
      async open(spec) {
        await opening.promise
        const domain = await world.storage.facility.open(spec)
        return {
          ...domain,
          close: async () => {
            closed()
            await domain.close()
          },
        }
      },
    }
    const existing = world.newAgent('existing')
    world.agents = [existing]
    apply(world.ctx)
    const teardown = world.teardown()
    release()
    await teardown
    await world.settle()
    expect(existing.register).not.toHaveBeenCalled()
    expect(closed).toHaveBeenCalledTimes(1)
  })

  it('fails resumed read-only initialization if its guard cannot be installed', async () => {
    const world = fakeWorld()
    const state = createRoleState(world.ctx)
    const session = fakeSession('read-only-resume')
    await state.ready
    state.writeRole(session, role('reviewer', { readOnly: true }))
    await state.flush()
    await state.close()
    const resumed = fakeAgent('resumed', session)
    resumed.ctx.tools.guard = () => {
      throw new Error('guard registry unavailable')
    }
    apply(world.ctx)
    await world.settle()
    await expect(Promise.resolve().then(() => world.emitCreated(resumed, 'resume'))).rejects.toThrow(
      'guard registry unavailable',
    )
    expect(resumed.disposers[0]).toHaveBeenCalledTimes(1)
    await world.teardown()
  })
})
