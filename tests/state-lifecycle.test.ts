import { describe, expect, it, vi } from 'vitest'
import type { DomainPort } from '../src/host/ports.ts'
import { createRoleState } from '../src/host/state.ts'
import { fakeSession, fakeWorld, role, settingsOf } from './host-fakes.ts'

vi.mock('@deepseek-ai/dsh-storage-domain', () => import('./host-fakes.ts').then(m => m.storageDomainModule()))

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function storage() {
  const world = fakeWorld()
  const opened = deferred<DomainPort>()
  const writes: { table: string; key: string; value: unknown; gate: ReturnType<typeof deferred<void>> }[] = []
  const rows = new Map<string, Map<string, unknown>>()
  const close = vi.fn(async () => {})
  const domain: DomainPort = {
    table(name) {
      let table = rows.get(name)
      if (!table) {
        table = new Map()
        rows.set(name, table)
      }
      const data = table
      return {
        get: key => data.get(key),
        entries: () => data.entries(),
        put(key, value) {
          const gate = deferred()
          writes.push({ table: name, key, value, gate })
          return gate.promise.then(() => {
            data.set(key, value)
          })
        },
      }
    },
    close,
  }
  world.services.storageDomain = { open: () => opened.promise }
  return { world, domain, opened, writes, rows, close, state: createRoleState(world.ctx) }
}
const snapshot = settingsOf([role('worker')])

// One deterministic microtask turn is enough to admit writes/capture a flush after ready.
const turn = () => Promise.resolve()

describe('role state lifecycle', () => {
  it('reads historical rows without rewriting them and replays only pre-open writes', async () => {
    const t = storage()
    const old = { version: 1, settings: snapshot }
    t.rows.set(
      'snapshots',
      new Map([
        ['old', old],
        ['override', old],
      ]),
    )
    t.rows.set('roles', new Map([['old', { version: 1, role: role('historical') }]]))
    const replacement = settingsOf([role('replacement')])
    t.state.writeSnapshot(fakeSession('override'), replacement)
    t.state.writeRoleById('new', role('new'))
    t.opened.resolve(t.domain)
    await t.state.ready
    expect(t.state.readSnapshot(fakeSession('old'))?.roles.some(r => r.id === 'worker')).toBe(true)
    expect(t.state.readSnapshot(fakeSession('override'))?.roles.some(r => r.id === 'replacement')).toBe(true)
    expect(t.writes.map(w => [w.table, w.key])).toEqual([
      ['snapshots', 'override'],
      ['roles', 'new'],
    ])
    for (const write of t.writes) write.gate.resolve()
    await t.state.flush()
    expect(t.rows.get('snapshots')?.get('old')).toBe(old)
    await t.state.close()
  })

  it('makes every overlapping flush wait for the same admitted write', async () => {
    const t = storage()
    t.opened.resolve(t.domain)
    await t.state.ready
    t.state.writeSnapshot(fakeSession('s'), snapshot)
    const finished = vi.fn()
    const first = t.state.flush().then(finished)
    const second = t.state.flush().then(finished)
    await turn()
    await turn()
    expect(finished).not.toHaveBeenCalled()
    t.writes[0]!.gate.resolve()
    await Promise.all([first, second])
    expect(finished).toHaveBeenCalledTimes(2)
    await t.state.close()
  })

  it('reports a settled failure once, then permits a successful rollback flush', async () => {
    const t = storage()
    t.opened.resolve(t.domain)
    await t.state.ready
    t.state.writeSnapshot(fakeSession('s'), snapshot)
    await turn()
    t.writes[0]!.gate.reject(new Error('candidate failed'))
    await turn()
    await turn()
    await expect(t.state.flush()).rejects.toThrow('candidate failed')
    t.state.writeSnapshot(fakeSession('s'), settingsOf([role('rollback')]))
    const rollback = t.state.flush()
    await turn()
    t.writes[1]!.gate.resolve()
    await expect(rollback).resolves.toBeUndefined()
    await expect(t.state.flush()).resolves.toBeUndefined()
    await t.state.close()
  })

  it('never acknowledges a later failure while an unrelated flush is waiting', async () => {
    const t = storage()
    t.opened.resolve(t.domain)
    await t.state.ready
    t.state.writeSnapshot(fakeSession('first'), snapshot)
    const first = t.state.flush()
    await turn()
    t.state.writeSnapshot(fakeSession('later'), snapshot)
    await turn()
    t.writes[1]!.gate.reject(new Error('later failure'))
    await turn()
    t.writes[0]!.gate.resolve()
    await first
    await expect(t.state.flush()).rejects.toThrow('later failure')
    await expect(t.state.flush()).resolves.toBeUndefined()
    await t.state.close()
  })

  it('shares failures with overlapping consumers and waits for all captured writes before rejecting', async () => {
    const t = storage()
    t.opened.resolve(t.domain)
    await t.state.ready
    t.state.writeSnapshot(fakeSession('bad'), snapshot)
    t.state.writeSnapshot(fakeSession('slow'), snapshot)
    const settled = vi.fn()
    const first = t.state.flush().catch(error => {
      settled()
      return error
    })
    const second = t.state.flush().catch(error => {
      settled()
      return error
    })
    await turn()
    const failure = new Error('shared failure')
    t.writes[0]!.gate.reject(failure)
    await turn()
    await turn()
    expect(settled).not.toHaveBeenCalled()
    t.writes[1]!.gate.resolve()
    expect(await first).toBe(failure)
    expect(await second).toBe(failure)
    await expect(t.state.flush()).resolves.toBeUndefined()
    await t.state.close()
  })

  it('closes once, drains writes admitted before open, and refuses writes as soon as closing starts', async () => {
    const t = storage()
    const session = fakeSession('s')
    t.state.writeSnapshot(session, snapshot)
    const closing = t.state.close()
    expect(t.state.close()).toBe(closing)
    expect(() => t.state.writeRole(session, role('late'))).toThrow(/closed/)
    expect(() => t.state.writeRoleById('late-external', role('late'))).toThrow(/closed/)
    expect(t.state.readRoleById('late-external')).toBeUndefined()
    t.opened.resolve(t.domain)
    await t.state.ready
    expect(t.close).not.toHaveBeenCalled()
    expect(t.writes).toHaveLength(1)
    t.writes[0]!.gate.reject(new Error('write failed during close'))
    await closing
    expect(t.close).toHaveBeenCalledTimes(1)
    expect(() => t.state.writeSnapshot(session, settingsOf([]))).toThrow(/closed/)
    expect(t.state.readSnapshot(session)?.roles.some(r => r.id === 'worker')).toBe(true)
    expect(t.state.readRole(session)).toBeUndefined()
    expect(t.state.close()).toBe(closing)
    expect(t.writes).toHaveLength(1)
  })

  it('acknowledges synchronous backend write failures through flush too', async () => {
    const t = storage()
    t.domain.table = () => ({
      get: () => undefined,
      entries: () => [],
      put: () => {
        throw new Error('sync backend failure')
      },
    })
    t.opened.resolve(t.domain)
    await t.state.ready
    expect(() => t.state.writeSnapshot(fakeSession('s'), snapshot)).not.toThrow()
    await expect(t.state.flush()).rejects.toThrow('sync backend failure')
    await expect(t.state.flush()).resolves.toBeUndefined()
    await t.state.close()
  })
})
