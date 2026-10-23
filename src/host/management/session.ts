/** Catalog identity excludes unrelated workflow/CLI defaults and never mutates a child role record. */
import { createHash } from 'node:crypto'
import type { RoleSettings } from '../../shared/roles.ts'
export function roleCatalogRevision(snapshot: Pick<RoleSettings, 'enabled' | 'roles'>): string {
  return createHash('sha256')
    .update(JSON.stringify({ enabled: snapshot.enabled, roles: snapshot.roles }))
    .digest('hex')
}
