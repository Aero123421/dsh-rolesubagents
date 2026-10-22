/** Read-only browser metadata; deliberately excludes the full role configuration. */
import type { BuiltinRole } from './roles.ts'

export const ROLE_DISPLAY_SERVICE_NAME = 'rolesubagentsRoleDisplay'
export const MAX_ROLE_DISPLAY_CHILD_IDS = 100
export const MAX_ROLE_DISPLAY_CHILD_ID_LENGTH = 256

export interface RoleDisplay {
  readonly roleId: string
  /** RoleDefinition has no separate display name; this is its id, not its description. */
  readonly displayName: string
  readonly builtin?: BuiltinRole
}

/** One entry per requested id, in order (including duplicates); null means no known role. */
export type RoleDisplayResult = (RoleDisplay | null)[]
