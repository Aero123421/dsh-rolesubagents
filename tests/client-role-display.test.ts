import { describe, expect, it, vi } from 'vitest'
import { roleDisplayCaller, ROLE_DISPLAY_ENDPOINT, ROLE_DISPLAY_TIMEOUT_MS } from '../src/client/role-display.ts'
import type { ConnectionLike } from '../src/client/dsh.ts'

const signal = () => new AbortController().signal

describe('role display RPC', () => {
  it('bounds a hung query and aborts the transport, without per-row timers', async () => {
    vi.useFakeTimers()
    try {
      const call = vi.fn<ConnectionLike['rpc']['call']>(() => new Promise(() => {}))
      const pending = roleDisplayCaller({ get: () => ({ rpc: { call } }) })(['a', 'b'], signal())
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(ROLE_DISPLAY_TIMEOUT_MS)
      expect(await pending).toEqual({})
      expect(call.mock.calls[0]?.[3]?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('settles abort even when the transport ignores it, and never starts another batch', async () => {
    const abort = new AbortController()
    const call = vi.fn<ConnectionLike['rpc']['call']>(() => new Promise(() => {}))
    const pending = roleDisplayCaller({ get: () => ({ rpc: { call } }) })(
      Array.from({ length: 201 }, (_, n) => `${n}`),
      abort.signal,
    )
    await Promise.resolve()
    abort.abort()
    expect(await pending).toEqual({})
    expect(call).toHaveBeenCalledTimes(1)
    expect(call.mock.calls[0]?.[3]?.aborted).toBe(true)
  })

  it('maps each recorded role to its child across three batches without consulting settings', async () => {
    const call = vi.fn<ConnectionLike['rpc']['call']>(async (_channel, _endpoint, payload) => ({
      ok: true,
      value: (payload as { args: { childIds: string[] } }).args.childIds.map(id => ({
        roleId: `role-${id}`,
        displayName: 'current-setting',
      })),
    }))
    const get = vi.fn(() => ({ rpc: { call } }))
    const ids = Array.from({ length: 205 }, (_, n) => `child-${n}`)
    const roles = await roleDisplayCaller({ get })(ids, signal())
    expect(call.mock.calls.map(args => (args[2] as { args: { childIds: string[] } }).args.childIds.length)).toEqual([
      100, 100, 5,
    ])
    expect(call.mock.calls.every(args => args[0] === '/api' && args[1] === ROLE_DISPLAY_ENDPOINT)).toBe(true)
    for (const id of ids) expect(roles[id]).toEqual({ roleId: `role-${id}`, displayName: `role-${id}` })
    expect(get).toHaveBeenCalledExactlyOnceWith('connection')
  })

  it('degrades without connection service', async () => {
    expect(await roleDisplayCaller({})(['child'], signal())).toEqual({})
  })

  it('batches and deduplicates ids, keeping only validated role metadata', async () => {
    const call = vi.fn(async (_channel, _endpoint, payload) => ({
      ok: true,
      value: payload.args.childIds.map(() => ({ roleId: 'explorer', displayName: 'wrong', instructions: 'private' })),
    }))
    const ids = Array.from({ length: 101 }, (_, index) => `child-${index}`)
    const result = await roleDisplayCaller({ get: () => ({ rpc: { call } }) })([...ids, ids[0]!], signal())
    expect(call).toHaveBeenCalledTimes(2)
    expect(call.mock.calls[0]?.[2].args.childIds).toHaveLength(100)
    expect(Object.keys(result)).toHaveLength(101)
    expect(result['child-0']).toEqual({ roleId: 'explorer', displayName: 'explorer' })
  })

  it('ignores absent or malformed role records', async () => {
    const call = vi.fn(async () => ({ ok: true, value: [null, { roleId: '<svg>' }, { roleId: 'custom-role' }] }))
    expect(await roleDisplayCaller({ get: () => ({ rpc: { call } }) })(['a', 'b', 'c'], signal())).toEqual({
      c: { roleId: 'custom-role', displayName: 'custom-role' },
    })
  })

  it('ignores responses with wrong lengths rather than mismatching child roles', async () => {
    const call = vi.fn(async () => ({ ok: true, value: [{ roleId: 'worker' }] }))
    expect(await roleDisplayCaller({ get: () => ({ rpc: { call } }) })(['a', 'b'], signal())).toEqual({})
  })

  it('handles transport failures without hiding the catalog', async () => {
    const call = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await roleDisplayCaller({ get: () => ({ rpc: { call } }) })(['a'], signal())).toEqual({})
  })

  it('discards results when an obsolete request was aborted', async () => {
    const controller = new AbortController()
    const call = vi.fn(async () => {
      controller.abort()
      return { ok: true, value: [{ roleId: 'worker' }] }
    })
    expect(await roleDisplayCaller({ get: () => ({ rpc: { call } }) })(['a'], controller.signal)).toEqual({})
  })
})
