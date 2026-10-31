import { describe, expect, it, vi } from 'vitest'
import { createExternalRunStore } from '../src/host/external/observability.ts'
import { createRoleDisplayServiceClass } from '../src/host/role-display-service.ts'
import type { TypertModule } from '../src/host/external/probe-service.ts'
import type { StorageDomainPort } from '../src/host/ports.ts'
import { MAX_EXTERNAL_RUN_RESULT_LENGTH, MAX_EXTERNAL_RUNS } from '../src/shared/role-display.ts'
vi.mock('@deepseek-ai/dsh-storage-domain', () => import('./host-fakes.ts').then(m => m.storageDomainModule()))
const entry = (id = 'run', parentSessionId = 'parent') => ({
  id,
  parentSessionId,
  roleId: 'worker',
  cli: 'codex' as const,
  model: 'model',
  label: 'work',
  startedAt: new Date().toISOString(),
})
function storage() {
  let value: unknown
  const facility: StorageDomainPort = {
    open: async () => ({
      table: () => ({
        get: () => value,
        entries: () => [],
        put: async (_key, next) => {
          value = structuredClone(next)
        },
      }),
      close: async () => {},
    }),
  }
  return facility
}
describe('external result history', () => {
  it.each([false, true])(
    'does not claim newer mutations durable after an older write (initializing=%s)',
    async initializing => {
      let block = initializing
      const writes: (() => void)[] = []
      const facility: StorageDomainPort = {
        open: async () => ({
          table: () => ({
            get: () => undefined,
            entries: () => [],
            put: async () => {
              if (block) await new Promise<void>(resolve => writes.push(resolve))
            },
          }),
          close: async () => {},
        }),
      }
      const store = createExternalRunStore(() => facility)
      if (!initializing) await store.ready
      block = true
      store.start(entry())
      await vi.waitFor(() => expect(writes).toHaveLength(1))
      store.finish('run', 'succeeded')
      writes[0]!()
      await vi.waitFor(() => expect(writes).toHaveLength(2))
      expect((await store.list('parent')).runs[0]?.status).toBe('succeeded')
      expect((await store.list('parent')).durable).toBe(false)
      block = false
      writes[1]!()
      await store.flush()
      expect((await store.list('parent')).durable).toBe(true)
      await store.close()
    },
  )
  it('scopes, bounds, retains final results across reload without raw diagnostics', async () => {
    const facility = storage()
    const store = createExternalRunStore(() => facility)
    store.start(entry())
    store.start(entry('other', 'other-parent'))
    store.finish('run', 'succeeded', {
      stopReason: 'completed',
      output: [{ type: 'text', text: 'x'.repeat(MAX_EXTERNAL_RUN_RESULT_LENGTH + 20) }],
      diagnostic: 'SECRET STDERR',
    })
    await store.flush()
    const result = await store.list('parent')
    expect(result.runs).toHaveLength(1)
    expect(result.runs[0]).toMatchObject({ status: 'succeeded', resultTruncated: true })
    expect(result.runs[0]?.resultText).toHaveLength(MAX_EXTERNAL_RUN_RESULT_LENGTH)
    expect(JSON.stringify(result)).not.toContain('SECRET')
    await store.close()
    const restored = createExternalRunStore(() => facility)
    expect((await restored.list('parent')).runs[0]?.status).toBe('succeeded')
    expect((await restored.list('other-parent')).runs[0]).toMatchObject({
      status: 'failed',
      error: 'Host restarted; final result unavailable.',
    })
    await restored.close()
  })
  it.each(['failed', 'timeout', 'cancelled'] as const)('records %s without exception or log text', async status => {
    const store = createExternalRunStore(() => undefined)
    store.start(entry())
    store.finish('run', status, { stopReason: 'error', output: [], diagnostic: 'secret' })
    store.finish('run', 'succeeded')
    expect((await store.list('parent')).runs[0]?.status).toBe(status)
    expect(JSON.stringify(await store.list('parent'))).not.toContain('secret')
    await store.close()
  })
  it('bounds retention and expires old results', async () => {
    let now = Date.now()
    const store = createExternalRunStore(
      () => undefined,
      () => now,
    )
    for (let i = 0; i < MAX_EXTERNAL_RUNS + 10; i++) store.start(entry(`run-${i}`))
    expect((await store.list('parent')).runs).toHaveLength(MAX_EXTERNAL_RUNS)
    now += 8 * 24 * 60 * 60 * 1000
    expect((await store.list('parent')).runs).toEqual([])
    await store.close()
  })
  it('requires gateway owner identity and validates parent ids', async () => {
    const store = createExternalRunStore(() => undefined)
    store.start(entry())
    class Base {
      constructor(readonly ctx: unknown) {}
    }
    const typert = { TypertRemoteService: Base, Remote: () => () => {} } as TypertModule
    const Service = createRoleDisplayServiceClass(typert, {
      state: { ready: Promise.resolve(), readRoleById: () => undefined },
      externalRuns: store,
      isDisposed: () => false,
    })
    const signal = new AbortController().signal
    await expect(new Service({}).externalRuns('parent', signal)).rejects.toThrow('denied')
    await expect(
      new Service({ invocation: { peer: { principal: { kind: 'guest' } } } }).externalRuns('parent', signal),
    ).rejects.toThrow('denied')
    const owner = new Service({ invocation: { peer: { principal: { kind: 'owner' } } } })
    expect((await owner.externalRuns('parent', signal)).runs).toHaveLength(1)
    expect((await owner.externalRuns('other', signal)).runs).toEqual([])
    await expect(owner.externalRuns('../parent', signal)).rejects.toThrow('childIds')
    const cancel = new AbortController()
    cancel.abort()
    await expect(owner.externalRuns('parent', cancel.signal)).rejects.toThrow()
    await store.close()
  })
})
