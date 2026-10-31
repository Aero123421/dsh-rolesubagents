import {
  useCallback,
  useSyncExternalStore,
  useEffect,
  useLayoutEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useExternalRuns } from './external-runs.ts'
import { ExternalRunDialog } from './ExternalRunDialog.tsx'
import { cliDescriptor } from '../shared/cli/index.ts'
import {
  activityLabel,
  activitySymbol,
  externalActivity,
  nativeActivity,
  isAttention,
  isHistory,
  isIncomplete,
} from './catalog-state.ts'
import type {
  CatalogActions,
  CatalogHooks,
  CatalogLineageProps,
  CatalogProps,
  CatalogRole,
  CatalogProjection,
  CatalogEntry,
} from './catalog-types.ts'

/** The native store retains projected values during idle/migration transitions. */
function projectionState(projection: CatalogProjection | undefined) {
  const projected = projection?.values.subagentCatalog !== undefined
  if (!projection || projection.state === 'idle') return projected ? 'ready' : 'loading'
  return projection.state === 'migration-required' && projected ? 'ready' : projection.state
}
const defaultLocale = () => 'en'
const noSubscription = () => () => {}

/** Retain positive metadata over close/reopen; never permanently cache absence. */
function useRoles(ids: string[], active: boolean, scope: string, actions: CatalogActions) {
  const [roles, setRoles] = useState<Record<string, CatalogRole>>({})
  const [epoch, setEpoch] = useState(0)
  const pending = useRef<AbortController>()
  const key = JSON.stringify({ ids: [...new Set(ids)].sort(), epoch, scope })
  // biome-ignore lint/correctness/useExhaustiveDependencies: Scope changes deliberately invalidate positive metadata.
  useEffect(() => {
    setRoles({})
    pending.current?.abort()
  }, [scope])
  useEffect(() => {
    const dispose = actions.subscribeReset?.(() => {
      pending.current?.abort()
      setRoles({})
      setEpoch(n => n + 1)
    })
    return () => {
      dispose?.()
    }
  }, [actions.subscribeReset])
  useEffect(() => {
    const requested: string[] = JSON.parse(key).ids
    if (!active || !actions.getRoles || requested.length === 0) return
    const controller = new AbortController()
    pending.current = controller
    let inFlight = false
    const load = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const result = await actions.getRoles?.(requested, controller.signal)
        if (!controller.signal.aborted && result)
          setRoles(previous => {
            const next = { ...previous }
            for (const id of requested) delete next[id]
            return { ...next, ...result }
          })
      } catch {
        /* Optional metadata must not disable navigation. */
      } finally {
        inFlight = false
      }
    }
    void load()
    const timer = setInterval(() => {
      void load()
    }, 5000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [key, active, actions.getRoles])
  return roles
}

export function CatalogDropdown(
  props: CatalogHooks &
    CatalogActions & {
      rootSessionId: string
      currentSessionId?: string
      displayTitle?: string
      openTitle?: () => void
    },
) {
  const { rootSessionId, currentSessionId, displayTitle, openTitle } = props
  const locale = useSyncExternalStore(props.subscribeLocale ?? noSubscription, props.getLocale ?? defaultLocale)
  const ja = locale.startsWith('ja')
  const text = (en: string, jp: string) => (ja ? jp : en)
  const state = props.useSessions(value => value)
  const statuses = props.useSessionStatus(value => value)
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [history, setHistory] = useState<Set<string>>(new Set())
  const [position, setPosition] = useState({ left: 8, top: 8, maxHeight: 472 })
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const focused = useRef<{ element: HTMLElement; parent?: string }>()
  // A live row can move into collapsed history. Recover only focus lost by removal,
  // never focus that the user deliberately moved back to the surrounding chat.
  useLayoutEffect(() => {
    const previous = focused.current
    if (!open || !previous || previous.element.isConnected) return
    focused.current = undefined
    if (document.activeElement !== document.body) return
    const disclosure = Array.from(
      menu.current?.querySelectorAll<HTMLButtonElement>('[data-history-parent]') ?? [],
    ).find(button => button.dataset.historyParent === previous.parent)
    ;(disclosure ?? menu.current?.querySelector<HTMLButtonElement>('button'))?.focus()
  })
  const menuId = useId()
  const catalog = state.projectionsBySession[rootSessionId]
  const entries = catalog?.values.subagentCatalog ?? []
  const [selectedRun, setSelectedRun] = useState<{ id: string; label: string; parent: string }>()
  const externalParents = [rootSessionId, ...expanded].filter(id =>
    state.projectionsBySession[id]?.values.subagentCatalog?.some(entry => entry.mode === 'external'),
  )
  if (selectedRun) externalParents.push(selectedRun.parent)
  const externalRuns = useExternalRuns(externalParents, props.getExternalRuns, props.subscribeReset)
  const roles = useRoles(
    [rootSessionId, ...expanded].flatMap(
      id => state.projectionsBySession[id]?.values.subagentCatalog?.map(e => e.id) ?? [],
    ),
    open,
    rootSessionId,
    props,
  )
  const activity = (entry: CatalogEntry, parent: string) => {
    if (entry.mode === 'external') {
      const scope = externalRuns.byParent[parent]
      return externalActivity(scope?.byId[entry.id], scope)
    }
    const summary = state.byId[entry.id]
    if (
      summary?.formatStatus === 'migration-required' ||
      projectionState(state.projectionsBySession[entry.id]) === 'migration-required'
    )
      return 'migration'
    return nativeActivity(summary, statuses.get(entry.id)?.running ?? summary?.running)
  }
  const close = useCallback((focus = false) => {
    focused.current = undefined
    setOpen(false)
    setExpanded(new Set())
    setHistory(new Set())
    if (focus) trigger.current?.focus()
  }, [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: A new session scope must dismiss old overlays.
  useEffect(() => {
    close()
    setSelectedRun(undefined)
  }, [rootSessionId, close])
  const visible = displayTitle !== undefined || entries.length > 0 || catalog?.state === 'error'
  useEffect(() => {
    if (!visible && open) close()
  }, [visible, open, close])
  useEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect)
        setPosition({
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 392)),
          top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 100)),
          maxHeight: Math.min(472, Math.max(80, window.innerHeight - rect.bottom - 16)),
        })
    }
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        close()
    }
    const trackOutsideFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) focused.current = undefined
    }
    document.addEventListener('focusin', trackOutsideFocus)
    place()
    // All opening methods put focus in the nonmodal dialog; no focus trap.
    menu.current?.querySelector<HTMLElement>('[data-catalog-main],button')?.focus()
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    return () => {
      document.removeEventListener('focusin', trackOutsideFocus)
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
    }
  }, [open, close])
  const toggle = (id: string) => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (next.has(id)) {
        const visited = new Set<string>()
        const collapse = (parent: string) => {
          if (visited.has(parent)) return
          visited.add(parent)
          next.delete(parent)
          for (const entry of state.projectionsBySession[parent]?.values.subagentCatalog ?? []) collapse(entry.id)
        }
        collapse(id)
      } else next.add(id)
      return next
    })
    if (!expanded.has(id)) props.refreshProjection(id)
  }
  const navigate = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    const list = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
    if (!list.length) return
    const index = list.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? list.length - 1
          : event.key === 'ArrowDown'
            ? (index + 1) % list.length
            : event.key === 'ArrowUp'
              ? (index + list.length - 1) % list.length
              : undefined
    if (next !== undefined) {
      event.preventDefault()
      list[next]?.focus()
    }
  }
  const rows = (parent: string, ancestors: Set<string>): React.ReactNode => {
    const projection = state.projectionsBySession[parent]
    const status = projectionState(projection)
    const children = projection?.values.subagentCatalog ?? []
    const current = children
      .filter(e => e.id === currentSessionId || !isHistory(activity(e, parent)))
      .reverse()
      .sort((a, b) => Number(isAttention(activity(b, parent))) - Number(isAttention(activity(a, parent))))
    const completed = children.filter(e => e.id !== currentSessionId && isHistory(activity(e, parent))).reverse()
    const renderList = (list: CatalogEntry[]) => (
      <ul className="dshrs-catalog-list">
        {list.map(entry => {
          const summary = state.byId[entry.id]
          const child = state.projectionsBySession[entry.id]
          const external = entry.mode === 'external'
          const status = activity(entry, parent)
          const branch =
            !external &&
            !ancestors.has(entry.id) &&
            status !== 'migration' &&
            !(projectionState(child) === 'ready' && child?.values.subagentCatalog?.length === 0)
          const isExpanded = branch && expanded.has(entry.id)
          const label = entry.label ?? summary?.title ?? entry.id
          const address = { parentSessionId: parent, childSessionId: entry.id, mode: entry.mode }
          const run = externalRuns.byParent[parent]?.byId[entry.id]
          const role = roles[entry.id] ?? (run ? { roleId: run.roleId, displayName: run.roleId } : undefined)
          const runtime = external
            ? run
              ? cliDescriptor(run.cli).displayName
              : text('External CLI', '外部CLI')
            : 'DSH'
          const statusText =
            activityLabel(status, ja) +
            (status === 'stale' && run
              ? ` · ${activityLabel(run.status === 'succeeded' ? 'completed' : run.status, ja)}`
              : '')
          const openChild = () => {
            if (external) {
              trigger.current?.focus()
              setSelectedRun({ id: entry.id, label, parent })
            } else props.openChild(address)
            close()
          }
          const action = external ? text('View result', '結果を表示') : text('Open chat', 'チャットを開く')
          return (
            <li key={entry.id} data-catalog-parent={parent}>
              <div className="dshrs-catalog-row" data-state={status}>
                <button
                  type="button"
                  className="dshrs-catalog-main"
                  data-catalog-main=""
                  aria-current={entry.id === currentSessionId || undefined}
                  aria-label={[label, role?.displayName, runtime, statusText, action].filter(Boolean).join(' · ')}
                  onClick={openChild}
                >
                  <span className="dshrs-catalog-status" aria-hidden="true">
                    {activitySymbol(status)}
                  </span>
                  <span className="dshrs-catalog-copy">
                    <span className="dshrs-catalog-label" title={label}>
                      {label}
                    </span>
                    <span
                      className="dshrs-catalog-meta"
                      title={[role?.displayName, runtime, statusText, run?.error].filter(Boolean).join(' · ')}
                    >
                      <span className="dshrs-catalog-role" title={role?.displayName}>
                        {role?.displayName}
                      </span>
                      <span>
                        {runtime} · {statusText}
                      </span>
                    </span>
                  </span>
                  <span className="dshrs-catalog-action" aria-hidden="true">
                    {external ? text('Result', '結果') : text('Chat', '会話')}
                  </span>
                </button>
                {!external && entry.id !== currentSessionId && (
                  <button
                    type="button"
                    className="dshrs-catalog-aside"
                    aria-label={ja ? `${label}をサイドバーで開く` : `Open ${label} in sidebar`}
                    title={text('Open in sidebar', 'サイドバーで開く')}
                    onClick={() => {
                      props.openChildAside(address)
                      close()
                    }}
                  >
                    ◫
                  </button>
                )}
              </div>
              {branch && (
                <button
                  type="button"
                  className="dshrs-catalog-branch"
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? text('Collapse', '折りたたむ') : text('Expand', '展開')} ${label}`}
                  onClick={() => toggle(entry.id)}
                >
                  {isExpanded ? '− ' : '+ '}
                  {text('Direct children', '直下の子')}
                  {child?.values.subagentCatalog ? ` (${child.values.subagentCatalog.length})` : ''}
                </button>
              )}
              {isExpanded && (
                <div className="dshrs-catalog-group" aria-busy={projectionState(child) === 'loading' || undefined}>
                  {rows(entry.id, new Set([...ancestors, entry.id]))}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    )
    return (
      <>
        {status === 'loading' && !children.length && (
          <p role="status">{text('Loading subagents…', 'サブエージェントを読み込み中…')}</p>
        )}
        {projection?.state === 'error' && (
          <p role="alert">
            {projection.error?.message ?? text('Unable to load subagents.', 'サブエージェントを読み込めません。')}{' '}
            <button className="dshrs-catalog-retry" type="button" onClick={() => props.refreshProjection(parent)}>
              {text('Retry', '再試行')}
            </button>
          </p>
        )}
        {status === 'migration-required' && !children.length && (
          <p>{text('Open this session to update its history.', 'このセッションを開いて履歴を更新してください。')}</p>
        )}
        {status === 'ready' && !children.length && <p>{text('No direct children.', '直下の子はありません。')}</p>}
        {!!current.length && (
          <>
            <h3>
              {text('Current & attention', '稼働中・要確認')} ({current.length})
            </h3>
            {renderList(current)}
          </>
        )}
        {!!completed.length && (
          <>
            <button
              type="button"
              className="dshrs-catalog-history"
              data-history-parent={parent}
              aria-expanded={history.has(parent)}
              onClick={() =>
                setHistory(previous => {
                  const next = new Set(previous)
                  if (next.has(parent)) next.delete(parent)
                  else next.add(parent)
                  return next
                })
              }
            >
              {history.has(parent) ? '− ' : '+ '}
              {text('Completed / history', '完了・履歴')} ({completed.length}) · {text('Newest first', '新しい順')}
            </button>
            {history.has(parent) && renderList(completed)}
          </>
        )}
      </>
    )
  }
  if (!visible) return null
  const activeCount = entries.filter(e => activity(e, rootSessionId) === 'running').length
  const attentionCount = entries.filter(e => isAttention(activity(e, rootSessionId))).length
  const stale = entries.some(e => activity(e, rootSessionId) === 'stale')
  const incomplete =
    catalog?.state === 'error' ||
    projectionState(catalog) !== 'ready' ||
    entries.some(e => isIncomplete(activity(e, rootSessionId)))
  const title = entries.find(e => e.id === currentSessionId)?.label ?? displayTitle
  const scopeLabel = currentSessionId
    ? text('Sibling subagents', '兄弟サブエージェント')
    : text('Subagents', 'サブエージェント')
  const triggerLabel = `${scopeLabel}: ${entries.length} ${text('direct children', '直下の子')} · ${text('Running', '実行中')} ${activeCount} · ${text('Attention', '要確認')} ${attentionCount}${incomplete ? ` · ${text('Status incomplete', '状態未取得・更新停止あり')}` : ''}${stale ? ` · ${text('Stale information', '最終取得時の情報')}` : ''}`
  const show = () => {
    setSelectedRun(undefined)
    setOpen(true)
    props.refreshProjection(rootSessionId)
  }
  return (
    <span className="dshrs-catalog">
      {openTitle && (
        <button
          type="button"
          className="dshrs-catalog-title"
          title={title}
          onClick={() => {
            close()
            openTitle()
          }}
        >
          {title}
        </button>
      )}
      <button
        type="button"
        className="dshrs-catalog-trigger"
        ref={trigger}
        aria-label={triggerLabel}
        title={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (open) close()
          else show()
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            if (!open) show()
            else menu.current?.querySelector('button')?.focus()
          } else if (event.key === 'Escape') close(true)
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
          focusable="false"
        >
          <rect x="8" y="2" width="8" height="6" rx="2" />
          <path d="M12 8v4M5 16v-4h14v4" />
          <rect x="2" y="16" width="6" height="6" rx="2" />
          <rect x="16" y="16" width="6" height="6" rx="2" />
        </svg>
        <span aria-hidden="true">{entries.length}</span>
        {activeCount > 0 && (
          <span className="dshrs-catalog-signal" data-state="running" aria-hidden="true">
            ◌ <span className="dshrs-catalog-signal-label">{text('Running', '実行中')} </span>
            {activeCount}
          </span>
        )}
        {attentionCount > 0 && (
          <span className="dshrs-catalog-signal" data-state="attention" aria-hidden="true">
            ! <span className="dshrs-catalog-signal-label">{text('Attention', '要確認')} </span>
            {attentionCount}
          </span>
        )}
        {incomplete && (
          <span className="dshrs-catalog-signal" aria-hidden="true">
            {stale ? '↻' : '?'}
          </span>
        )}
        <span aria-hidden="true">⌄</span>
      </button>
      {open &&
        createPortal(
          <div
            id={menuId}
            ref={menu}
            className="dshrs-catalog-menu"
            style={
              {
                '--catalog-left': `${position.left}px`,
                '--catalog-top': `${position.top}px`,
                '--catalog-max-height': `${position.maxHeight}px`,
              } as React.CSSProperties
            }
            role="dialog"
            aria-label={scopeLabel}
            onKeyDown={navigate}
            onFocusCapture={event => {
              focused.current = {
                element: event.target,
                parent: event.target.closest<HTMLElement>('[data-catalog-parent]')?.dataset.catalogParent,
              }
            }}
          >
            <div className="dshrs-catalog-heading">
              <div>
                <strong>{scopeLabel}</strong>
                <small>
                  {text('Direct children only', '直下の子のみ')} · {entries.length}
                </small>
              </div>
              <button
                type="button"
                aria-label={text('Close subagents', 'サブエージェントを閉じる')}
                onClick={() => close(true)}
              >
                ✕
              </button>
            </div>
            <div className="dshrs-catalog-scroll">{rows(rootSessionId, new Set([rootSessionId]))}</div>
          </div>,
          document.body,
        )}
      {selectedRun && (
        <ExternalRunDialog
          id={selectedRun.id}
          label={selectedRun.label}
          parentSessionId={selectedRun.parent}
          onOpenParent={props.openParent ? () => props.openParent?.(selectedRun.parent) : undefined}
          state={externalRuns}
          locale={locale}
          onClose={() => {
            setSelectedRun(undefined)
            trigger.current?.focus()
          }}
        />
      )}
    </span>
  )
}

export function CatalogAction(props: CatalogProps) {
  const child = props.useSessions(state => state.byId[props.sessionId]?.origin === 'subagent')
  return child ? null : <CatalogDropdown key={props.sessionId} {...props} rootSessionId={props.sessionId} />
}
export function CatalogLineage(props: CatalogLineageProps) {
  const address = props.useSession(session => session.subagent?.address)
  const parent = props.useSessions(state => {
    if (address?.childSessionId === props.lineageSessionId) return address.parentSessionId
    for (const [id, projection] of Object.entries(state.projectionsBySession))
      if (projection.values.subagentCatalog?.some(entry => entry.id === props.lineageSessionId)) return id
    return state.byId[props.lineageSessionId]?.origin === 'subagent'
      ? state.byId[props.lineageSessionId]?.parentId
      : undefined
  })
  return parent === undefined ? null : (
    <>
      <CatalogDropdown
        key={`lineage:${props.lineageSessionId}`}
        {...props}
        rootSessionId={parent}
        currentSessionId={props.lineageSessionId}
      />
      {!props.openTitle && (
        <CatalogDropdown
          key={props.lineageSessionId}
          {...props}
          displayTitle={undefined}
          rootSessionId={props.lineageSessionId}
        />
      )}
    </>
  )
}
