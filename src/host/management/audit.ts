/** Bounded metadata-only audit. Profile persistence and audit storage are deliberately not one transaction. */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import type { DomainPort, StorageDomainPort } from '../ports.ts'

export interface ManagementAuditEntry {
  readonly id: string
  readonly at: string
  readonly sessionId: string
  readonly agentId: string
  readonly operation: 'roles-change' | 'apply-current'
  readonly roleIds: readonly string[]
  readonly fields: readonly string[]
  readonly baseRevision: number
  readonly observedRevision: number
}
const entrySchema = z.object({
  id: z.string(),
  at: z.string(),
  sessionId: z.string(),
  agentId: z.string(),
  operation: z.enum(['roles-change', 'apply-current']),
  roleIds: z.array(z.string()).max(32),
  fields: z.array(z.string()).max(64),
  baseRevision: z.number().int().nonnegative(),
  observedRevision: z.number().int().nonnegative(),
})
export const MANAGEMENT_AUDIT_DOMAIN = defineDomain({
  name: 'rolesubagents_management',
  version: 1,
  tables: { history: domainTable(z.object({ version: z.literal(1), entries: z.array(entrySchema).max(100) })) },
})
export function createManagementAudit(storage: () => StorageDomainPort | undefined) {
  let entries: ManagementAuditEntry[] = []
  let domain: DomainPort | undefined
  let opening: Promise<void> | undefined
  let closed = false
  let durable = false
  let chain = Promise.resolve()
  function open(): Promise<void> {
    opening ??= (async () => {
      try {
        const facility = storage()
        if (!facility || closed) return
        domain = await facility.open(MANAGEMENT_AUDIT_DOMAIN)
        if (closed) {
          await domain.close()
          domain = undefined
          return
        }
        const stored = domain.table('history').get('recent')
        const parsed = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(100) }).safeParse(stored)
        if (parsed.success) entries = parsed.data.entries
        durable = true
      } catch {
        durable = false
      }
    })()
    return opening
  }
  return {
    async list() {
      await open()
      return { entries: entries.slice(-20), durable }
    },
    async append(entry: ManagementAuditEntry): Promise<boolean> {
      const write = chain.then(async () => {
        await open()
        entries = [...entries, entry].slice(-100)
        if (!domain || closed) {
          durable = false
          return
        }
        try {
          await domain.table('history').put('recent', { version: 1, entries })
          durable = true
        } catch {
          durable = false
        }
      })
      chain = write.catch(() => {
        durable = false
      })
      await chain
      return durable
    },
    async close() {
      closed = true
      await chain
      await opening
      await domain?.close()
    },
  }
}
export type ManagementAudit = ReturnType<typeof createManagementAudit>
