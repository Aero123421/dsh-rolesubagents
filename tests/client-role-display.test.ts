import { describe, expect, it, vi } from 'vitest'
import { roleDisplayCaller } from '../src/client/role-display.ts'

const signal = () => new AbortController().signal

describe('role display RPC', () => {
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
