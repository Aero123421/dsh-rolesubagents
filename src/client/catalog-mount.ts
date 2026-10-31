import { EXTERNAL_RUN_STYLES } from './external-run-styles.ts'
import { CatalogAction, CatalogLineage } from './catalog.tsx'
import type { CatalogActions, CatalogAddress } from './catalog-types.ts'
import type { DshClientContext } from './dsh.ts'

/** The menu token can be translucent (GlassUI). Floating text-heavy panels need an
 * opaque backing: preserve its RGB but discard alpha; Canvas is the opaque fallback. */
const CSS = `
/* Scoped selectors override native button defaults without global !important rules. */
.dshrs-catalog{display:inline-flex;align-items:center;gap:4px;min-width:0}
.dshrs-catalog button,.dshrs-catalog-menu button{box-sizing:border-box;font:inherit;color:inherit;background:transparent;border:1px solid transparent;border-radius:var(--dsw-radius-md,8px);cursor:pointer;min-height:40px;min-width:40px;padding:6px 8px}
.dshrs-catalog .dshrs-catalog-trigger{display:inline-flex;align-items:center;gap:5px;white-space:nowrap;flex-shrink:0;font-size:12px;font-variant-numeric:tabular-nums}
.dshrs-catalog .dshrs-catalog-title{min-width:0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.dshrs-catalog button:hover,.dshrs-catalog button[aria-expanded=true],.dshrs-catalog-menu button:hover{background:var(--dsw-alias-interactive-bg-hover,#8882)}
.dshrs-catalog button:focus-visible,.dshrs-catalog-menu button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,Highlight);outline-offset:-2px}
.dshrs-catalog-signal[data-state=running],.dshrs-catalog-row[data-state=running] .dshrs-catalog-status{color:var(--dsw-alias-state-success-primary,inherit)}
.dshrs-catalog-signal[data-state=attention],.dshrs-catalog-row[data-state=failed] .dshrs-catalog-status,.dshrs-catalog-row[data-state=timeout] .dshrs-catalog-status{color:var(--dsw-alias-state-error-primary,inherit)}
.dshrs-catalog-menu{position:fixed;left:var(--catalog-left,8px);top:var(--catalog-top,8px);z-index:1000;width:384px;max-width:calc(100vw - 16px);max-height:min(472px,var(--catalog-max-height,472px));box-sizing:border-box;display:flex;flex-direction:column;overflow:hidden;background:Canvas;background:rgb(from var(--dsw-specific-menu,Canvas) r g b / 1);color:var(--dsw-alias-label-primary,CanvasText);border:1px solid var(--dsw-alias-border-l1,GrayText);border-radius:var(--dsw-radius-lg,14px);box-shadow:var(--dsw-elevation-prominent,0 8px 28px #0003);font-family:inherit;font-size:12px;line-height:1.4}
.dshrs-catalog-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,GrayText);flex-shrink:0}
.dshrs-catalog-heading strong{font-size:13px;font-weight:600}.dshrs-catalog-heading small{display:block;font-size:11px;color:var(--dsw-alias-label-secondary,GrayText);margin-top:3px}
.dshrs-catalog-scroll{padding:6px;overflow:auto;overscroll-behavior:contain;min-height:0}
.dshrs-catalog-menu h3{font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary,GrayText);margin:8px}
.dshrs-catalog-menu p{margin:8px;overflow-wrap:anywhere}.dshrs-catalog-list{list-style:none;margin:0;padding:0}.dshrs-catalog-list>li{margin:0;padding:0}
.dshrs-catalog-row{display:flex;align-items:center;min-width:0;border-radius:8px}
.dshrs-catalog-menu .dshrs-catalog-main{display:flex;align-items:center;text-align:start;gap:7px;flex:1;min-width:0;min-height:54px;padding:6px}
.dshrs-catalog-status{width:16px;flex-shrink:0;text-align:center;font-size:16px;font-weight:600}
.dshrs-catalog-copy{display:flex;flex-direction:column;gap:3px;flex:1;min-width:0}
.dshrs-catalog-label{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;font-weight:500;line-height:18px}
.dshrs-catalog-meta{display:flex;align-items:center;gap:5px;height:22px;white-space:nowrap;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary,GrayText)}
.dshrs-catalog-meta>span:last-child{overflow:hidden;text-overflow:ellipsis;min-width:0}
.dshrs-catalog-role{display:block;width:68px;flex:0 0 68px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dshrs-catalog-action{font-size:11px;color:var(--dsw-alias-label-secondary,GrayText);flex-shrink:0}.dshrs-catalog-aside{flex-shrink:0;font-size:18px}
.dshrs-catalog-menu .dshrs-catalog-main[aria-current=true]{background:var(--dsw-alias-interactive-bg-hover,#8882);border-color:var(--dsw-alias-border-l1,GrayText)}
.dshrs-catalog-menu .dshrs-catalog-main[aria-current=true] .dshrs-catalog-label{font-weight:600;color:var(--dsw-alias-label-primary,CanvasText)}
.dshrs-catalog-row[data-state=completed] .dshrs-catalog-label,.dshrs-catalog-row[data-state=completed] .dshrs-catalog-status{color:var(--dsw-alias-label-secondary,GrayText)}
.dshrs-catalog-menu .dshrs-catalog-branch{display:block;margin-left:23px;font-size:11px;color:var(--dsw-alias-label-secondary,GrayText)}
.dshrs-catalog-group{margin-left:12px;border-left:1px solid var(--dsw-alias-border-l1,GrayText);padding-left:4px}
.dshrs-catalog-menu .dshrs-catalog-history{display:block;width:100%;text-align:start;border-top:1px solid var(--dsw-alias-border-l1,GrayText);border-radius:0;margin-top:6px;font-size:12px}
.dshrs-catalog-menu .dshrs-catalog-retry{border-color:var(--dsw-alias-border-l1,GrayText);background:var(--dsw-alias-interactive-bg-hover,#8882)}
@media(max-width:640px){.dshrs-catalog-signal-label{display:none}.dshrs-catalog-menu{left:0;right:0;top:auto;bottom:0;width:100%;max-width:100%;max-height:72dvh;border-radius:20px 20px 0 0;padding-bottom:env(safe-area-inset-bottom,0px)}.dshrs-catalog button,.dshrs-catalog-menu button{min-height:44px;min-width:44px}.dshrs-catalog .dshrs-catalog-trigger{gap:4px;padding:6px}.dshrs-catalog .dshrs-catalog-title{max-width:120px}.dshrs-catalog-role{width:60px;flex-basis:60px}}
@media(prefers-reduced-motion:reduce){.dshrs-catalog *,.dshrs-catalog-menu *{animation:none;transition:none;scroll-behavior:auto}}
${EXTERNAL_RUN_STYLES}
`
interface Services {
  sessions: { refreshProjections(id: string): unknown }
  uiWorkspace: { openSession(address: CatalogAddress | string): unknown }
  sidebarRight: { openResource(address: string, options: { kind: string; preferNewPane: boolean }): unknown }
}

/** Register only while every navigation dependency is present; otherwise retain built-ins. */
export function mountCatalog(
  ctx: DshClientContext,
  options: Pick<CatalogActions, 'getRoles' | 'getExternalRuns'> = {},
): void {
  const install = (scope: DshClientContext) => {
    const service = <K extends keyof Services>(name: K): Services[K] | undefined => {
      try {
        return scope.get?.(name) as Services[K] | undefined
      } catch {
        return undefined
      }
    }
    // Public SlotRegistry declaration lookup; inspect only once the owner declares the seat.
    const slots = scope.slots as typeof scope.slots & {
      spec?: (key: string) => { kind: string; scope: string } | undefined
    }
    const supports = (key: string, kind: string) => {
      try {
        const spec = slots.spec?.(key)
        return spec?.kind === kind && spec.scope === 'session'
      } catch {
        return false
      }
    }
    const sessions = service('sessions')
    const workspace = service('uiWorkspace')
    const sidebar = service('sidebarRight')
    if (
      typeof sessions?.refreshProjections !== 'function' ||
      typeof workspace?.openSession !== 'function' ||
      typeof sidebar?.openResource !== 'function'
    )
      return
    const actions: CatalogActions = {
      ...options,
      getLocale: () => scope.locale.getLocale().active,
      subscribeLocale: listener => scope.locale.subscribe(listener),
      subscribeReset: listener => scope.on('connection/reset', listener),
      refreshProjection: id => {
        void sessions.refreshProjections(id)
      },
      openParent: id => {
        workspace.openSession(id)
      },
      openChild: address => {
        if (address.mode !== 'external') workspace.openSession(address)
      },
      openChildAside: address => {
        if (address.mode === 'external') return
        const query = new URLSearchParams({ parent: address.parentSessionId, mode: address.mode })
        sidebar.openResource(
          `dsh-resource://subagentchat/session/${encodeURIComponent(address.childSessionId)}?${query}`,
          { kind: 'subagentchat', preferNewPane: true },
        )
      },
    }
    scope.effect(() => {
      const style = document.createElement('style')
      style.dataset.pluginCss = 'dsh-rolesubagents/catalog'
      style.textContent = CSS
      document.head.append(style)
      return () => style.remove()
    }, 'rolesubagents: catalog styles')
    scope.slots.inject('conversation.session.header.actions', () =>
      supports('conversation.session.header.actions', 'list')
        ? scope.slots.register(
            {
              name: 'conversation.session.header.actions',
              id: 'subagent-catalog',
              order: 10,
              priority: -10,
              inject: () => actions,
            },
            CatalogAction,
          )
        : undefined,
    )
    scope.slots.inject('conversation.session.header.lineage', () =>
      supports('conversation.session.header.lineage', 'single')
        ? scope.slots.register(
            { name: 'conversation.session.header.lineage', priority: -10, inject: () => actions },
            CatalogLineage,
          )
        : undefined,
    )
  }
  const optional = ctx as DshClientContext & {
    inject?: (names: string[], callback: (scope: DshClientContext) => void) => unknown
  }
  if (typeof optional.inject === 'function') optional.inject(['sessions', 'uiWorkspace', 'sidebarRight'], install)
  else install(ctx)
}
