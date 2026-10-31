import type { DshClientContext } from './dsh.ts'
import type { GetExternalRuns } from './external-runs.ts'

/** Structural slot props verified against installed ui-subagent's runtime/types. */
export interface CatalogEntry {
  id: string
  label?: string
  mode: 'external' | 'unknown' | 'one-shot' | 'continuable'
}
export interface CatalogAddress {
  parentSessionId: string
  childSessionId: string
  mode: CatalogEntry['mode']
}
export interface CatalogSummary {
  origin?: string
  parentId?: string
  title?: string
  running?: boolean
  formatStatus?: string
  projectionValues?: {
    tokenUsage?: {
      uncachedInputTokens: number
      outputTokens: number
      cacheReadTokens: number
      cacheWriteTokens: number
    }
    subagentTiming?: { settledMs: number; active?: { since: number; through: number }; lastTurnCompleted?: boolean }
  }
}
export interface CatalogProjection {
  state: string
  error?: { message: string } | null
  values: { subagentCatalog?: CatalogEntry[] }
}
export interface CatalogState {
  byId: Record<string, CatalogSummary>
  projectionsBySession: Record<string, CatalogProjection>
}
export type SelectorHook<S> = <T>(selector: (state: S) => T) => T
export interface CatalogHooks {
  useSessions: SelectorHook<CatalogState>
  useSessionStatus: SelectorHook<ReadonlyMap<string, { running?: boolean }>>
}
export interface CatalogRole {
  roleId: string
  displayName: string
}
export type GetCatalogRoles = (ids: string[], signal: AbortSignal) => Promise<Record<string, CatalogRole>>
export interface CatalogActions {
  getLocale?: () => string
  subscribeLocale?: (listener: () => void) => () => void
  openParent?(sessionId: string): void
  openChild(address: CatalogAddress): void
  openChildAside(address: CatalogAddress): void
  refreshProjection(id: string): void
  getRoles?: GetCatalogRoles
  getExternalRuns?: GetExternalRuns
  subscribeReset?: (listener: () => void) => () => unknown
}
export interface CatalogProps extends CatalogHooks, CatalogActions {
  sessionId: string
}
export interface CatalogLineageProps extends CatalogProps {
  lineageSessionId: string
  displayTitle: string
  openTitle?: () => void
  useSession: SelectorHook<{ subagent?: { address: CatalogAddress } }>
}
export type CatalogContext = DshClientContext
