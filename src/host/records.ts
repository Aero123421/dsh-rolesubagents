/**
 * Durable plugin state kept in Session logs as `plugin:` records (DSH's
 * ignorable extension records: unknown to older readers, carried through fork
 * and resume). Two records exist:
 *
 * - `roles`: the role list a Session was composed with. Written once when the
 *   Session first meets this plugin, so its tool schema stays stable for the
 *   whole Session even after the settings change.
 * - `role`: the role a child was started as. Written into the child's own log
 *   before its first request; the runtime context and resume read it back.
 */

import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import { normalizeSettings, type RoleDefinition, type RoleSettings } from '../shared/roles.ts'
import type { SessionPort } from './ports.ts'

export const ROLES_RECORD = 'plugin:dsh-rolesubagents/roles'
export const ROLE_RECORD = 'plugin:dsh-rolesubagents/role'

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    'plugin:dsh-rolesubagents/roles': { version: 1; settings: RoleSettings }
    'plugin:dsh-rolesubagents/role': { version: 1; role: RoleDefinition }
  }
}

type AnySession = Parameters<typeof appendPluginRecord>[0]

/** Read the newest record of one type, or undefined. */
function latest(session: SessionPort, type: string): unknown {
  let data: unknown
  for (const event of session.snapshotEvents()) {
    const record = pluginRecordOf(event as Parameters<typeof pluginRecordOf>[0])
    if (record?.type === type) data = record.data
  }
  return data
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The role list recorded in a Session, normalized.
 * @param session - the Session to read.
 * @returns the snapshot, or undefined when the Session has none.
 */
export function readRolesSnapshot(session: SessionPort): RoleSettings | undefined {
  const data = latest(session, ROLES_RECORD)
  if (!isRecord(data) || data.version !== 1) return undefined
  return normalizeSettings(data.settings).settings
}

/**
 * The role a child was started as.
 * @param session - the child's Session.
 * @returns the role, or undefined for Sessions this plugin did not start.
 */
export function readRole(session: SessionPort): RoleDefinition | undefined {
  const data = latest(session, ROLE_RECORD)
  if (!isRecord(data) || data.version !== 1 || !isRecord(data.role)) return undefined
  const role = normalizeSettings({ enabled: true, roles: [data.role] }).settings.roles.find(
    entry => entry.id === (data.role as { id?: unknown }).id,
  )
  return role
}

export function writeRolesSnapshot(session: SessionPort, settings: RoleSettings): void {
  appendPluginRecord(session as unknown as AnySession, ROLES_RECORD, { version: 1, settings })
}

export function writeRole(session: SessionPort, role: RoleDefinition): void {
  appendPluginRecord(session as unknown as AnySession, ROLE_RECORD, { version: 1, role })
}
