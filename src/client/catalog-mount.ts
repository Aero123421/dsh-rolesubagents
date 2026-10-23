import { CatalogAction, CatalogLineage } from './catalog.tsx'
import type { CatalogActions, CatalogAddress, GetCatalogRoles } from './catalog-types.ts'
import type { DshClientContext } from './dsh.ts'

const CSS = `
.dshrs-catalog{display:inline-flex;min-width:0}.dshrs-catalog>button{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshrs-catalog button,.dshrs-catalog-menu button{font:inherit;color:inherit;background:transparent;border:0;border-radius:6px;cursor:pointer;padding:4px}
.dshrs-catalog-menu{position:fixed;z-index:1000;width:360px;max-width:calc(100vw - 16px);box-sizing:border-box;overflow:auto;padding:5px;background:var(--dsw-specific-menu,#fff);color:var(--dsw-alias-label-primary,#222);border:1px solid var(--dsw-alias-border-l1,#ddd);border-radius:10px;box-shadow:0 8px 28px #0003;font-size:12px}
.dshrs-catalog-row{display:flex;align-items:center;gap:6px;padding:7px 4px;border-radius:6px;cursor:pointer;min-width:0}.dshrs-catalog-row:hover{background:var(--dsw-alias-interactive-bg-hover,#8882)}.dshrs-catalog-row[aria-disabled=true]{cursor:default;opacity:.65}.dshrs-catalog-row:focus-visible,.dshrs-catalog button:focus-visible,.dshrs-catalog-menu button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#5267df);outline-offset:-2px}
.dshrs-catalog-row[aria-current=true]{background:var(--dsw-alias-interactive-bg-hover,#8882)}.dshrs-catalog-row[aria-current=true]>.dshrs-catalog-copy>.dshrs-catalog-label{font-weight:600}
.dshrs-catalog-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px}.dshrs-catalog-label{display:flex;align-items:center;gap:5px;flex-wrap:wrap;overflow-wrap:anywhere}.dshrs-catalog-copy small{color:var(--dsw-alias-label-tertiary,#777);overflow-wrap:anywhere}.dshrs-catalog-metrics{display:flex;flex-direction:column;align-items:flex-end;white-space:nowrap}.dshrs-catalog-group{min-width:0;margin:0 0 0 12px;padding:0;border:0;border-left:1px solid var(--dsw-alias-border-l1,#ddd);padding-left:4px}
`
interface Services {
  sessions: { refreshProjections(id: string): unknown }
  uiWorkspace: { openSession(address: CatalogAddress): unknown }
  sidebarRight: { openResource(address: string, options: { kind: string; preferNewPane: boolean }): unknown }
}

/** Register only while every navigation dependency is present; otherwise retain built-ins. */
export function mountCatalog(ctx: DshClientContext, options: { getRoles?: GetCatalogRoles } = {}): void {
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
