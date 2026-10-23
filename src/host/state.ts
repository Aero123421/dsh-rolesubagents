/**
 * Durable plugin state: the role list a Session was composed with and the
 * role a child was started as.
 *
 * Both live in a schema-validated KV storage domain (`rolesubagents`, one
 * `snapshots` and one `roles` table keyed by Session id), the Host's
 * sanctioned store for plugin-owned data. Reads are synchronous from the
 * domain's in-memory image; writes update that image through the domain's
 * write chain and are flushed before the plugin unloads.
 *
 * Why not Session-log records: `appendPluginRecord` from `@deepseek-ai/dsh-session`
 * is gated to the DSH repository's own experimental packages, and — because a
 * plugin installed into a profile resolves that package to a different module
 * instance than the Host's — its private brand check rejects every Host
 * Session (`Receiver must be an instance of class Session`). Log records
 * written by that path are therefore read back here as a legacy fallback, but
 * new state is never written to the log (a plain `session.append` of an
 * unknown type would also refuse to load on resume).
 *
 * When the storage service is unavailable the store degrades to memory only:
 * delegation keeps working for the life of the process, state is lost across
 * restarts, and the caller logs the degradation once.
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { normalizeSettings, type RoleDefinition, type RoleSettings } from '../shared/roles.ts'
import type { DomainPort, HostContext, SessionPort } from './ports.ts'

/** Storage domain holding this plugin's per-Session state. */
export const STATE_DOMAIN_NAME = 'rolesubagents'

/** Table of role-list snapshots, keyed by Session id. */
export const SNAPSHOTS_TABLE = 'snapshots'

/** Table of child roles, keyed by Session id. */
export const ROLES_TABLE = 'roles'

const snapshotRecord = z.object({ version: z.literal(1), settings: z.unknown() })
const roleRecord = z.object({ version: z.literal(1), role: z.unknown() })

/** The domain declaration this plugin opens at startup. */
export const STATE_DOMAIN = defineDomain({
  name: STATE_DOMAIN_NAME,
  version: 1,
  tables: {
    [SNAPSHOTS_TABLE]: domainTable(snapshotRecord),
    [ROLES_TABLE]: domainTable(roleRecord),
  },
})

/** Legacy Session-log record types, read back as a fallback but never written. */
export const ROLES_RECORD = 'plugin:dsh-rolesubagents/roles'
export const ROLE_RECORD = 'plugin:dsh-rolesubagents/role'

interface SnapshotRecord {
  version: 1
  settings: RoleSettings
}

interface RoleRecord {
  version: 1
  role: RoleDefinition
}

/**
 * Per-Session role state. Reads are synchronous; writes are durable once the
 * promise returned by {@link RoleState.flush} settles.
 */
export interface RoleState {
  /** True when no storage backend backs the store; state lives in memory only. */
  readonly degraded: boolean
  /** Why the store is degraded, for the startup warning. */
  readonly degradedReason: string | undefined
  /**
   * The role list recorded for a Session, normalized.
   * @param session - the Session to read.
   * @returns the snapshot, or undefined when the Session has none.
   */
  readSnapshot(session: SessionPort): RoleSettings | undefined
  /**
   * Record a Session's role list.
   * @param session - the Session to record for.
   * @param settings - the snapshot to store.
   */
  writeSnapshot(session: SessionPort, settings: RoleSettings): void
  /**
   * The role a child was started as.
   * @param session - the child's Session.
   * @returns the role, or undefined for Sessions this plugin did not start.
   */
  readRole(session: SessionPort): RoleDefinition | undefined
  /**
   * Record the role a child was started as.
   * @param session - the child's Session.
   * @param role - the role to store.
   */
  writeRole(session: SessionPort, role: RoleDefinition): void
  /** Settles when the storage domain is open (or the store has degraded to memory only). */
  readonly ready: Promise<void>
  /**
   * Wait for writes admitted through readiness, including writes another flush is waiting on.
   * Each flush acknowledges only its captured failures, after all captured writes settle;
   * consumers capturing the same write see the same failure, but a later rollback flush can succeed.
   */
  flush(): Promise<void>
  /** Flush outstanding writes and close the domain, if any. */
  close(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The newest legacy log record of one type, or undefined. */
function legacyRecord(session: SessionPort, type: string): unknown {
  let data: unknown
  for (const event of session.snapshotEvents()) {
    if (!isRecord(event) || event.type !== type) continue
    data = event.data
  }
  return data
}

function snapshotOf(data: unknown): RoleSettings | undefined {
  if (!isRecord(data) || data.version !== 1) return undefined
  return normalizeSettings(data.settings).settings
}

function roleOf(data: unknown): RoleDefinition | undefined {
  if (!isRecord(data) || data.version !== 1 || !isRecord(data.role)) return undefined
  return normalizeSettings({ enabled: true, roles: [data.role] }).settings.roles.find(
    entry => entry.id === (data.role as { id?: unknown }).id,
  )
}

/**
 * Create the role store over the Host's storage domain. The domain opens in
 * the background; until it is ready (and whenever it is unavailable) an
 * in-memory image serves reads and accepts writes, and a successful open
 * adopts writes already made.
 * @param ctx - the plugin's Host context (only `get('storageDomain')` and the logger are used).
 * @returns the store; call {@link RoleState.close} when the plugin unloads.
 */
export function createRoleState(ctx: HostContext): RoleState {
  const snapshots = new Map<string, SnapshotRecord>()
  const roles = new Map<string, RoleRecord>()
  // Successful writes are pruned immediately; failures live only until a covering flush acknowledges them.
  const pending = new Set<Promise<void>>()
  let domain: DomainPort | undefined
  let degraded = false
  let degradedReason: string | undefined
  let closing: Promise<void> | undefined

  const persist = (table: string, key: string, value: SnapshotRecord | RoleRecord): void => {
    if (domain === undefined) return
    const target = domain
    // Also track synchronous backend failures through the same flush contract.
    const write = Promise.resolve().then(() => target.table(table).put(key, value))
    pending.add(write)
    void write.then(
      () => pending.delete(write),
      error => {
        ctx.logger.warn(
          `rolesubagents: could not persist ${table} state for session ${key}: ${error instanceof Error ? error.message : String(error)}`,
        )
      },
    )
  }

  const ready = (async (): Promise<void> => {
    const facility = ctx.get('storageDomain')
    if (facility === undefined) {
      degraded = true
      degradedReason = 'the storageDomain service is not available'
      return
    }
    try {
      domain = await facility.open(STATE_DOMAIN)
      // Replay only writes admitted while opening, never the historical rows we load below.
      for (const [key, record] of snapshots) persist(SNAPSHOTS_TABLE, key, record)
      for (const [key, record] of roles) persist(ROLES_TABLE, key, record)
      for (const [key, value] of domain.table(SNAPSHOTS_TABLE).entries()) {
        if (!snapshots.has(key)) snapshots.set(key, value as SnapshotRecord)
      }
      for (const [key, value] of domain.table(ROLES_TABLE).entries()) {
        if (!roles.has(key)) roles.set(key, value as RoleRecord)
      }
    } catch (error) {
      degraded = true
      degradedReason = `the ${STATE_DOMAIN_NAME} storage domain could not be opened: ${error instanceof Error ? error.message : String(error)}`
    }
  })()

  const flush = async (): Promise<void> => {
    await ready
    const writes = [...pending]
    const results = await Promise.allSettled(writes)
    // Do not clear failures from writes admitted while this flush was waiting.
    for (const write of writes) pending.delete(write)
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }

  return {
    ready,
    get degraded() {
      return degraded
    },
    get degradedReason() {
      return degradedReason
    },
    readSnapshot(session) {
      return snapshotOf(snapshots.get(session.id)) ?? snapshotOf(legacyRecord(session, ROLES_RECORD))
    },
    writeSnapshot(session, settings) {
      if (closing) throw new Error('role state is closed')
      const record: SnapshotRecord = { version: 1, settings }
      snapshots.set(session.id, record)
      persist(SNAPSHOTS_TABLE, session.id, record)
    },
    readRole(session) {
      return roleOf(roles.get(session.id)) ?? roleOf(legacyRecord(session, ROLE_RECORD))
    },
    writeRole(session, role) {
      if (closing) throw new Error('role state is closed')
      const record: RoleRecord = { version: 1, role }
      roles.set(session.id, record)
      persist(ROLES_TABLE, session.id, record)
    },
    flush,
    close() {
      closing ??= (async () => {
        // Drain even failed writes before releasing the domain; their failures were logged above.
        await flush().catch(() => {})
        await domain?.close()
      })()
      return closing
    },
  }
}
