// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { type ExternalRunsState, type GetExternalRuns, useExternalRuns } from '../src/client/external-runs.ts'
import type { ExternalRunDisplay, ExternalRunsResult } from '../src/shared/role-display.ts'
import { cleanup, render, update } from './client-dom.ts'

const run: ExternalRunDisplay = {
  id: 'run-a',
  parentSessionId: 'a',
  roleId: 'designer',
  cli: 'agy',
  label: 'Review',
  status: 'running',
  startedAt: '2026-10-25T12:00:00Z',
  resultTruncated: false,
}
const empty: ExternalRunsResult = { runs: [], durable: true }
function deferred() {
  let resolve!: (result: ExternalRunsResult) => void
  let reject!: (error: Error) => void
  const promise = new Promise<ExternalRunsResult>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function mount(parents: string[], get?: GetExternalRuns) {
  let state!: ExternalRunsState
  let scopes!: (ids: string[]) => void
  let reset!: () => void
  const dispose = vi.fn()
  const subscribe = (listener: () => void) => {
    reset = listener
    return dispose
  }
  function Harness() {
    const [ids, setIds] = useState(parents)
    scopes = setIds
    state = useExternalRuns(ids, get, subscribe)
    return null
  }
  render(<Harness />)
  return {
    state: () => state,
    scopes: (ids: string[]) => update(() => scopes(ids)),
    reset: () => update(reset),
    dispose,
  }
}
async function tick(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('preserves last-known records and timestamps offline, then restores certainty on recovery', async () => {
  vi.useFakeTimers()
  const get = vi.fn<GetExternalRuns>().mockResolvedValue({ runs: [run], durable: true })
  const view = mount(['a'], get)
  await tick()
  const fetchedAt = view.state().byParent.a!.fetchedAt
  expect(fetchedAt).not.toBeNull()
  expect(view.state().byParent.a).toMatchObject({ loading: false, error: false, stale: false })
  get.mockRejectedValue(new Error('private transport diagnostic'))
  await tick(5000)
  expect(view.state().byParent.a).toEqual({
    byId: { 'run-a': run },
    loading: false,
    error: true,
    stale: true,
    fetchedAt,
    durable: true,
  })
  expect(view.state().byId['run-a']).toEqual(run)
  expect(view.state().unavailable).toBe(true)
  expect(JSON.stringify(view.state())).not.toContain('private transport')
  get.mockResolvedValue(empty)
  await tick(5000)
  expect(view.state().byParent.a).toMatchObject({ byId: {}, error: false, stale: false, loading: false })
  expect(view.state().byParent.a!.fetchedAt).toBeGreaterThan(fetchedAt!)
  expect(view.state().unavailable).toBe(false)
})

it('publishes healthy scopes independently while another fails or remains pending', async () => {
  vi.useFakeTimers()
  const waiting = deferred()
  const get = vi.fn<GetExternalRuns>().mockImplementation(async id => {
    if (id === 'a') throw new Error('offline')
    if (id === 'c') return waiting.promise
    return { runs: [{ ...run, id: 'run-b', parentSessionId: 'b' }], durable: true }
  })
  const view = mount(['a', 'b', 'c'], get)
  await tick()
  expect(view.state().byParent.a).toMatchObject({ error: true, stale: false, fetchedAt: null, loading: false })
  expect(view.state().byParent.b).toMatchObject({ error: false, stale: false, loading: false })
  expect(view.state().byParent.c).toMatchObject({ loading: true, fetchedAt: null })
  expect(view.state().byId['run-b']?.parentSessionId).toBe('b')
  expect(view.state().unavailable).toBe(true)
  await act(async () => waiting.resolve(empty))
  expect(view.state().loading).toBe(false)
})

it('distinguishes initial loading, unavailable service, and successful missing records', async () => {
  vi.useFakeTimers()
  const response = deferred()
  const view = mount(['a'], () => response.promise)
  expect(view.state().byParent.a).toMatchObject({ loading: true, error: false, fetchedAt: null, byId: {} })
  await act(async () => response.resolve(empty))
  expect(view.state().byParent.a).toMatchObject({ loading: false, error: false, byId: {} })
  expect(view.state().byParent.a!.fetchedAt).not.toBeNull()
  const unavailable = mount(['a'])
  expect(unavailable.state().byParent.a).toMatchObject({ loading: false, error: true, fetchedAt: null })
  expect(unavailable.state().unavailable).toBe(true)
})

it('clears host records on reset and ignores late aborted answers without overlapping polls', async () => {
  vi.useFakeTimers()
  const old = deferred()
  const fresh = deferred()
  const get = vi
    .fn<GetExternalRuns>()
    .mockResolvedValueOnce({ runs: [run], durable: true })
    .mockReturnValueOnce(old.promise)
    .mockReturnValue(fresh.promise)
  const view = mount(['a'], get)
  await tick()
  expect(view.state().byId['run-a']).toEqual(run)
  await tick(15000)
  expect(get).toHaveBeenCalledTimes(2)
  const oldSignal = get.mock.calls[1]![1]
  view.reset()
  expect(oldSignal.aborted).toBe(true)
  expect(view.state().byId).toEqual({})
  expect(view.state().byParent.a!.fetchedAt).toBeNull()
  await act(async () => old.resolve({ runs: [run], durable: true }))
  expect(view.state().byId).toEqual({})
  await act(async () => fresh.resolve(empty))
  expect(view.state().byParent.a!.fetchedAt).not.toBeNull()
  cleanup()
  expect(get.mock.calls[2]![1].aborted).toBe(true)
  expect(view.dispose).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('aborts navigation and never allows old scopes to repopulate a different scope', async () => {
  vi.useFakeTimers()
  const old = deferred()
  const get = vi.fn<GetExternalRuns>().mockReturnValueOnce(old.promise).mockResolvedValue(empty)
  const view = mount(['a'], get)
  view.scopes(['b'])
  expect(get.mock.calls[0]![1].aborted).toBe(true)
  expect(view.state().byParent.a).toBeUndefined()
  expect(view.state().byParent.b).toMatchObject({ loading: true, fetchedAt: null })
  await act(async () => old.resolve({ runs: [run], durable: true }))
  expect(view.state().byId).toEqual({})
  expect(Object.keys(view.state().byParent)).toEqual(['b'])
  view.scopes([])
  expect(view.state()).toMatchObject({ byParent: {}, byId: {}, loading: false, unavailable: false, durable: false })
  expect(vi.getTimerCount()).toBe(0)
})

it('retains overlapping root records across expansion and collapse without publishing removed scopes', async () => {
  vi.useFakeTimers()
  const rootRefresh = deferred()
  const nested = deferred()
  const collapseRefresh = deferred()
  const get = vi
    .fn<GetExternalRuns>()
    .mockResolvedValueOnce({ runs: [run], durable: true })
    .mockReturnValueOnce(rootRefresh.promise)
    .mockReturnValueOnce(nested.promise)
    .mockReturnValue(collapseRefresh.promise)
  const view = mount(['a'], get)
  await tick()
  const fetchedAt = view.state().byParent.a!.fetchedAt
  view.scopes(['a', 'b'])
  expect(get.mock.calls[0]![1].aborted).toBe(true)
  expect(view.state().byParent.a).toMatchObject({
    byId: { 'run-a': run },
    fetchedAt,
    error: false,
    stale: false,
  })
  expect(view.state().byParent.b).toMatchObject({ loading: true, fetchedAt: null })
  await act(async () => rootRefresh.reject(new Error('offline')))
  expect(view.state().byParent.a).toMatchObject({
    byId: { 'run-a': run },
    fetchedAt,
    error: true,
    stale: true,
  })
  view.scopes(['a'])
  expect(get.mock.calls[2]![1].aborted).toBe(true)
  expect(view.state().byParent.b).toBeUndefined()
  expect(view.state().byParent.a).toMatchObject({ byId: { 'run-a': run }, fetchedAt, stale: true })
  await act(async () => nested.resolve({ runs: [{ ...run, id: 'run-b', parentSessionId: 'b' }], durable: true }))
  expect(Object.keys(view.state().byParent)).toEqual(['a'])
  expect(view.state().byId['run-b']).toBeUndefined()
  await act(async () => collapseRefresh.reject(new Error('still offline')))
  expect(view.state().byParent.a).toMatchObject({ byId: { 'run-a': run }, fetchedAt, stale: true })
})

it('never retains overlapping scope records across a fetch source change', async () => {
  vi.useFakeTimers()
  const first = vi.fn<GetExternalRuns>().mockResolvedValue({ runs: [run], durable: true })
  const next = deferred()
  const second = vi.fn<GetExternalRuns>().mockReturnValue(next.promise)
  let changeSource!: () => void
  let state!: ExternalRunsState
  function Harness() {
    const [changed, setChanged] = useState(false)
    changeSource = () => setChanged(true)
    state = useExternalRuns(['a'], changed ? second : first)
    return null
  }
  render(<Harness />)
  await tick()
  expect(state.byId['run-a']).toEqual(run)
  update(changeSource)
  expect(first.mock.calls[0]![1].aborted).toBe(true)
  expect(state.byParent.a).toMatchObject({ byId: {}, loading: true, fetchedAt: null })
  await act(async () => next.reject(new Error('offline')))
  expect(state.byParent.a).toMatchObject({ byId: {}, error: true, stale: false, fetchedAt: null })
})

it('deduplicates scopes, bounds concurrency and total scopes, and stops queued work on abort', async () => {
  vi.useFakeTimers()
  const pending: ReturnType<typeof deferred>[] = []
  let active = 0
  let peak = 0
  const get = vi.fn<GetExternalRuns>().mockImplementation(() => {
    const response = deferred()
    pending.push(response)
    active++
    peak = Math.max(peak, active)
    return response.promise.finally(() => {
      active--
    })
  })
  const ids = Array.from({ length: 110 }, (_, i) => `parent-${String(i).padStart(3, '0')}`)
  const view = mount([...ids, ...ids], get)
  expect(Object.keys(view.state().byParent)).toHaveLength(100)
  expect(view.state().byParent['parent-100']).toBeUndefined()
  expect(get).toHaveBeenCalledTimes(4)
  await tick(15000)
  expect(get).toHaveBeenCalledTimes(4)
  await act(async () => pending[0]!.resolve(empty))
  expect(get).toHaveBeenCalledTimes(5)
  expect(peak).toBe(4)
  cleanup()
  await act(async () => {
    for (const response of pending) response.resolve(empty)
  })
  expect(get).toHaveBeenCalledTimes(5)
  expect(get.mock.calls.every(([, signal]) => signal.aborted)).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
