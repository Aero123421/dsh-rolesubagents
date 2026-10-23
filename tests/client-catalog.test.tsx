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
  expect(screen.getByRole('treeitem', { name: /^Worker · Continuable · Running/ }).querySelector('svg')).not.toBeNull()
  expect(screen.getByRole('treeitem', { name: 'Ordinary · One-shot · Inactive' }).querySelector('svg')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Expand Worker' }))
  expect(props.refreshProjection).toHaveBeenCalledWith('a')
  expect(screen.getByRole('treeitem', { name: 'Nested · Continuable · Inactive' }).getAttribute('aria-level')).toBe('2')
  await settle()
})
it('includes the session title and unknown mode in the accessible row name', async () => {
  const { props, state } = fixture()
  state.byId.a = { title: 'Restored child title' }
  state.projectionsBySession.root!.values.subagentCatalog![0] = { id: 'a', label: 'Worker', mode: 'unknown' }
  render(<CatalogAction {...props} />)
  fireEvent.click(screen.getByRole('button'))
  await settle()
  expect(
    screen.getByRole('treeitem', { name: /^Worker · Restored child title · Unknown mode · Running · worker/ }),
  ).toBeTruthy()
})

it('routes direct-parent open and sidebar actions, never external sessions', async () => {
  const { props } = await mount()
  fireEvent.click(screen.getByRole('treeitem', { name: 'External · External · External' }))
  expect(props.openChild).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Open Worker in sidebar' }))
  expect(props.openChildAside).toHaveBeenCalledWith({
    parentSessionId: 'root',
    childSessionId: 'a',
    mode: 'continuable',
  })
  expect(screen.queryByRole('tree')).toBeNull()
  fireEvent.click(screen.getByRole('button'))
  fireEvent.click(screen.getByRole('treeitem', { name: 'Ordinary · One-shot · Inactive' }))
  expect(props.openChild).toHaveBeenCalledWith({ parentSessionId: 'root', childSessionId: 'b', mode: 'one-shot' })
})
it('supports keyboard navigation, branch expansion, escape and outside dismissal', async () => {
  await mount()
  const row = screen.getByRole('treeitem', { name: /^Worker · Continuable · Running/ })
  row.focus()
  key(row, 'ArrowRight')
  expect(row.getAttribute('aria-expanded')).toBe('true')
  key(row, 'End')
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Ordinary · One-shot · Inactive')
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
  expect(screen.getByRole('treeitem', { name: 'Leaf · Continuable · Inactive' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Worker' }))
  fireEvent.click(screen.getByRole('button', { name: 'Expand Worker' }))
  expect(screen.queryByRole('treeitem', { name: 'Leaf · Continuable · Inactive' })).toBeNull()
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
  fireEvent.click(screen.getByRole('treeitem', { name: 'Ordinary · One-shot · Inactive' }))
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

it('aborts synchronously on reconnect, ignores old answers and clears closed-menu badges', async () => {
  const { props } = fixture()
  let reset = () => {}
  const unsubscribed = vi.fn()
  props.subscribeReset = listener => {
    reset = listener
    return unsubscribed
  }
  let release: (roles: Record<string, { roleId: string; displayName: string }>) => void = () => {}
  const getRoles = vi
    .fn<NonNullable<CatalogProps['getRoles']>>()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve
        }),
    )
    .mockResolvedValue({ a: { roleId: 'reviewer', displayName: 'reviewer' } })
  props.getRoles = getRoles
  render(<CatalogAction {...props} />)
  fireEvent.click(screen.getByRole('button'))
  const old = getRoles.mock.calls[0]?.[1]
  update(() => {
    reset()
    expect(old?.aborted).toBe(true)
  })
  await settle()
  release({ a: { roleId: 'worker', displayName: 'worker' } })
  await settle()
  expect(screen.getByRole('treeitem', { name: /^Worker/ }).textContent).toContain('reviewer')
  expect(screen.getByRole('treeitem', { name: /^Worker/ }).textContent).not.toContain('worker')
  key(screen.getByRole('tree'), 'Escape')
  expect(getRoles.mock.calls[1]?.[1].aborted).toBe(true)
  cleanup()
  expect(unsubscribed).toHaveBeenCalled()
  expect(screen.queryByRole('tree')).toBeNull()
})

it('cleans up queued keyboard focus and hover callbacks on unload', () => {
  vi.useFakeTimers()
  const { props } = fixture()
  props.getRoles = undefined
  render(<CatalogAction {...props} />)
  key(screen.getByRole('button'), 'ArrowDown')
  cleanup()
  expect(vi.getTimerCount()).toBe(0)
})

it('normalizes idle and retained migration projections and shows true migration rows', async () => {
  const { props, state } = fixture()
  state.projectionsBySession.a = { state: 'idle', values: {} }
  state.byId.b = { formatStatus: 'migration-required' }
  render(<CatalogAction {...props} />)
  fireEvent.click(screen.getByRole('button'))
  fireEvent.click(screen.getByRole('button', { name: 'Expand Worker' }))
  expect(screen.getByRole('status').textContent).toContain('Loading')
  expect(screen.getByRole('group').getAttribute('aria-busy')).toBe('true')
  expect(screen.getByRole('treeitem', { name: 'Ordinary · Migration required · Inactive' }).textContent).toContain(
    'Migration required',
  )
  expect(screen.queryByRole('button', { name: 'Expand Ordinary' })).toBeNull()
  await settle()
  cleanup()
  state.projectionsBySession.a = { state: 'migration-required', values: { subagentCatalog: [] } }
  render(<CatalogAction {...props} />)
  fireEvent.click(screen.getByRole('button'))
  expect(screen.queryByRole('button', { name: 'Expand Worker' })).toBeNull()
  await settle()
})

it('opens ancestor titles on click and sibling catalogs by keyboard without a descendant count', async () => {
  const { props } = fixture()
  const openTitle = vi.fn()
  render(
    <CatalogLineage
      {...props}
      lineageSessionId="a"
      displayTitle="Old title"
      openTitle={openTitle}
      useSession={select => select({})}
    />,
  )
  expect(screen.getAllByRole('button')).toHaveLength(1)
  expect(screen.getByRole('button').textContent).toContain('Worker')
  fireEvent.click(screen.getByRole('button'))
  expect(openTitle).toHaveBeenCalledTimes(1)
  key(screen.getByRole('button'), 'ArrowDown')
  await settle()
  expect(screen.getByRole('treeitem', { name: /^Worker/ }).getAttribute('aria-current')).toBe('true')
  expect(screen.queryByRole('button', { name: 'Open Worker in sidebar' })).toBeNull()
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
it.each([undefined, { kind: 'chain', scope: 'session' }, { kind: 'list', scope: 'root' }])(
  'leaves unsupported public slot contracts to builtins: %j',
  spec => {
    const register = vi.fn()
    const disposers: (() => unknown)[] = []
    mountCatalog({
      get: (name: string) =>
        (
          ({
            sessions: { refreshProjections() {} },
            uiWorkspace: { openSession() {} },
            sidebarRight: { openResource() {} },
          }) as Record<string, unknown>
        )[name],
      effect: (fn: () => () => unknown) => disposers.push(fn()),
      slots: { spec: () => spec, inject: (_: string, fn: () => unknown) => fn(), register },
    } as unknown as DshClientContext)
    expect(register).not.toHaveBeenCalled()
    for (const dispose of disposers) dispose()
  },
)

it('treats throwing optional service lookup as unavailable', () => {
  const inject = vi.fn()
  expect(() =>
    mountCatalog({
      get() {
        throw new Error('unloaded')
      },
      slots: { inject },
    } as unknown as DshClientContext),
  ).not.toThrow()
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
    slots: {
      inject: (_: string, fn: () => unknown) => fn(),
      register,
      spec: (key: string) => ({ kind: key.endsWith('actions') ? 'list' : 'single', scope: 'session' }),
    },
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
  expect(
    screen.getByRole('treeitem', { name: 'Worker · 継続可能 · 実行中 · worker · 1050 トークン · 42 秒稼働' }),
  ).toBeTruthy()
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
