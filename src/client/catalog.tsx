import { useCallback, useSyncExternalStore, useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { RoleBadge } from './RoleBadge.tsx'
import type { CatalogActions, CatalogHooks, CatalogLineageProps, CatalogProps, CatalogRole } from './catalog-types.ts'

const defaultLocale = () => 'en'
const noSubscription = () => () => {}

/** No permanent negative cache: metadata can arrive after a catalog entry. */
function useRoles(ids: string[], active: boolean, actions: CatalogActions) {
  const [roles, setRoles] = useState<Record<string, CatalogRole>>({})
  const [epoch, setEpoch] = useState(0)
  const key = JSON.stringify({ ids, epoch })
  useEffect(() => {
    const dispose = actions.subscribeReset?.(() => {
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
    let inFlight = false
    const load = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const result = await actions.getRoles?.(requested, controller.signal)
        if (!controller.signal.aborted && result) setRoles(result)
      } catch {
        /* Missing optional host metadata must not disable navigation. */
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
  const [now, setNow] = useState(Date.now)
  const [position, setPosition] = useState({ left: 8, top: 8, maxHeight: 400 })
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>()
  const pinned = useRef(false)
  const cancelHover = useCallback(() => {
    clearTimeout(hoverTimer.current)
  }, [])
  useEffect(() => cancelHover, [cancelHover])
  const catalog = state.projectionsBySession[rootSessionId]
  const entries = catalog?.values.subagentCatalog ?? []
  const running = (id: string) => statuses.get(id)?.running ?? state.byId[id]?.running ?? false
  const roles = useRoles(
    [
      ...new Set(
        [rootSessionId, ...expanded].flatMap(
          id => state.projectionsBySession[id]?.values.subagentCatalog?.map(e => e.id) ?? [],
        ),
      ),
    ],
    open,
    props,
  )
  const close = useCallback(
    (focus = false) => {
      cancelHover()
      pinned.current = false
      setOpen(false)
      setExpanded(new Set())
      if (focus) trigger.current?.focus()
    },
    [cancelHover],
  )
  const visible = displayTitle !== undefined || entries.length > 0 || catalog?.state === 'error'
  useEffect(() => {
    if (!visible && open) close()
  }, [visible, open, close])
  const leave = () => {
    cancelHover()
    if (!pinned.current) hoverTimer.current = setTimeout(() => close(), 150)
  }
  useEffect(() => {
    if (!open) return
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect()
      if (rect)
        setPosition({
          left: Math.max(8, Math.min(rect.left, window.innerWidth - 368)),
          top: Math.min(rect.bottom + 4, window.innerHeight - 100),
          maxHeight: Math.max(80, window.innerHeight - rect.bottom - 16),
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
    place()
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', place)
    document.addEventListener('scroll', place, true)
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', place)
      document.removeEventListener('scroll', place, true)
      clearInterval(timer)
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
  const items = () =>
    Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="treeitem"]:not([aria-disabled="true"])') ?? [])
  const focusItem = (last = false) => {
    const list = items()
    ;(last ? list.at(-1) : list[0])?.focus()
  }
  const navigate = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    const list = items()
    const index = list.indexOf(document.activeElement as HTMLElement)
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
  const rows = (parent: string, ancestors: Set<string>, level = 1): React.ReactNode => {
    const projection = state.projectionsBySession[parent]
    const children = projection?.values.subagentCatalog ?? []
    return (
      <>
        {(!projection || (projection.state === 'loading' && !children.length)) && (
          <p role="status">{text('Loading subagents…', 'サブエージェントを読み込み中…')}</p>
        )}
        {projection?.state === 'error' && (
          <p role="alert">
            {projection.error?.message ?? text('Unable to load subagents.', 'サブエージェントを読み込めません。')}{' '}
            <button type="button" onClick={() => props.refreshProjection(parent)}>
              {text('Retry', '再試行')}
            </button>
          </p>
        )}
        {projection?.state === 'migration-required' && !children.length && (
          <p>{text('Open this session to update its history.', 'このセッションを開いて履歴を更新してください。')}</p>
        )}
        {children.map(entry => {
          const summary = state.byId[entry.id]
          const child = state.projectionsBySession[entry.id]
          const external = entry.mode === 'external'
          const branch =
            !external &&
            !ancestors.has(entry.id) &&
            summary?.formatStatus !== 'migration-required' &&
            child?.state !== 'migration-required' &&
            !(child?.values.subagentCatalog?.length === 0 && child.state !== 'loading' && child.state !== 'error')
          const isExpanded = branch && expanded.has(entry.id)
          const label = entry.label ?? entry.id
          const address = { parentSessionId: parent, childSessionId: entry.id, mode: entry.mode }
          const activity = external
            ? text('External', '外部')
            : running(entry.id)
              ? text('Running', '実行中')
              : summary?.projectionValues?.subagentTiming?.lastTurnCompleted
                ? text('Completed', '完了')
                : text('Inactive', '待機中')
          const usage = summary?.projectionValues?.tokenUsage
          const tokens =
            usage && usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
          const timing = summary?.projectionValues?.subagentTiming
          const duration =
            timing &&
            timing.settledMs +
              (timing.active ? Math.max(0, (running(entry.id) ? now : timing.active.through) - timing.active.since) : 0)
          const openChild = () => {
            if (!external) {
              props.openChild(address)
              close()
            }
          }
          const role = roles[entry.id]
          return (
            <div key={entry.id}>
              <div
                className="dshrs-catalog-row"
                role="treeitem"
                tabIndex={external ? -1 : 0}
                aria-disabled={external || undefined}
                aria-level={level}
                aria-current={entry.id === currentSessionId || undefined}
                aria-expanded={branch ? isExpanded : undefined}
                aria-label={[
                  label,
                  activity,
                  role?.displayName,
                  tokens === undefined ? undefined : `${tokens} ${text('tokens', 'トークン')}`,
                  duration === undefined
                    ? undefined
                    : `${Math.floor(duration / 1000)} ${text('seconds active', '秒稼働')}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
                onClick={openChild}
                onKeyDown={event => {
                  if (event.target !== event.currentTarget) return
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    event.stopPropagation()
                    openChild()
                  }
                  if (
                    (event.key === 'ArrowRight' && branch && !isExpanded) ||
                    (event.key === 'ArrowLeft' && isExpanded)
                  ) {
                    event.preventDefault()
                    event.stopPropagation()
                    toggle(entry.id)
                  }
                }}
              >
                {branch && (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={`${isExpanded ? text('Collapse', '折りたたむ') : text('Expand', '展開')} ${label}`}
                    onClick={event => {
                      event.stopPropagation()
                      toggle(entry.id)
                    }}
                  >
                    {isExpanded ? '⌄' : '›'}
                  </button>
                )}
                <span aria-hidden="true" style={{ color: running(entry.id) ? '#25a56a' : undefined }}>
                  ●
                </span>
                <span className="dshrs-catalog-copy">
                  <span className="dshrs-catalog-label">
                    {label}
                    {role && <RoleBadge roleId={role.roleId} />}
                  </span>
                  <small>
                    {[
                      summary?.title,
                      entry.mode === 'continuable'
                        ? text('Continuable', '継続可能')
                        : entry.mode === 'one-shot'
                          ? text('One-shot', '単発')
                          : entry.mode === 'unknown'
                            ? text('Unknown mode', '不明')
                            : text('External', '外部'),
                      activity,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </small>
                </span>
                <small className="dshrs-catalog-metrics">
                  {tokens !== undefined && (
                    <span>
                      {new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(tokens)}{' '}
                      {text('tokens', 'トークン')}
                    </span>
                  )}
                  {duration !== undefined && (
                    <span title={`${Math.floor(duration / 1000)} ${text('seconds active', '秒稼働')}`}>
                      {Math.floor(duration / 60000)}:{String(Math.floor(duration / 1000) % 60).padStart(2, '0')}
                    </span>
                  )}
                </small>
                {!external && entry.id !== currentSessionId && (
                  <button
                    type="button"
                    aria-label={ja ? `${label}をサイドバーで開く` : `Open ${label} in sidebar`}
                    onKeyDown={event => {
                      if (event.key !== 'Escape') event.stopPropagation()
                    }}
                    onClick={event => {
                      event.stopPropagation()
                      props.openChildAside(address)
                      close()
                    }}
                  >
                    ↗
                  </button>
                )}
              </div>
              {isExpanded && (
                <fieldset className="dshrs-catalog-group">
                  {rows(entry.id, new Set([...ancestors, entry.id]), level + 1)}
                </fieldset>
              )}
            </div>
          )
        })}
      </>
    )
  }
  if (!visible) return null
  const title = entries.find(e => e.id === currentSessionId)?.label ?? displayTitle
  return (
    <span className="dshrs-catalog">
      <button
        type="button"
        ref={trigger}
        onMouseLeave={leave}
        aria-haspopup="tree"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          cancelHover()
          pinned.current = true
          if (openTitle) {
            close()
            openTitle()
          } else {
            setOpen(true)
            if (!open) props.refreshProjection(rootSessionId)
          }
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            setOpen(true)
            props.refreshProjection(rootSessionId)
            setTimeout(() => focusItem(event.key === 'ArrowUp'), 0)
          } else if (event.key === 'Escape') close(true)
        }}
        onMouseEnter={() => {
          cancelHover()
          if (!open)
            hoverTimer.current = setTimeout(() => {
              setOpen(true)
              props.refreshProjection(rootSessionId)
            }, 150)
        }}
      >
        {title ??
          (ja
            ? `サブエージェント ${entries.length}件`
            : `${entries.length} subagent${entries.length === 1 ? '' : 's'}`)}
        {entries.some(e => running(e.id)) && (
          <span role="img" aria-label={text('Running', '実行中')}>
            {' '}
            •
          </span>
        )}{' '}
        ⌄
      </button>
      {open &&
        createPortal(
          <div
            id={menuId}
            ref={menu}
            className="dshrs-catalog-menu"
            style={position}
            role="tree"
            aria-label={text('Subagents', 'サブエージェント')}
            onKeyDown={navigate}
            onMouseEnter={cancelHover}
            onMouseLeave={leave}
          >
            {rows(rootSessionId, new Set([rootSessionId]))}
          </div>,
          document.body,
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
