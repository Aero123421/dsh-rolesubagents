// @vitest-environment happy-dom
import { act, useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { CatalogAction, CatalogLineage } from '../src/client/catalog.tsx'
import { mountCatalog } from '../src/client/catalog-mount.ts'
import { nativeActivity, externalActivity } from '../src/client/catalog-state.ts'
import type { CatalogProps, CatalogState } from '../src/client/catalog-types.ts'
import type { DshClientContext } from '../src/client/dsh.ts'
import type { ExternalRunDisplay } from '../src/shared/role-display.ts'
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
const trigger = () => document.querySelector<HTMLButtonElement>('.dshrs-catalog-trigger')!
const row = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name} ·`) })
function key(element: HTMLElement, value: string) {
  update(() => element.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true })))
}
async function mount() {
  const f = fixture()
  render(<CatalogAction {...f.props} />)
  fireEvent.click(trigger())
  await settle()
  return f
}

it('uses a nonmodal dialog, semantic lists, sibling actions and only known role badges', async () => {
  const { props } = await mount()
  expect(screen.getByRole('dialog').getAttribute('aria-modal')).toBeNull()
  expect(screen.queryByRole('tree')).toBeNull()
  expect(row('Worker').querySelector('.dshrs-catalog-role')?.textContent).toBe('worker')
  expect(row('Ordinary').querySelector('.dshrs-catalog-role')?.textContent).toBe('')
  expect(screen.getByRole('dialog').textContent).not.toMatch(/tokens|Continuable|DSH standard|Inactive/)
  expect(document.querySelector('button button')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Expand Worker' }))
  expect(props.refreshProjection).toHaveBeenCalledWith('a')
  expect(row('Nested')).toBeTruthy()
  expect(document.querySelectorAll('ul.dshrs-catalog-list').length).toBeGreaterThan(1)
  await settle()
})
it('never opens on hover; toggles click, focuses on open, Escape restores trigger, outside closes', async () => {
  vi.useFakeTimers()
  const { props } = fixture()
  render(<CatalogAction {...props} />)
  update(() => trigger().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(250)
  })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(trigger())
  expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  fireEvent.click(trigger())
  expect(screen.queryByRole('dialog')).toBeNull()
  key(trigger(), 'ArrowDown')
  expect(screen.getByRole('dialog')).toBeTruthy()
  key(document.activeElement as HTMLElement, 'End')
  expect(document.activeElement).toBe(Array.from(screen.getByRole('dialog').querySelectorAll('button')).at(-1))
  key(document.activeElement as HTMLElement, 'Home')
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close subagents' }))
  key(document.activeElement as HTMLElement, 'Escape')
  expect(document.activeElement).toBe(trigger())
  fireEvent.click(trigger())
  update(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })))
  expect(screen.queryByRole('dialog')).toBeNull()
})
it('recovers removed live-row focus to history without stealing focus from parent chat', async () => {
  const { props, state } = fixture()
  let running = true
  let refresh = () => {}
  props.useSessionStatus = select => select(new Map([['a', { running }]]))
  function Harness() {
    const [, setRevision] = useState(0)
    refresh = () => setRevision(n => n + 1)
    return (
      <>
        <input aria-label="Parent chat" />
        <CatalogAction {...props} />
      </>
    )
  }
  render(<Harness />)
  fireEvent.click(trigger())
  await settle()
  row('Worker').focus()
  state.byId.a = { projectionValues: { subagentTiming: { settledMs: 42, lastTurnCompleted: true } } }
  running = false
  update(refresh)
  expect(document.activeElement).toBe(screen.getByRole('button', { name: /Completed \/ history/ }))
  running = true
  update(refresh)
  row('Worker').focus()
  const chat = screen.getByLabelText('Parent chat')
  chat.focus()
  running = false
  update(refresh)
  expect(document.activeElement).toBe(chat)
  await settle()
})

it('truthfully distinguishes stopped, unknown, missing, loading and stale states', () => {
  expect(nativeActivity(undefined, undefined)).toBe('unknown')
  expect(nativeActivity({ running: false }, false)).toBe('unknown')
  expect(
    nativeActivity({ projectionValues: { subagentTiming: { settledMs: 1, lastTurnCompleted: false } } }, false),
  ).toBe('stopped')
  expect(
    nativeActivity({ projectionValues: { subagentTiming: { settledMs: 1, lastTurnCompleted: true } } }, false),
  ).toBe('completed')
  const scope = { loading: false, error: false, stale: false, fetchedAt: 42 }
  expect(externalActivity(undefined, undefined)).toBe('loading')
  expect(externalActivity(undefined, { ...scope, fetchedAt: null })).toBe('loading')
  expect(externalActivity(undefined, scope)).toBe('missing')
  expect(externalActivity(undefined, { ...scope, error: true, fetchedAt: null })).toBe('unavailable')
  expect(externalActivity({ status: 'running' } as ExternalRunDisplay, { ...scope, stale: true, error: true })).toBe(
    'stale',
  )
})
it('puts current/attention first and keeps completed history collapsed, reverse catalog order', async () => {
  const { props, state } = fixture()
  props.useSessionStatus = select => select(new Map())
  state.byId.a = { running: false, projectionValues: { subagentTiming: { settledMs: 42, lastTurnCompleted: true } } }
  state.byId.b = { running: false, projectionValues: { subagentTiming: { settledMs: 12, lastTurnCompleted: true } } }
  render(<CatalogAction {...props} />)
  fireEvent.click(trigger())
  await settle()
  expect(screen.queryByRole('button', { name: /^Worker ·/ })).toBeNull()
  expect(trigger().textContent).not.toContain('Completed')
  fireEvent.click(screen.getByRole('button', { name: /Completed \/ history/ }))
  expect(Array.from(document.querySelectorAll('[data-catalog-main]')).map(e => e.textContent)).toEqual([
    expect.stringContaining('External'),
    expect.stringContaining('Ordinary'),
    expect.stringContaining('Worker'),
  ])
})
it('routes direct-parent chat and aside actions, and external results never navigate as sessions', async () => {
  const { props } = await mount()
  fireEvent.click(row('External'))
  expect(props.openChild).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog').textContent).toContain('could not be refreshed')
  fireEvent.click(screen.getByRole('button', { name: 'Close result details' }))
  fireEvent.click(trigger())
  fireEvent.click(screen.getByRole('button', { name: 'Open Worker in sidebar' }))
  expect(props.openChildAside).toHaveBeenCalledWith({
    parentSessionId: 'root',
    childSessionId: 'a',
    mode: 'continuable',
  })
  fireEvent.click(trigger())
  fireEvent.click(row('Ordinary'))
  expect(props.openChild).toHaveBeenCalledWith({ parentSessionId: 'root', childSessionId: 'b', mode: 'one-shot' })
})
it('clears descendant expansion on collapse and keeps retry/navigation available', async () => {
  const { props, state } = fixture()
  state.projectionsBySession.nested = {
    state: 'ready',
    values: { subagentCatalog: [{ id: 'leaf', label: 'Leaf', mode: 'continuable' }] },
  }
  render(<CatalogAction {...props} />)
  fireEvent.click(trigger())
  fireEvent.click(screen.getByRole('button', { name: 'Expand Worker' }))
  fireEvent.click(screen.getByRole('button', { name: 'Expand Nested' }))
  expect(row('Leaf')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Collapse Worker' }))
  fireEvent.click(screen.getByRole('button', { name: 'Expand Worker' }))
  expect(screen.queryByRole('button', { name: /^Leaf ·/ })).toBeNull()
  await settle()
  cleanup()
  state.projectionsBySession.a = { state: 'error', error: { message: 'Load failed' }, values: {} }
  render(<CatalogAction {...props} />)
  fireEvent.click(trigger())
  fireEvent.click(screen.getByRole('button', { name: 'Expand Worker' }))
  expect(screen.getByRole('alert').textContent).toContain('Load failed')
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(props.refreshProjection).toHaveBeenCalledWith('a')
  fireEvent.click(row('Ordinary'))
  expect(props.openChild).toHaveBeenCalled()
  await settle()
})
it('retains role metadata over close/reopen, clears on reset and rejects stale answers', async () => {
  const { props } = fixture()
  const resets = new Set<() => void>()
  props.subscribeReset = listener => {
    resets.add(listener)
    return () => resets.delete(listener)
  }
  let release: (roles: Record<string, { roleId: string; displayName: string }>) => void = () => {}
  const getRoles = vi
    .fn<NonNullable<CatalogProps['getRoles']>>()
    .mockResolvedValueOnce({ a: { roleId: 'worker', displayName: 'worker' } })
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve
        }),
    )
    .mockResolvedValue({ a: { roleId: 'reviewer', displayName: 'reviewer' } })
  props.getRoles = getRoles
  render(<CatalogAction {...props} />)
  fireEvent.click(trigger())
  await settle()
  expect(row('Worker').textContent).toContain('worker')
  fireEvent.click(trigger())
  fireEvent.click(trigger())
  expect(row('Worker').textContent).toContain('worker')
  const old = getRoles.mock.calls[1]?.[1]
  update(() => {
    for (const reset of resets) reset()
    expect(old?.aborted).toBe(true)
  })
  expect(row('Worker').textContent).not.toContain('worker')
  await settle()
  release({ a: { roleId: 'worker', displayName: 'worker' } })
  await settle()
  expect(row('Worker').textContent).toContain('reviewer')
  cleanup()
  expect(resets.size).toBe(0)
})
it('does not overlap role RPCs and aborts timers on unmount', async () => {
  vi.useFakeTimers()
  const { props } = fixture()
  const getRoles = vi.fn<NonNullable<CatalogProps['getRoles']>>(() => new Promise(() => {}))
  props.getRoles = getRoles
  render(<CatalogAction {...props} />)
  fireEvent.click(trigger())
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000)
  })
  expect(getRoles).toHaveBeenCalledTimes(1)
  const signal = getRoles.mock.calls[0]?.[1]
  cleanup()
  expect(signal?.aborted).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
it('normalizes retained projections while showing migration and loading explicitly', async () => {
  const { props, state } = fixture()
  state.projectionsBySession.a = { state: 'idle', values: {} }
  state.byId.b = { formatStatus: 'migration-required' }
  render(<CatalogAction {...props} />)
  fireEvent.click(trigger())
  fireEvent.click(screen.getByRole('button', { name: 'Expand Worker' }))
  expect(screen.getByRole('status').textContent).toContain('Loading')
  expect(row('Ordinary').textContent).toContain('Migration required')
  expect(screen.queryByRole('button', { name: 'Expand Ordinary' })).toBeNull()
  await settle()
  cleanup()
  state.projectionsBySession.a = { state: 'migration-required', values: { subagentCatalog: [] } }
  render(<CatalogAction {...props} />)
  fireEvent.click(trigger())
  expect(screen.queryByRole('button', { name: 'Expand Worker' })).toBeNull()
  await settle()
})
it('splits lineage title navigation from touch-accessible sibling list toggle', async () => {
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
  expect(screen.getAllByRole('button')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: 'Worker' }))
  expect(openTitle).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(trigger())
  await settle()
  expect(row('Worker').getAttribute('aria-current')).toBe('true')
  expect(screen.getByRole('dialog', { name: 'Sibling subagents' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Open Worker in sidebar' })).toBeNull()
})
it('shows incomplete external counts rather than reporting a complete zero', async () => {
  const { props } = fixture()
  props.getExternalRuns = vi.fn<NonNullable<CatalogProps['getExternalRuns']>>(() => new Promise(() => {}))
  render(<CatalogAction {...props} />)
  expect(trigger().getAttribute('aria-label')).toContain('Status incomplete')
  fireEvent.click(trigger())
  expect(row('External').textContent).toContain('Loading status')
  await settle()
})
it('keeps healthy external scopes live when another parent is stale and marks missing records', async () => {
  vi.useFakeTimers()
  const { props, state } = fixture()
  state.projectionsBySession.a = {
    state: 'ready',
    values: { subagentCatalog: [{ id: 'y', label: 'Nested external', mode: 'external' }] },
  }
  const run = (id: string, parentSessionId: string): ExternalRunDisplay => ({
    id,
    parentSessionId,
    roleId: 'worker',
    cli: 'codex',
    label: id,
    status: 'running',
    startedAt: '2026-10-29T00:00:00Z',
    resultTruncated: false,
  })
  let stale = false
  props.getExternalRuns = vi.fn(async parent => {
    if (parent === 'root' && stale) throw new Error('offline')
    return { runs: [run(parent === 'root' ? 'x' : 'y', parent)], durable: true }
  })
  render(<CatalogAction {...props} />)
  fireEvent.click(trigger())
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  fireEvent.click(screen.getByRole('button', { name: 'Expand Worker' }))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  stale = true
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(row('External').textContent).toContain('Stale · last known')
  expect(row('Nested external').textContent).toContain('Codex · Running')
  expect(trigger().getAttribute('aria-label')).toContain('Running 1')
  expect(trigger().getAttribute('aria-label')).toContain('Stale information')
  expect(trigger().textContent).toContain('↻')
  cleanup()
  props.getExternalRuns = vi.fn(async () => ({ runs: [], durable: true }))
  render(<CatalogAction {...props} />)
  fireEvent.click(trigger())
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(row('External').textContent).toContain('Record unavailable')
  expect(trigger().getAttribute('aria-label')).toContain('Status incomplete')
})

it('localizes status, exposes explicit action labels and excludes token metrics', async () => {
  const { props, state } = fixture()
  props.getLocale = () => 'ja'
  state.byId.a = {
    projectionValues: {
      tokenUsage: { uncachedInputTokens: 1000, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 },
    },
  }
  render(<CatalogAction {...props} />)
  expect(trigger().getAttribute('aria-label')).toContain('直下の子')
  fireEvent.click(trigger())
  await settle()
  expect(row('Worker').getAttribute('aria-label')).toContain('worker · DSH · 実行中 · チャットを開く')
  expect(screen.getByRole('dialog').textContent).not.toContain('トークン')
  expect(screen.getByRole('button', { name: 'Workerをサイドバーで開く' })).toBeTruthy()
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
