/** Browser-only component fixture: no live context, transport, credentials, or host imports. */
import { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { CatalogAction, CatalogLineage } from '../../src/client/catalog.tsx'
import { mountCatalog } from '../../src/client/catalog-mount.ts'
import type { CatalogAddress, CatalogProps, CatalogState } from '../../src/client/catalog-types.ts'
import type { DshClientContext } from '../../src/client/dsh.ts'

const hostile = '<img src=x onerror="window.__xss=1">'
const state: CatalogState = {
  byId: {
    root: { title: 'Local fixture' },
    hostile: { formatStatus: 'migration-required' },
    worker: {
      origin: 'subagent',
      parentId: 'root',
      title: 'Implement catalog',
      projectionValues: {
        tokenUsage: { uncachedInputTokens: 1000, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0 },
        subagentTiming: { settledMs: 42000 },
      },
    },
    ordinary: {
      title: 'No role metadata',
      projectionValues: { subagentTiming: { settledMs: 2000, lastTurnCompleted: true } },
    },
  },
  projectionsBySession: {
    root: {
      state: 'ready',
      values: {
        subagentCatalog: [
          { id: 'worker', label: 'Worker', mode: 'continuable' },
          { id: 'ordinary', label: 'Ordinary', mode: 'one-shot' },
          { id: 'external', label: 'External', mode: 'external' },
          { id: 'hostile', label: hostile, mode: 'one-shot' },
        ],
      },
    },
    worker: {
      state: 'ready',
      values: { subagentCatalog: [{ id: 'nested', label: 'Nested reviewer', mode: 'continuable' }] },
    },
    nested: { state: 'ready', values: { subagentCatalog: [] } },
    ordinary: { state: 'ready', values: { subagentCatalog: [] } },
    hostile: { state: 'ready', values: { subagentCatalog: [] } },
  },
}
const changes = new Set<() => void>()
const resets = new Set<() => void>()
const subscriptions = new Set<() => void>()
const signals: AbortSignal[] = []
const calls: { open: CatalogAddress[]; aside: CatalogAddress[]; refresh: string[]; metadata: number } = {
  open: [],
  aside: [],
  refresh: [],
  metadata: 0,
}
let revision = 0
let locale = 'en'
let metadata: 'ready' | 'missing' | 'unavailable' | 'pending' = 'ready'
let unmounted = false
const emit = () => {
  revision++
  for (const listener of changes) listener()
}
const subscribe = (listener: () => void) => {
  changes.add(listener)
  return () => {
    changes.delete(listener)
  }
}
const props: CatalogProps = {
  sessionId: 'root',
  useSessions: select => {
    useSyncExternalStore(subscribe, () => revision)
    return select(state)
  },
  useSessionStatus: select => select(new Map([['worker', { running: true }]])),
  openChild: address => {
    calls.open.push(address)
  },
  openChildAside: address => {
    calls.aside.push(address)
  },
  refreshProjection: id => {
    calls.refresh.push(id)
    if (state.projectionsBySession[id]?.state === 'error') {
      state.projectionsBySession[id] = {
        state: 'ready',
        values: { subagentCatalog: [{ id: 'nested', label: 'Nested reviewer', mode: 'continuable' }] },
      }
      emit()
    }
  },
  getLocale: () => locale,
  subscribeLocale: listener => {
    subscriptions.add(listener)
    return () => {
      subscriptions.delete(listener)
    }
  },
  subscribeReset: listener => {
    resets.add(listener)
    return () => {
      resets.delete(listener)
    }
  },
  getRoles: async (ids, signal) => {
    calls.metadata++
    signals.push(signal)
    if (metadata === 'pending') return new Promise(() => {})
    if (metadata === 'unavailable') throw new Error('Expected fixture metadata outage')
    if (metadata === 'missing') return {}
    return Object.fromEntries(
      ids
        .filter(id => ['worker', 'nested', 'hostile'].includes(id))
        .map(id => {
          const roleId = id === 'worker' ? 'worker' : id === 'nested' ? 'reviewer' : hostile
          return [id, { roleId, displayName: roleId }]
        }),
    )
  },
}
// Install production CSS through its lifecycle, but all services/slots below are inert fixture refs.
const disposers: (() => unknown)[] = []
mountCatalog({
  get: (name: string) =>
    ({
      sessions: { refreshProjections: () => {} },
      uiWorkspace: { openSession: () => {} },
      sidebarRight: { openResource: () => {} },
    })[name],
  effect: (effect: () => () => unknown) => {
    disposers.push(effect())
  },
  slots: { inject: () => {} },
} as unknown as DshClientContext)
const root = createRoot(document.getElementById('fixture')!)
root.render(
  <>
    <h1>Role catalog · isolated component smoke</h1>
    <p>Local projections and metadata only. Not the DSH GUI.</p>
    <section id="root-action">
      <h2>Root session</h2>
      <CatalogAction {...props} />
    </section>
    <section id="child-action">
      <CatalogAction {...props} sessionId="worker" />
    </section>
    <section id="lineage">
      <h2>Child session lineage</h2>
      <CatalogLineage
        {...props}
        sessionId="worker"
        lineageSessionId="worker"
        displayTitle="Worker"
        useSession={select =>
          select({ subagent: { address: { parentSessionId: 'root', childSessionId: 'worker', mode: 'continuable' } } })
        }
      />
    </section>
    <button type="button" id="outside">
      Outside focus target
    </button>
  </>,
)
const assert = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message)
}
const wait = async (test: () => unknown, label: string) => {
  const end = performance.now() + 8000
  while (!test()) {
    if (performance.now() > end) throw new Error(`Timeout: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
const row = (prefix: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('[role=treeitem]')).find(element =>
    element.getAttribute('aria-label')?.startsWith(prefix),
  )!
const tree = () => document.querySelector<HTMLElement>('[role=tree]')
const api = {
  ready: () => !!document.querySelector('#root-action button'),
  calls,
  async checkRoot() {
    await wait(() => row('Worker')?.querySelector('svg path'), 'metadata badge')
    assert(document.activeElement === row('Worker'), 'ArrowDown must open and focus first tree item')
    assert(!document.querySelector('#child-action button'), 'Child must not duplicate root action')
    assert(
      row('Worker').getAttribute('aria-label')?.includes('1050 tokens · 42 seconds active'),
      'Usage and duration accessibility',
    )
    assert(
      row('Worker').getAttribute('aria-label')?.includes('Implement catalog · Continuable'),
      'Title and mode accessible',
    )
    assert(row(hostile).getAttribute('aria-label')?.includes('Migration required'), 'Migration state accessible')
    assert(row('Worker').textContent?.includes('0:42'), 'Visible duration')
    assert(row('Ordinary').getAttribute('aria-label')?.includes('Completed'), 'Completed status')
    assert(!row('Ordinary').querySelector('svg'), 'Ordinary row must remain undecorated')
    assert(row('External').getAttribute('aria-disabled') === 'true', 'External disabled')
    assert(
      row(hostile).querySelector('svg path') && row(hostile).textContent?.includes(hostile),
      'Custom role is SVG plus escaped text',
    )
    assert(
      !document.querySelector('img, svg script, [onerror]') && !('__xss' in window),
      'No injected HTML or execution',
    )
    assert(document.querySelectorAll('#lineage .dshrs-catalog').length === 2, 'Lineage and child catalog mounted')
  },
  async checkNested() {
    await wait(() => row('Nested reviewer')?.querySelector('svg'), 'nested metadata')
    assert(row('Nested reviewer').getAttribute('aria-level') === '2', 'Nested aria level')
    assert(calls.refresh.includes('worker'), 'Nested projection requested')
  },
  async checkCurrent() {
    await wait(() => row('Worker')?.querySelector('svg'), 'lineage metadata')
    const current = row('Worker')
    const ordinary = row('Ordinary')
    const label = (element: HTMLElement) => getComputedStyle(element.querySelector('.dshrs-catalog-label')!)
    assert(current.getAttribute('aria-current') === 'true', 'Current child is semantically identified')
    assert(
      getComputedStyle(current).backgroundColor !== 'rgba(0, 0, 0, 0)' &&
        getComputedStyle(current).backgroundColor !== getComputedStyle(ordinary).backgroundColor,
      'Current child has painted background',
    )
    assert(
      Number(label(current).fontWeight) > Number(label(ordinary).fontWeight),
      'Current child has distinct bold label',
    )
    const originalStyle = document.body.style.cssText
    try {
      document.body.style.setProperty('--dsw-specific-menu', '#fff')
      document.body.style.setProperty('--dsw-alias-label-primary', '#222')
      assert(getComputedStyle(tree()!).backgroundColor === 'rgb(255, 255, 255)', 'Light theme menu background')
      assert(label(current).color === 'rgb(34, 34, 34)', 'Light theme current label inherits readable foreground')
      assert(
        Number(label(current).fontWeight) > Number(label(ordinary).fontWeight),
        'Light theme current label remains bold',
      )
      assert(
        getComputedStyle(current).backgroundColor !== getComputedStyle(ordinary).backgroundColor,
        'Light theme current row remains painted',
      )
    } finally {
      document.body.style.cssText = originalStyle
    }
  },
  checkExternal() {
    assert(calls.open.length === 0 && calls.aside.length === 0, 'External cannot navigate')
  },
  checkNavigation(kind: 'open' | 'aside', parent: string, child: string) {
    const address = calls[kind].at(-1)
    assert(
      address?.parentSessionId === parent &&
        address?.childSessionId === child &&
        address?.mode === (child === 'ordinary' ? 'one-shot' : 'continuable'),
      `Exact ${kind} direct-parent address`,
    )
    assert(!tree(), 'Navigation closes menu')
  },
  checkClosed(focus = false) {
    assert(!tree(), 'Menu dismissed')
    if (focus)
      assert(document.activeElement === document.querySelector('#root-action button'), 'Escape returns trigger focus')
  },
  setLocale() {
    locale = 'ja'
    document.documentElement.lang = 'ja'
    for (const listener of subscriptions) listener()
  },
  async checkMobile() {
    await wait(() => tree()?.getAttribute('aria-label') === 'サブエージェント', 'Japanese tree')
    assert(row('Worker').getAttribute('aria-label')?.includes('1050 トークン · 42 秒稼働'), 'Japanese usage and status')
    assert(row('Worker').textContent?.includes('実行中'), 'Japanese running status')
    assert(
      row('Worker').getAttribute('aria-label')?.includes('継続可能') &&
        row(hostile).getAttribute('aria-label')?.includes('履歴の更新が必要'),
      'Japanese mode and migration accessible',
    )
    const bounds = tree()!.getBoundingClientRect()
    assert(bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight, 'Menu fits narrow viewport')
    assert(
      tree()!.scrollWidth <= tree()!.clientWidth && document.documentElement.scrollWidth <= innerWidth,
      'No horizontal overflow',
    )
  },
  async unavailable() {
    metadata = 'unavailable'
    for (const listener of resets) listener()
    await wait(() => !row('Worker')?.querySelector('svg'), 'reset removes stale badge')
    assert(
      signals.slice(0, -1).every(signal => signal.aborted),
      'Reset aborts old metadata requests',
    )
    assert(row('Worker') && row('Ordinary'), 'Metadata outage preserves navigation')
  },
  async recoverByRetry() {
    const previous = calls.metadata
    metadata = 'ready'
    await wait(() => row('Worker')?.querySelector('svg'), 'real five-second metadata retry')
    assert(calls.metadata > previous, 'Metadata retried without reconnect')
  },
  async projectionError() {
    state.projectionsBySession.worker = {
      state: 'error',
      error: { message: 'Fixture projection unavailable' },
      values: {},
    }
    emit()
    await wait(() => document.querySelector('[role=alert]'), 'projection error appears')
  },
  async checkRetry() {
    await wait(() => row('Nested reviewer'), 'projection retry')
    assert(!document.querySelector('[role=alert]'), 'Retry clears projection error')
  },
  async pendingAndUnmount() {
    metadata = 'pending'
    for (const listener of resets) listener()
    await wait(() => signals.length > 0 && !signals.at(-1)!.aborted, 'pending metadata')
    const previous = calls.metadata
    await new Promise(resolve => setTimeout(resolve, 5200))
    assert(calls.metadata === previous, 'Pending metadata is not overlapped by polling')
    root.unmount()
    unmounted = true
    for (const dispose of disposers) dispose()
    assert(
      signals.every(signal => signal.aborted),
      'Unmount aborts every outstanding metadata request',
    )
    assert(
      changes.size === 0 && resets.size === 0 && subscriptions.size === 0 && !tree(),
      'Unmount releases subscriptions and portals',
    )
    await new Promise(resolve => setTimeout(resolve, 5200))
    assert(calls.metadata === previous, 'No polling after unmount')
  },
  summary: () => ({
    calls,
    unmounted,
    signals: signals.length,
    allSignalsAborted: signals.every(signal => signal.aborted),
  }),
}
Object.assign(window, { smoke: api })
