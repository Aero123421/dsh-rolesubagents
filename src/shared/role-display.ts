/** Read-only browser metadata; deliberately excludes the full role configuration. */
import type { BuiltinRole } from './roles.ts'
import type { CliId } from './cli/index.ts'

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

/** Global retained ring; final answer limit is UTF-16 code units, not raw logs. */
export const MAX_EXTERNAL_RUNS = 100
export const MAX_EXTERNAL_RUN_RESULT_LENGTH = 16_384
export type ExternalRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timeout'
export interface ExternalRunDisplay {
  readonly id: string
  readonly parentSessionId: string
  readonly roleId: string
  readonly cli: CliId
  /** Configured model; omitted when the CLI chooses its default. */
  readonly model?: string
  readonly label: string
  readonly status: ExternalRunStatus
  readonly startedAt: string
  readonly endedAt?: string
  readonly resultText?: string
  readonly resultTruncated: boolean
  /** Fixed safe diagnostic only, never stderr or thrown exception text. */
  readonly error?: string
}
export interface ExternalRunsResult {
  readonly runs: readonly ExternalRunDisplay[]
  readonly durable: boolean
}
