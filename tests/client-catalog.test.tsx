// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { CatalogAction, CatalogLineage } from '../src/client/catalog.tsx'
import { mountCatalog } from '../src/client/catalog-mount.ts'
import type { CatalogProps, CatalogState } from '../src/client/catalog-types.ts'
import type { DshClientContext } from '../src/client/dsh.ts'
import { cleanup, fireEvent, render, screen, settle, update } from './client-dom.ts'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
function fixture() {
  const state: CatalogState = {
    byId: {},
    projectionsBySession: {
      root: {
        state: 'ready',
        values: {
          subagentCatalog: [
            { id: 'a', label: 'Worker', mode: 'continuable' },
            { id: 'b', label: 'Ordinary', mode: 'one-shot' },
            { id: 'x', label: 'External', mode: 'external' },
          ],
        },
      },
      a: { state: 'ready', values: { subagentCatalog: [{ id: 'nested', label: 'Nested', mode: 'continuable' }] } },
    },
  }
  const props: CatalogProps = {
    sessionId: 'root',
    useSessions: select => select(state),
    useSessionStatus: select => select(new Map([['a', { running: true }]])),
    openChild: vi.fn(),
    openChildAside: vi.fn(),
    refreshProjection: vi.fn(),
    getRoles: vi.fn(async () => ({ a: { roleId: 'worker', displayName: 'worker' } })),
  }
  return { state, props }
}
function key(element: HTMLElement, value: string) {
  update(() => element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })))
}
async function mount() {
  const f = fixture()
  render(<CatalogAction {...f.props} />)
  fireEvent.click(screen.getByRole('button'))
  await settle()
  return f
}
it('renders badges only for known metadata, status, and nested trees', async () => {
  const { props } = await mount()
  expect(screen.getByRole('treeitem', { name: /^Worker · Running/ }).querySelector('svg')).not.toBeNull()
  expect(screen.getByRole('treeitem', { name: 'Ordinary · Inactive' }).querySelector('svg')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Expand Worker' }))
  expect(props.refreshProjection).toHaveBeenCalledWith('a')
  expect(screen.getByRole('treeitem', { name: 'Nested · Inactive' }).getAttribute('aria-level')).toBe('2')
  await settle()
})
it('routes direct-parent open and sidebar actions, never external sessions', async () => {
  const { props } = await mount()
  fireEvent.click(screen.getByRole('treeitem', { name: 'External · External' }))
  expect(props.openChild).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Open Worker in sidebar' }))
  expect(props.openChildAside).toHaveBeenCalledWith({
    parentSessionId: 'root',
    childSessionId: 'a',
    mode: 'continuable',
  })
  expect(screen.queryByRole('tree')).toBeNull()
  fireEvent.click(screen.getByRole('button'))
  fireEvent.click(screen.getByRole('treeitem', { name: 'Ordinary · Inactive' }))
  expect(props.openChild).toHaveBeenCalledWith({ parentSessionId: 'root', childSessionId: 'b', mode: 'one-shot' })
})
it('supports keyboard navigation, branch expansion, escape and outside dismissal', async () => {
  await mount()
  const row = screen.getByRole('treeitem', { name: /^Worker · Running/ })
  row.focus()
  key(row, 'ArrowRight')
  expect(row.getAttribute('aria-expanded')).toBe('true')
  key(row, 'End')
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Ordinary · Inactive')
  key(document.activeElement as HTMLElement, 'Escape')
  expect(screen.queryByRole('tree')).toBeNull()
  expect(document.activeElement).toBe(screen.getByRole('button'))
  fireEvent.click(screen.getByRole('button'))
  update(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  expect(screen.queryByRole('tree')).toBeNull()
})
it('clears descendant expansion when collapsing a parent', async () => {
  const { state, props } = fixture()
  state.projectionsBySession.nested = {
    state: 'ready',
    values: { subagentCatalog: [{ id: 'leaf', label: 'Leaf', mode: 'continuable' }] },
  }
  render(<CatalogAction {...props} />)
  fireEvent.click(screen.getByRole('button'))
  fireEvent.click(screen.getByRole('button', { name: 'Expand Worker' }))
  fireEvent.click(screen.getByRole('button', { name: 'Expand Nested' }))
  expect(screen.getByRole('treeitem', { name: 'Leaf · Inactive' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Worker' }))
  fireEvent.click(screen.getByRole('button', { name: 'Expand Worker' }))
  expect(screen.queryByRole('treeitem', { name: 'Leaf · Inactive' })).toBeNull()
  expect(screen.getByRole('button', { name: 'Expand Nested' })).toBeTruthy()
  await settle()
})

it('keeps navigation available through loading and retry states', async () => {
  const { state, props } = fixture()
  state.projectionsBySession.a = { state: 'error', error: { message: 'Load failed' }, values: {} }
  render(<CatalogAction {...props} />)
  fireEvent.click(screen.getByRole('button'))
  fireEvent.click(screen.getByRole('button', { name: 'Expand Worker' }))
  expect(screen.getByRole('alert').textContent).toContain('Load failed')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(props.refreshProjection).toHaveBeenCalledWith('a')
  fireEvent.click(screen.getByRole('treeitem', { name: 'Ordinary · Inactive' }))
  expect(props.openChild).toHaveBeenCalledWith({ parentSessionId: 'root', childSessionId: 'b', mode: 'one-shot' })
  await settle()
})

it('does not overlap role RPCs and aborts in-flight work on unmount', async () => {
  vi.useFakeTimers()
  const { props } = fixture()
  const getRoles = vi.fn<NonNullable<CatalogProps['getRoles']>>(() => new Promise(() => {}))
  props.getRoles = getRoles
  render(<CatalogAction {...props} />)
  fireEvent.click(screen.getByRole('button'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000)
  })
  expect(getRoles).toHaveBeenCalledTimes(1)
  const signal = getRoles.mock.calls[0]?.[1]
  cleanup()
  expect(signal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})

it('uses lineage address and omits the root action on children', () => {
  const { props, state } = fixture()
  state.byId.a = { origin: 'subagent', parentId: 'root' }
  render(
    <>
      <CatalogAction {...props} sessionId="a" />
      <CatalogLineage
        {...props}
        sessionId="a"
        lineageSessionId="a"
        displayTitle="Worker"
        useSession={select =>
          select({ subagent: { address: { childSessionId: 'a', parentSessionId: 'root', mode: 'continuable' } } })
        }
      />
    </>,
  )
  expect(screen.getAllByRole('button')).toHaveLength(2)
})
it('does not claim slots without optional navigation services', () => {
  const inject = vi.fn()
  mountCatalog({ get: () => undefined, slots: { inject } } as unknown as DshClientContext)
  expect(inject).not.toHaveBeenCalled()
})
it('registers both overrides at priority -10 with lifecycle-owned styles', () => {
  const register = vi.fn(() => () => {})
  const dispose: (() => unknown)[] = []
  const services = {
    sessions: { refreshProjections: vi.fn() },
    uiWorkspace: { openSession: vi.fn() },
    sidebarRight: { openResource: vi.fn() },
  }
  mountCatalog({
    get: (name: keyof typeof services) => services[name],
    on: () => () => {},
    effect: (fn: () => () => unknown) => dispose.push(fn()),
    slots: { inject: (_: string, fn: () => unknown) => fn(), register },
  } as unknown as DshClientContext)
  expect(register.mock.calls).toHaveLength(2)
  expect(register).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'subagent-catalog', priority: -10 }),
    CatalogAction,
  )
  for (const fn of dispose) fn()
})

it('localizes Japanese labels and exposes role, usage and duration to assistive technology', async () => {
  const { props, state } = fixture()
  props.getLocale = () => 'ja'
  state.byId.a = {
    projectionValues: {
      tokenUsage: { uncachedInputTokens: 1000, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 },
      subagentTiming: { settledMs: 42000 },
    },
  }
  render(<CatalogAction {...props} />)
  expect(screen.getByRole('button').textContent).toContain('サブエージェント 3件')
  fireEvent.click(screen.getByRole('button'))
  await settle()
  expect(screen.getByRole('treeitem', { name: 'Worker · 実行中 · worker · 1050 トークン · 42 秒稼働' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Workerをサイドバーで開く' })).toBeTruthy()
})
it('aborts stale metadata on reset and allows metadata absent at first to appear later', async () => {
  vi.useFakeTimers()
  const { props } = fixture()
  let reset = () => {}
  props.subscribeReset = listener => {
    reset = listener
    return () => {}
  }
  const getRoles = vi
    .fn<NonNullable<CatalogProps['getRoles']>>()
    .mockResolvedValueOnce({})
    .mockResolvedValue({ a: { roleId: 'worker', displayName: 'worker' } })
  props.getRoles = getRoles
  render(<CatalogAction {...props} />)
  fireEvent.click(screen.getByRole('button'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(screen.getByRole('treeitem', { name: /^Worker/ }).querySelector('svg')).toBeNull()
  update(() => vi.advanceTimersByTime(5000))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(screen.getByRole('treeitem', { name: /^Worker/ }).querySelector('svg')).not.toBeNull()
  const signal = getRoles.mock.calls[0]?.[1]
  update(reset)
  expect(signal?.aborted).toBe(true)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(getRoles).toHaveBeenCalledTimes(3)
})
it('opens by hover, closes unpinned on leave, and click pins an already open menu', async () => {
  vi.useFakeTimers()
  const { props } = fixture()
  render(<CatalogAction {...props} />)
  const trigger = screen.getByRole('button')
  update(() => trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  update(() => vi.advanceTimersByTime(150))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(screen.getByRole('tree')).toBeTruthy()
  update(() => trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
  update(() => vi.advanceTimersByTime(150))
  expect(screen.queryByRole('tree')).toBeNull()
  update(() => trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  update(() => vi.advanceTimersByTime(150))
  fireEvent.click(trigger)
  update(() => trigger.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150)
  })
  expect(screen.getByRole('tree')).toBeTruthy()
})
