import type { CatalogSummary } from './catalog-types.ts'
import type { ExternalRunDisplay } from '../shared/role-display.ts'

export type CatalogActivity =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timeout'
  | 'cancelled'
  | 'stopped'
  | 'unknown'
  | 'loading'
  | 'stale'
  | 'missing'
  | 'unavailable'
  | 'migration'

/** Missing evidence never means idle, failed, or successfully completed. */
export function nativeActivity(summary: CatalogSummary | undefined, running: boolean | undefined): CatalogActivity {
  if (running === true) return 'running'
  if (summary?.projectionValues?.subagentTiming?.lastTurnCompleted === true) return 'completed'
  if (running === false && summary?.projectionValues?.subagentTiming?.lastTurnCompleted === false) return 'stopped'
  return 'unknown'
}

export function externalActivity(
  run: ExternalRunDisplay | undefined,
  scope:
    | {
        loading: boolean
        error: boolean
        stale: boolean
        fetchedAt: number | null
      }
    | undefined,
): CatalogActivity {
  if (scope?.stale) return 'stale'
  if (scope?.error) return 'unavailable'
  if (!scope || scope.fetchedAt === null) return 'loading'
  if (!run) return 'missing'
  return run.status === 'succeeded' ? 'completed' : run.status
}

export function activityLabel(activity: CatalogActivity, ja: boolean): string {
  const labels: Record<CatalogActivity, [string, string]> = {
    running: ['Running', '実行中'],
    completed: ['Completed', '完了'],
    failed: ['Failed', '失敗'],
    timeout: ['Timed out', '時間切れ'],
    cancelled: ['Cancelled', 'キャンセル'],
    stopped: ['Stopped · details unknown', '停止 · 詳細不明'],
    unknown: ['Status unknown', '状態不明'],
    loading: ['Loading status…', '状態を取得中…'],
    stale: ['Stale · last known', '更新停止 · 最終取得時'],
    missing: ['Record unavailable', '記録なし'],
    unavailable: ['Status unavailable', '状態を取得できません'],
    migration: ['Migration required', '履歴の更新が必要'],
  }
  return labels[activity][ja ? 1 : 0]
}
export function activitySymbol(activity: CatalogActivity): string {
  if (activity === 'running' || activity === 'loading') return '◌'
  if (activity === 'completed') return '✓'
  if (activity === 'failed' || activity === 'timeout') return '!'
  if (activity === 'cancelled' || activity === 'stopped') return '⊘'
  if (activity === 'migration' || activity === 'stale') return '↻'
  return '?'
}
export const isHistory = (activity: CatalogActivity) => activity === 'completed' || activity === 'cancelled'
export const isAttention = (activity: CatalogActivity) =>
  ['failed', 'timeout', 'stopped', 'migration'].includes(activity)
export const isIncomplete = (activity: CatalogActivity) =>
  ['unknown', 'loading', 'stale', 'missing', 'unavailable'].includes(activity)
