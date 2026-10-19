/** Fakes of the DSH services the client reads, shared by the client tests. */

import { vi } from 'vitest'
import type {
  ConfigFormLike,
  DshRemote,
  FormOp,
  FormSnapshot,
  ModelCatalogLike,
  PresetRosterLike,
  RemoteResult,
} from '../src/client/dsh.ts'
import type { ProbeCall } from '../src/client/controller.ts'
import type { CliId } from '../src/shared/cli/index.ts'
import { DEFAULT_ROLES } from '../src/shared/roles.ts'

export const ok = <T>(value: T): RemoteResult<T> => ({ ok: true, value })
export const fail = (code: string): RemoteResult<never> => ({ ok: false, error: { code, message: code } })

export interface FakeForm {
  form: ConfigFormLike
  /** Every mutate call, in order. */
  calls: { ops: readonly FormOp[]; revision: number | undefined }[]
  /** Replace parts of the snapshot and notify, as the Host mirror does. */
  set(patch: Partial<FormSnapshot>): void
  /** How the next mutate answers: it applies the ops, is refused, or fails in transport. */
  outcome: 'accept' | 'refuse' | 'throw'
  /** Called when a mutate is refused, to emulate the recovery read that follows a refusal. */
  onRefuse?: () => void
  /** When set, mutate waits for this promise before answering. */
  gate?: Promise<void>
  listeners: Set<() => void>
}

export function fakeForm(initial: Partial<FormSnapshot> = {}): FakeForm {
  let snapshot: FormSnapshot = {
    status: 'ready',
    value: { enabled: true, roles: structuredClone(DEFAULT_ROLES) },
    writable: true,
    revision: 1,
    ...initial,
  }
  const listeners = new Set<() => void>()
  const set = (patch: Partial<FormSnapshot>): void => {
    snapshot = { ...snapshot, ...patch }
    for (const listener of [...listeners]) listener()
  }
  const fake: FakeForm = {
    calls: [],
    listeners,
    outcome: 'accept',
    set,
    form: {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      async mutate(ops, revision) {
        fake.calls.push({ ops, revision })
        if (fake.gate !== undefined) await fake.gate
        if (fake.outcome === 'throw') throw new Error('network down')
        if (fake.outcome === 'refuse') {
          fake.onRefuse?.()
          return false
        }
        const value: Record<string, unknown> = { ...(snapshot.value as Record<string, unknown>) }
        for (const op of ops) if (op.op === 'set') value[op.path[0] ?? ''] = structuredClone(op.value)
        set({ value, revision: (snapshot.revision ?? 0) + 1 })
        return true
      },
    },
  }
  return fake
}

export const CATALOG: ModelCatalogLike = {
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-v4-flash',
          name: 'V4 Flash',
          reasoning: {
            efforts: [
              { id: 'high', name: 'High' },
              { id: 'max', name: 'Max' },
            ],
            defaultEffort: 'high',
          },
        },
        { id: 'deepseek-v4-pro', name: 'V4 Pro' },
      ],
    },
    { id: 'other', name: 'Other', models: [{ id: 'o1', name: 'O1' }] },
  ],
  failures: [],
}

export const PRESETS: PresetRosterLike = {
  presets: [
    { id: 'ptc', name: 'PTC' },
    { id: 'minimal' },
    { id: 'broken-one', name: 'Broken', broken: 'cannot compose' },
  ],
}

export interface FakeRemote extends DshRemote {
  session: { modelCatalog: ReturnType<typeof vi.fn<() => Promise<RemoteResult<ModelCatalogLike>>>> }
  agentPresets: { list: ReturnType<typeof vi.fn<() => Promise<RemoteResult<PresetRosterLike>>>> }
  $on: ReturnType<typeof vi.fn<(event: string, listener: () => void) => () => void>>
}

export function fakeRemote(): FakeRemote {
  return {
    session: { modelCatalog: vi.fn(async () => ok(CATALOG)) },
    agentPresets: { list: vi.fn(async () => ok(PRESETS)) },
    $on: vi.fn(() => () => {}),
  }
}

/** A probe answer as the Host's `rolesubagentsCli/probe` gives it. */
export function probeAnswer(cli: CliId, patch: Record<string, unknown> = {}) {
  return ok({ cli, found: true, path: `/usr/local/bin/${cli}`, version: '1.2.3', auth: 'ok', ...patch })
}

/** A connection test that answers like a Host with the probe service. */
export function fakeProbe() {
  return vi.fn<ProbeCall>(async cli => probeAnswer(cli))
}
