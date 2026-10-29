/** Bounded final-result metadata, not a CLI transcript. Never stores prompts, env or raw logs. */
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { CLI_IDS } from '../../shared/cli/index.ts'
import {
  MAX_EXTERNAL_RUNS,
  MAX_EXTERNAL_RUN_RESULT_LENGTH,
  type ExternalRunDisplay,
  type ExternalRunStatus,
} from '../../shared/role-display.ts'
import type { DomainPort, StorageDomainPort, SubagentResultPort } from '../ports.ts'

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const short = z.string().max(256)
const entrySchema = z.object({
  id: short,
  parentSessionId: short,
  roleId: short,
  cli: z.enum(CLI_IDS),
  model: short.optional(),
  label: z.string().max(512),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'timeout']),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().optional(),
  resultText: z.string().max(MAX_EXTERNAL_RUN_RESULT_LENGTH).optional(),
  resultTruncated: z.boolean(),
  error: z.string().max(4096).optional(),
})
const historySchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(MAX_EXTERNAL_RUNS) })
export const EXTERNAL_RUN_DOMAIN = defineDomain({
  name: 'rolesubagents_external_runs',
  version: 1,
  tables: { history: domainTable(historySchema) },
})

export function createExternalRunStore(storage: () => StorageDomainPort | undefined, now = () => Date.now()) {
  const entries = new Map<string, ExternalRunDisplay>()
  let domain: DomainPort | undefined
  let generation = 0
  let committedGeneration = -1
  let closed = false
  let chain = Promise.resolve()
  function prune() {
    const previousSize = entries.size
    for (const [id, entry] of entries) {
      if (Date.parse(entry.endedAt ?? entry.startedAt) < now() - RETENTION_MS) entries.delete(id)
    }
    const ordered = [...entries.values()].reverse().sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    for (const entry of ordered.slice(MAX_EXTERNAL_RUNS)) entries.delete(entry.id)
    if (entries.size === previousSize) return false
    generation++
    return true
  }
  const ready = (async () => {
    try {
      const facility = storage()
      if (!facility) return
      domain = await facility.open(EXTERNAL_RUN_DOMAIN)
      const parsed = historySchema.safeParse(domain.table('history').get('recent'))
      if (parsed.success) {
        for (const entry of parsed.data.entries) {
          if (entries.has(entry.id) || Date.parse(entry.endedAt ?? entry.startedAt) < now() - RETENTION_MS) continue
          entries.set(
            entry.id,
            entry.status === 'running'
              ? {
                  ...entry,
                  status: 'failed',
                  endedAt: new Date(now()).toISOString(),
                  error: 'Host restarted; final result unavailable.',
                }
              : entry,
          )
        }
      }
      generation++
      prune()
      const snapshotGeneration = generation
      await domain.table('history').put('recent', { version: 1, entries: [...entries.values()] })
      committedGeneration = snapshotGeneration
    } catch {
      committedGeneration = -1
    }
  })()
  function persist() {
    generation++
    chain = chain
      .then(async () => {
        await ready
        prune()
        if (!domain) return
        const snapshotGeneration = generation
        await domain.table('history').put('recent', { version: 1, entries: [...entries.values()] })
        committedGeneration = snapshotGeneration
      })
      .catch(() => {
        committedGeneration = -1
      })
  }
  return {
    ready,
    start(entry: Omit<ExternalRunDisplay, 'status' | 'resultTruncated'>) {
      if (closed) return
      const parsed = entrySchema.safeParse({ ...entry, status: 'running', resultTruncated: false })
      if (!parsed.success) return
      entries.set(entry.id, parsed.data)
      prune()
      persist()
    },
    finish(id: string, status: Exclude<ExternalRunStatus, 'running'>, result?: SubagentResultPort) {
      const entry = entries.get(id)
      if (closed || !entry || entry.status !== 'running') return
      // Accumulate at most the cap; never join an unbounded collection of output blocks.
      let text = ''
      let truncated = false
      for (const block of result?.output ?? []) {
        if (block.type !== 'text' || !block.text) continue
        const separator = text ? '\n\n' : ''
        const available = MAX_EXTERNAL_RUN_RESULT_LENGTH - text.length
        const piece = separator + block.text.slice(0, available + 1)
        if (piece.length > available) truncated = true
        text += piece.slice(0, available)
      }
      entries.set(id, {
        ...entry,
        status,
        endedAt: new Date(now()).toISOString(),
        ...(text ? { resultText: text } : {}),
        resultTruncated: truncated,
        ...(status === 'succeeded'
          ? {}
          : {
              error:
                status === 'timeout'
                  ? 'The run exceeded its time limit.'
                  : status === 'cancelled'
                    ? 'The run was cancelled.'
                    : 'The external run failed. See the parent completion notice for details.',
            }),
      })
      persist()
    },
    async list(parentSessionId: string) {
      await ready
      if (prune()) persist()
      return {
        runs: [...entries.values()]
          .filter(entry => entry.parentSessionId === parentSessionId)
          .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
          .map(entry => ({ ...entry })),
        durable: committedGeneration === generation,
      }
    },
    async close() {
      closed = true
      await ready
      await chain
      await domain?.close()
    },
    async flush() {
      await ready
      await chain
    },
  }
}
export type ExternalRunStore = ReturnType<typeof createExternalRunStore>
