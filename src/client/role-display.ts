import { MAX_ROLE_DISPLAY_CHILD_IDS, ROLE_DISPLAY_SERVICE_NAME, type RoleDisplay } from '../shared/role-display.ts'
import { ROLE_ID_PATTERN } from '../shared/roles.ts'
import type { ConnectionLike, DshClientContext } from './dsh.ts'

export const ROLE_DISPLAY_ENDPOINT = `${ROLE_DISPLAY_SERVICE_NAME}/query`
export type DisplayRole = RoleDisplay

/** UI-only lookup. Missing/older Host APIs must not break ordinary catalog rows. */
export function roleDisplayCaller(ctx: Pick<DshClientContext, 'get'>) {
  return async (childIds: readonly string[], signal: AbortSignal): Promise<Record<string, DisplayRole>> => {
    const roles: Record<string, DisplayRole> = Object.create(null)
    if (signal.aborted || childIds.length === 0) return roles
    try {
      const connection = ctx.get?.('connection') as ConnectionLike | undefined
      if (typeof connection?.rpc?.call !== 'function') return roles
      const uniqueIds = [...new Set(childIds)]
      for (let offset = 0; offset < uniqueIds.length; offset += MAX_ROLE_DISPLAY_CHILD_IDS) {
        if (signal.aborted) return Object.create(null)
        const batch = uniqueIds.slice(offset, offset + MAX_ROLE_DISPLAY_CHILD_IDS)
        const result = await connection.rpc.call('/api', ROLE_DISPLAY_ENDPOINT, { args: { childIds: batch } }, signal)
        if (signal.aborted) return Object.create(null)
        if (!result.ok || !Array.isArray(result.value) || result.value.length !== batch.length) continue
        for (let index = 0; index < batch.length; index++) {
          const value: unknown = result.value[index]
          if (typeof value !== 'object' || value === null) continue
          const roleId = (value as Record<string, unknown>).roleId
          if (typeof roleId !== 'string' || !ROLE_ID_PATTERN.test(roleId)) continue
          // Today the canonical visible name is the role id, not its prompt description.
          roles[batch[index]!] = { roleId, displayName: roleId }
        }
      }
    } catch {
      // Unavailable service/transport is a decoration failure, not a catalog failure.
    }
    return signal.aborted ? Object.create(null) : roles
  }
}
