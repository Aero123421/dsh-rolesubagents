import { useEffect, useRef, useState } from 'react'
import type { ExternalRunDisplay, ExternalRunsResult } from '../shared/role-display.ts'
import { ROLE_DISPLAY_SERVICE_NAME } from '../shared/role-display.ts'
import { isCliId } from '../shared/cli/index.ts'
import { ROLE_ID_PATTERN } from '../shared/roles.ts'
import type { ConnectionLike, DshClientContext } from './dsh.ts'

export type GetExternalRuns = (parentSessionId: string, signal: AbortSignal) => Promise<ExternalRunsResult>
export const EXTERNAL_RUNS_ENDPOINT = `${ROLE_DISPLAY_SERVICE_NAME}/externalRuns`
const statuses = new Set(['running', 'succeeded', 'failed', 'cancelled', 'timeout'])

/** Treat remote metadata as data, and never render command output as HTML. */
function parseResult(value: unknown, parent: string): ExternalRunsResult {
  if (!value || typeof value !== 'object') throw new Error('external-runs-unavailable')
  const result = value as Record<string, unknown>
  if (!Array.isArray(result.runs) || result.runs.length > 100 || typeof result.durable !== 'boolean')
    throw new Error('external-runs-unavailable')
  const runs: ExternalRunDisplay[] = []
  for (const raw of result.runs) {
    if (!raw || typeof raw !== 'object') throw new Error('external-runs-unavailable')
    const run = raw as Record<string, unknown>
    if (
      typeof run.id !== 'string' ||
      run.id.length > 256 ||
      run.parentSessionId !== parent ||
      typeof run.roleId !== 'string' ||
      !ROLE_ID_PATTERN.test(run.roleId) ||
      !isCliId(run.cli) ||
      typeof run.label !== 'string' ||
      run.label.length > 1024 ||
      typeof run.status !== 'string' ||
      !statuses.has(run.status) ||
      typeof run.startedAt !== 'string' ||
      !Number.isFinite(Date.parse(run.startedAt)) ||
      (run.endedAt !== undefined && (typeof run.endedAt !== 'string' || !Number.isFinite(Date.parse(run.endedAt)))) ||
      (run.model !== undefined && (typeof run.model !== 'string' || run.model.length > 1024)) ||
      (run.resultText !== undefined && (typeof run.resultText !== 'string' || run.resultText.length > 16384)) ||
      (run.error !== undefined && (typeof run.error !== 'string' || run.error.length > 2048)) ||
      typeof run.resultTruncated !== 'boolean'
    )
      throw new Error('external-runs-unavailable')
    runs.push(raw as ExternalRunDisplay)
  }
  return { runs, durable: result.durable }
}

export function externalRunsCaller(ctx: Pick<DshClientContext, 'get'>): GetExternalRuns {
  return async (parentSessionId, signal) => {
    const connection = ctx.get?.('connection') as ConnectionLike | undefined
    if (!connection?.rpc?.call || signal.aborted) throw new Error('external-runs-unavailable')
    const controller = new AbortController()
    let stop: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        stop = () => {
          controller.abort()
          reject(new Error('external-runs-unavailable'))
        }
        signal.addEventListener('abort', stop, { once: true })
        timer = setTimeout(stop, 5000)
        if (signal.aborted) stop()
      })
      const pending = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error('external-runs-unavailable')
        return connection.rpc.call('/api', EXTERNAL_RUNS_ENDPOINT, { args: { parentSessionId } }, controller.signal)
      })
      const response = await Promise.race([pending, aborted])
      if (!response.ok) throw new Error('external-runs-unavailable')
      return parseResult(response.value, parentSessionId)
    } finally {
      clearTimeout(timer)
      if (stop) signal.removeEventListener('abort', stop)
    }
  }
}

export interface ExternalRunsParentState {
  /** Last successful result, including retained records when stale. */
  byId: Record<string, ExternalRunDisplay>
  loading: boolean
  /** Fixed transport/validation failure flag; never remote exception text. */
  error: boolean
  stale: boolean
  /** Null means no successful response, not a successful empty response. */
  fetchedAt: number | null
  durable: boolean
}

export interface ExternalRunsState {
  byParent: Record<string, ExternalRunsParentState>
  /** Compatibility aggregate; use byParent to classify individual records. */
  byId: Record<string, ExternalRunDisplay>
  unavailable: boolean
  loading: boolean
  durable: boolean
}

const MAX_PARENT_SCOPES = 100
const MAX_CONCURRENT_FETCHES = 4

function initialParents(
  ids: string[],
  available: boolean,
  retained?: ExternalRunsState['byParent'],
): ExternalRunsState['byParent'] {
  return Object.fromEntries(
    ids.map(id => [
      id,
      retained && Object.hasOwn(retained, id)
        ? retained[id]!
        : { byId: {}, loading: available, error: !available, stale: false, fetchedAt: null, durable: false },
    ]),
  )
}

/** Poll bounded requested scopes; abort on navigation/reset and never overlap polling rounds. */
export function useExternalRuns(
  parents: string[],
  getRuns?: GetExternalRuns,
  subscribeReset?: (listener: () => void) => () => unknown,
): ExternalRunsState {
  const [epoch, setEpoch] = useState(0)
  const pending = useRef<AbortController>()
  // Scopes outside this bound remain unknown to consumers, never an empty successful result.
  const key = JSON.stringify({ ids: [...new Set(parents)].sort().slice(0, MAX_PARENT_SCOPES), epoch })
  const [snapshot, setSnapshot] = useState<{
    epoch: number
    source: GetExternalRuns | undefined
    byParent: ExternalRunsState['byParent']
  }>()
  const retained = useRef<typeof snapshot>()
  useEffect(() => {
    const dispose = subscribeReset?.(() => {
      pending.current?.abort()
      retained.current = undefined
      setSnapshot(undefined)
      setEpoch(value => value + 1)
    })
    return () => {
      dispose?.()
    }
  }, [subscribeReset])
  useEffect(() => {
    const ids: string[] = JSON.parse(key).ids
    const controller = new AbortController()
    pending.current = controller
    const previous = retained.current
    let byParent = initialParents(
      ids,
      !!getRuns,
      previous?.epoch === epoch && previous.source === getRuns ? previous.byParent : undefined,
    )
    const publish = () => {
      if (controller.signal.aborted) return
      const next = { epoch, source: getRuns, byParent: { ...byParent } }
      retained.current = next
      setSnapshot(next)
    }
    publish()
    if (!getRuns || ids.length === 0) return () => controller.abort()
    let busy = false
    const load = async () => {
      if (busy || controller.signal.aborted) return
      busy = true
      byParent = Object.fromEntries(Object.entries(byParent).map(([id, state]) => [id, { ...state, loading: true }]))
      publish()
      let next = 0
      const worker = async () => {
        while (!controller.signal.aborted && next < ids.length) {
          const id = ids[next++]!
          try {
            const result = await getRuns(id, controller.signal)
            if (controller.signal.aborted) return
            byParent[id] = {
              byId: Object.fromEntries(result.runs.map(run => [run.id, run])),
              loading: false,
              error: false,
              stale: false,
              fetchedAt: Date.now(),
              durable: result.durable,
            }
          } catch {
            if (controller.signal.aborted) return
            const previous = byParent[id]!
            byParent[id] = { ...previous, loading: false, error: true, stale: previous.fetchedAt !== null }
          }
          // Publish each outcome independently: one failed parent cannot hide another's records.
          publish()
        }
      }
      try {
        await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_FETCHES, ids.length) }, worker))
      } finally {
        busy = false
      }
    }
    void load()
    const timer = setInterval(() => {
      void load()
    }, 5000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [key, getRuns, epoch])
  // Keep overlapping scopes, but never expose removed scopes or a preceding Host/source.
  const byParent = initialParents(
    JSON.parse(key).ids,
    !!getRuns,
    snapshot?.epoch === epoch && snapshot.source === getRuns ? snapshot.byParent : undefined,
  )
  const states = Object.values(byParent)
  return {
    byParent,
    byId: Object.fromEntries(states.flatMap(state => Object.entries(state.byId))),
    unavailable: !getRuns || states.some(state => state.error),
    loading: states.some(state => state.loading),
    durable: states.length > 0 && states.every(state => state.durable),
  }
}
