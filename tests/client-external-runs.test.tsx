// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { CatalogAction } from '../src/client/catalog.tsx'
import type { CatalogProps } from '../src/client/catalog-types.ts'
import { externalRunsCaller, EXTERNAL_RUNS_ENDPOINT, useExternalRuns } from '../src/client/external-runs.ts'
import type { DshClientContext } from '../src/client/dsh.ts'
import type { ExternalRunDisplay, ExternalRunsResult } from '../src/shared/role-display.ts'
import { cleanup, fireEvent, render, screen, settle, update } from './client-dom.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
const run: ExternalRunDisplay = {
  id: 'external-1',
  parentSessionId: 'parent',
  roleId: 'designer',
  cli: 'agy',
  label: 'Design review',
  status: 'running',
  startedAt: '2026-10-25T12:00:00.000Z',
  resultTruncated: false,
}
function fixture() {
  const getExternalRuns = vi.fn(async (): Promise<ExternalRunsResult> => ({ runs: [{ ...run }], durable: true }))
  const props: CatalogProps = {
    sessionId: 'parent',
    useSessions: select =>
      select({
        byId: {},
        projectionsBySession: {
          parent: {
            state: 'ready',
            values: { subagentCatalog: [{ id: run.id, label: run.label, mode: 'external' }] },
          },
        },
      }),
    useSessionStatus: select => select(new Map()),
    getExternalRuns,
    openChild: vi.fn(),
    openChildAside: vi.fn(),
    refreshProjection: vi.fn(),
  }
  return { props, getExternalRuns }
}
it('shows live external status while closed and opens accessible result details without navigating', async () => {
  const { props, getExternalRuns } = fixture()
  getExternalRuns.mockResolvedValue({
    runs: [
      { ...run, status: 'succeeded', endedAt: '2026-10-25T12:00:12.000Z', resultText: '<script>not HTML</script>' },
    ],
    durable: true,
  })
  render(<CatalogAction {...props} />)
  await settle()
  fireEvent.click(screen.getByRole('button'))
  fireEvent.click(screen.getByRole('button', { name: /Completed \/ history/ }))
  const row = screen.getByRole('button', { name: /Design review.*Completed.*View result/ })
  expect(row.getAttribute('aria-disabled')).toBeNull()
  expect(row.textContent).toContain('designer')
  fireEvent.click(row)
  expect(props.openChild).not.toHaveBeenCalled()
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('<script>not HTML</script>')
  expect(dialog.querySelector('script')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close result details' }))
  update(() => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button'))
})
it('polls running to timeout and keeps a stale result explicit on transport failure', async () => {
  vi.useFakeTimers()
  const { props, getExternalRuns } = fixture()
  render(<CatalogAction {...props} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(screen.getByRole('button').getAttribute('aria-label')).toContain('Running 1')
  getExternalRuns.mockResolvedValue({
    runs: [{ ...run, status: 'timeout', error: 'Execution timed out.', endedAt: '2026-10-25T12:01:00Z' }],
    durable: true,
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(screen.getByRole('button').getAttribute('aria-label')).toContain('Attention 1')
  fireEvent.click(screen.getByRole('button'))
  fireEvent.click(screen.getByRole('button', { name: /Design review.*Timed out/ }))
  expect(screen.getByRole('dialog').textContent).toContain('Execution timed out.')
  getExternalRuns.mockRejectedValue(new Error('offline'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(screen.getByRole('dialog').textContent).toContain('Last known status')
  expect(screen.getByRole('dialog').textContent).toContain('could not be refreshed')
})
it('does not assert a stale running record is still executing', async () => {
  vi.useFakeTimers()
  const { props, getExternalRuns } = fixture()
  render(<CatalogAction {...props} />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  fireEvent.click(screen.getByRole('button'))
  fireEvent.click(screen.getByRole('button', { name: /Design review.*Running/ }))
  expect(screen.getByRole('dialog').textContent).toContain('Running in the background')
  getExternalRuns.mockRejectedValue(new Error('offline'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(screen.getByRole('dialog').textContent).toContain('Last known status')
  expect(screen.getByRole('dialog').textContent).not.toContain('Running in the background')
})
it('reports missing historical records instead of claiming success', async () => {
  const { props, getExternalRuns } = fixture()
  getExternalRuns.mockResolvedValue({ runs: [], durable: true })
  render(<CatalogAction {...props} />)
  await settle()
  fireEvent.click(screen.getByRole('button'))
  fireEvent.click(screen.getByRole('button', { name: /Design review.*Record unavailable/ }))
  expect(screen.getByRole('dialog').textContent).toContain('No retained record')
})
it('cancels polls on reset and rejects previous Host answers', async () => {
  vi.useFakeTimers()
  let reset = () => {}
  let release: (value: ExternalRunsResult) => void = () => {}
  const get = vi
    .fn<NonNullable<CatalogProps['getExternalRuns']>>()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve
        }),
    )
    .mockResolvedValue({ runs: [], durable: false })
  const subscribe = (listener: () => void) => {
    reset = listener
    return () => {}
  }
  function Harness() {
    const state = useExternalRuns(['parent'], get, subscribe)
    return <p>{Object.keys(state.byId).join(',')}</p>
  }
  const view = render(<Harness />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000)
  })
  expect(get).toHaveBeenCalledTimes(1)
  const oldSignal = get.mock.calls[0]![1]
  update(reset)
  expect(oldSignal.aborted).toBe(true)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  release({ runs: [run], durable: true })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(view.container.textContent).not.toContain(run.id)
  cleanup()
  expect(get.mock.calls[1]![1].aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
it('calls the scoped endpoint and validates run ownership and bounded output', async () => {
  const call = vi.fn().mockResolvedValue({ ok: true, value: { runs: [run], durable: true } })
  const get = externalRunsCaller({ get: () => ({ rpc: { call } }) } as unknown as DshClientContext)
  const signal = new AbortController().signal
  await expect(get('parent', signal)).resolves.toEqual({ runs: [run], durable: true })
  expect(call).toHaveBeenCalledWith(
    '/api',
    EXTERNAL_RUNS_ENDPOINT,
    { args: { parentSessionId: 'parent' } },
    expect.any(AbortSignal),
  )
  call.mockResolvedValue({ ok: true, value: { runs: [{ ...run, parentSessionId: 'other' }], durable: true } })
  await expect(get('parent', signal)).rejects.toThrow('unavailable')
  call.mockResolvedValue({ ok: true, value: { runs: [{ ...run, resultText: 'x'.repeat(16385) }], durable: true } })
  await expect(get('parent', signal)).rejects.toThrow('unavailable')
  call.mockResolvedValue({ ok: false })
  await expect(get('parent', signal)).rejects.toThrow('unavailable')
})
it('times out and aborts broken RPC transports', async () => {
  vi.useFakeTimers()
  const call = vi.fn(() => new Promise(() => {}))
  const get = externalRunsCaller({ get: () => ({ rpc: { call } }) } as unknown as DshClientContext)
  const response = expect(get('parent', new AbortController().signal)).rejects.toThrow('unavailable')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  await response
  expect((call.mock.calls[0] as unknown as [string, string, unknown, AbortSignal])[3].aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
