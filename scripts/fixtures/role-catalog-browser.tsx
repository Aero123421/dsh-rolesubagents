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
let externalUnavailable = false
let workerRunning = true
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
  useSessionStatus: select => select(new Map([['worker', { running: workerRunning }]])),
  openParent: id => {
    assert(id === 'root', 'Inspector parent scope')
  },
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
  getExternalRuns: async parentSessionId => {
    if (externalUnavailable) throw new Error('Expected fixture external outage')
    return {
      durable: true,
      runs:
        parentSessionId === 'root'
          ? [
              {
                id: 'external',
                parentSessionId: 'root',
                roleId: 'worker',
                cli: 'codex',
                label: 'External',
                model: 'fixture-model',
                status: 'succeeded',
                startedAt: '2026-10-25T12:00:00.000Z',
                endedAt: '2026-10-25T12:00:03.000Z',
                resultText: `Fixture final result: ${hostile}`,
                resultTruncated: false,
              },
            ]
          : [],
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
      Parent chat focus target
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
  Array.from(document.querySelectorAll<HTMLElement>('[data-catalog-main]')).find(element =>
    element.getAttribute('aria-label')?.startsWith(prefix),
  )!
const tree = () => document.querySelector<HTMLElement>('.dshrs-catalog-menu[role=dialog]')
// Verify actual computed paint, not z-index: translucent theme tokens must not bleed chat text through overlays.
const checkOpaqueSurface = (element: Element) => {
  const originalStyle = document.body.style.cssText
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')!
  try {
    for (const [theme, token, rgb] of [
      ['dark', 'rgb(44 44 48 / .86)', [44, 44, 48]],
      ['light', 'rgb(250 250 252 / .86)', [250, 250, 252]],
    ] as const) {
      document.body.style.setProperty('--dsw-specific-menu', token)
      const computed = getComputedStyle(element).backgroundColor
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = computed
      context.fillRect(0, 0, 1, 1)
      const pixel = context.getImageData(0, 0, 1, 1).data
      assert(pixel[3] === 255, `${theme} overlay background must have alpha 1, got ${computed}`)
      assert(
        rgb.every((channel, index) => Math.abs(pixel[index]! - channel) <= 1),
        `${theme} overlay retains theme RGB`,
      )
    }
  } finally {
    document.body.style.cssText = originalStyle
  }
}
const api = {
  checkOpaqueMenu() {
    assert(tree(), 'Menu mounted for opaque surface regression')
    checkOpaqueSurface(tree()!)
  },
  ready: () => !!document.querySelector('#root-action button'),
  calls,
  async checkRoot() {
    await wait(() => row('Worker')?.querySelector('.dshrs-catalog-role')?.textContent, 'metadata badge')
    assert(!document.querySelector('[role=tree], [role=treeitem]'), 'No ARIA tree semantics')
    assert(tree()?.getAttribute('aria-label') === 'Subagents', 'Named Subagents dialog')
    assert(tree()?.getAttribute('aria-modal') !== 'true', 'Catalog nonmodal')
    assert(!document.querySelector('#child-action button'), 'Child must not duplicate root action')
    assert(!row('Ordinary') && !row('External'), 'Completed history collapsed initially')
    assert(row('Worker') && !row('Ordinary'), 'Running visible in current section ahead of collapsed completed history')
    assert(row(hostile).getAttribute('aria-label')?.includes('Migration required'), 'Migration state accessible')
    assert(
      row(hostile).querySelector('.dshrs-catalog-role')?.textContent === hostile &&
        row(hostile).textContent?.includes(hostile),
      'Plain role label and escaped hostile text',
    )
    assert(
      !document.querySelector('img, svg script, [onerror]') && !('__xss' in window),
      'No injected HTML or execution',
    )
    assert(document.querySelectorAll('#lineage .dshrs-catalog').length === 2, 'Sibling and direct-child scope controls')
    const scopes = Array.from(document.querySelectorAll('#lineage .dshrs-catalog-trigger'))
    assert(scopes[0]?.getAttribute('aria-label')?.startsWith('Sibling subagents'), 'Sibling scope explicit')
    assert(scopes[1]?.getAttribute('aria-label')?.startsWith('Subagents:'), 'Direct children scope explicit')
  },
  async checkNested() {
    await wait(() => row('Nested reviewer')?.querySelector('.dshrs-catalog-role')?.textContent, 'nested metadata')
    assert(row('Nested reviewer').closest('.dshrs-catalog-group'), 'Nested direct-child group')
    assert(
      row('Nested reviewer').getAttribute('aria-label')?.includes('Status unknown'),
      'Missing evidence remains unknown',
    )
    assert(calls.refresh.includes('worker'), 'Nested projection requested')
  },
  checkHistory() {
    assert(row('Ordinary')?.getAttribute('aria-label')?.includes('Completed'), 'Completed history revealed')
    assert(!row('Ordinary').querySelector('.dshrs-catalog-role')?.textContent, 'Ordinary row has no invented role')
    assert(row('External')?.getAttribute('aria-label')?.includes('View result'), 'External result action distinct')
    assert(row('Worker').getAttribute('aria-label')?.includes('Open chat'), 'Native chat action distinct')
  },
  checkLayout() {
    const menu = tree()!
    const bounds = menu.getBoundingClientRect()
    assert(
      bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight,
      'Catalog fits viewport',
    )
    assert(
      menu.scrollWidth <= menu.clientWidth && document.documentElement.scrollWidth <= innerWidth,
      'Catalog no horizontal overflow',
    )
    if (innerWidth > 640) {
      assert(Math.abs(bounds.width - 384) < 1 && bounds.height <= 472, 'Desktop width 384 and max height 472')
    } else {
      assert(
        bounds.height <= innerHeight * 0.72 + 1 && Math.abs(bounds.bottom - innerHeight) < 1,
        'Mobile bottom sheet max72dvh',
      )
      for (const button of menu.querySelectorAll('button')) {
        const r = button.getBoundingClientRect()
        assert(r.height >= 44 && r.width >= 44, 'Mobile touch controls at least 44px')
      }
    }
  },
  setTheme(light: boolean) {
    document.body.style.setProperty('--dsw-specific-menu', light ? 'rgb(250 250 252 / .86)' : 'rgb(44 44 48 / .86)')
    document.body.style.setProperty('--dsw-alias-label-primary', light ? '#222' : '#eee')
    document.body.style.setProperty('--dsw-alias-label-secondary', light ? '#535968' : '#b3b9c5')
    document.body.style.background = light ? '#e9edf4' : '#17191e'
    document.body.style.color = light ? '#222' : '#eee'
  },
  setWorkerCompleted(value: boolean) {
    workerRunning = !value
    state.byId.worker!.projectionValues!.subagentTiming!.lastTurnCompleted = value
    emit()
  },
  async checkCompletionFocus() {
    row('Worker').focus()
    api.setWorkerCompleted(true)
    await wait(() => !row('Worker'), 'Completed row moves into collapsed history')
    assert(tree()?.contains(document.activeElement), 'Completion preserves keyboard focus inside catalog')
    api.setWorkerCompleted(false)
    await wait(() => row('Worker'), 'Running row restored')
  },
  async checkRoleCache() {
    metadata = 'pending'
    return true
  },
  checkCachedRole() {
    assert(
      row('Worker')?.querySelector('.dshrs-catalog-role')?.textContent,
      'Positive role cache survives close/reopen while next request pending',
    )
    metadata = 'ready'
  },
  async checkStale() {
    externalUnavailable = true
    await wait(() => row('External')?.getAttribute('aria-label')?.includes('Stale'), 'Actual five-second stale poll')
    assert(
      row('External').getAttribute('aria-label')?.includes('Completed'),
      'Last known external state retained, explicitly stale',
    )
    assert(
      document.querySelector('#root-action button')?.getAttribute('aria-label')?.includes('Stale information'),
      'Trigger stale summary',
    )
    externalUnavailable = false
    await wait(() => !row('External')?.getAttribute('aria-label')?.includes('Stale'), 'External recovery')
  },
  async checkCurrent() {
    await wait(() => row('Worker')?.querySelector('.dshrs-catalog-role')?.textContent, 'lineage metadata')
    const current = row('Worker')
    const ordinary = row(hostile)
    const label = (element: HTMLElement) => getComputedStyle(element.querySelector('.dshrs-catalog-label')!)
    assert(current.getAttribute('aria-current') === 'true', 'Current child is semantically identified')
    assert(
      !row('Ordinary') && tree()?.querySelector('.dshrs-catalog-history')?.getAttribute('aria-expanded') === 'false',
      'Completed current stays ahead of collapsed history',
    )
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
      checkOpaqueSurface(tree()!)
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
  async checkExternal() {
    await wait(() => document.querySelector('.dshrs-run-dialog pre'), 'external result dialog')
    const dialog = document.querySelector('.dshrs-run-dialog')!
    assert(calls.open.length === 0 && calls.aside.length === 0, 'External details must not navigate to a child chat')
    assert(
      dialog.textContent?.includes('Completed') && dialog.textContent.includes('fixture-model'),
      'External status and requested model',
    )
    assert(
      dialog.querySelector('pre')?.textContent === `Fixture final result: ${hostile}`,
      'Escaped retained final result',
    )
    assert(!dialog.querySelector('img, [onerror]') && !('__xss' in window), 'Result cannot execute HTML')
    assert(document.activeElement === dialog.querySelector('button'), 'Inspector initially focuses close')
    assert(dialog.getAttribute('aria-modal') === 'false' && !tree(), 'Result inspector is distinct nonmodal dialog')
    assert(!document.querySelector('.dshrs-run-backdrop, [aria-modal=true]'), 'No modal backdrop')
    const parent = document.querySelector<HTMLButtonElement>('#outside')!
    parent.focus()
    assert(
      document.activeElement === parent && document.querySelector('.dshrs-run-dialog'),
      'Parent chat remains focusable with inspector open',
    )
    ;(dialog.querySelector('button') as HTMLButtonElement).focus()
  },
  async checkExternalLayout() {
    await wait(() => document.querySelector('.dshrs-run-dialog pre'), 'external result layout')
    const dialog = document.querySelector<HTMLElement>('.dshrs-run-dialog')!
    checkOpaqueSurface(dialog)
    const bounds = dialog.getBoundingClientRect()
    assert(
      bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight,
      'Dialog fits viewport',
    )
    assert(
      dialog.scrollWidth <= dialog.clientWidth && document.documentElement.scrollWidth <= innerWidth,
      'Dialog has no horizontal overflow',
    )
    assert(dialog.textContent?.includes(locale === 'ja' ? '完了' : 'Completed'), 'Localized dialog status')
    if (innerWidth <= 640) {
      assert(bounds.height <= innerHeight * 0.72 + 1, 'Inspector mobile max72dvh')
      for (const button of dialog.querySelectorAll('button'))
        assert(button.getBoundingClientRect().height >= 44, 'Inspector touch controls')
    }
    const close = dialog.querySelector('button')!.getBoundingClientRect()
    assert(
      close.left >= bounds.left &&
        close.right <= bounds.right &&
        close.top >= bounds.top &&
        close.bottom <= bounds.bottom,
      'Close button visible',
    )
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
    assert(!tree() && !document.querySelector('.dshrs-run-dialog'), 'Catalog and result inspector dismissed')
    if (focus)
      assert(document.activeElement === document.querySelector('#root-action button'), 'Escape returns trigger focus')
  },
  setLocale() {
    locale = 'ja'
    document.documentElement.lang = 'ja'
    for (const listener of subscriptions) listener()
  },
  async checkMobile() {
    await wait(() => tree()?.getAttribute('aria-label') === 'サブエージェント', 'Japanese named catalog dialog')
    assert(row('Worker').textContent?.includes('実行中'), 'Japanese running state')
    assert(row(hostile).getAttribute('aria-label')?.includes('履歴の更新が必要'), 'Japanese migration state')
    assert(
      document.querySelector('#root-action button')?.getAttribute('aria-label')?.includes('実行中 1'),
      'Japanese accessible running summary',
    )
    const role = row('Worker').querySelector<HTMLElement>('.dshrs-catalog-role')!
    assert(
      role.textContent === 'worker' && role.scrollWidth <= role.clientWidth,
      'Mobile worker role fully readable without clipping',
    )
    api.checkLayout()
  },
  async unavailable() {
    metadata = 'unavailable'
    for (const listener of resets) listener()
    await wait(() => !row('Worker')?.querySelector('.dshrs-catalog-role')?.textContent, 'reset removes stale badge')
    assert(
      signals.slice(0, -1).every(signal => signal.aborted),
      'Reset aborts old metadata requests',
    )
    assert(row('Worker') && row(hostile), 'Metadata outage preserves navigation')
  },
  async recoverByRetry() {
    const previous = calls.metadata
    metadata = 'ready'
    await wait(
      () => row('Worker')?.querySelector('.dshrs-catalog-role')?.textContent,
      'real five-second metadata retry',
    )
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
