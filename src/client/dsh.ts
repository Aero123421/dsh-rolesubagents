/**
 * Structural views of the DSH client services this page uses. Only the members
 * we call are described, so the real Cordis context is assignable and tests can
 * pass small fakes. The browser bundle may only reach DSH through `ctx`.
 *
 * Each shape was read from the DSH sources:
 * - `configForms.get(entryId)`: packages/client/ui-settings/src/client/config-form.ts
 *   (returns the `ConfigForm` of config-form-types.ts).
 * - `remote.session.modelCatalog()`: packages/api/session-controller/src/types.ts (`ModelCatalog`).
 * - `remote.agentPresets.list()`: packages/preset/agent-preset-registry/src/types.ts (`AgentPresetRoster`).
 * - `slots.inject` / `slots.register`: packages/client/ui-slots/src/index.ts.
 */

import type { ComponentType } from 'react'
import type { CliId } from '../shared/cli/index.ts'

/** Id of this plugin's profile entry (`cordis.patch.yml`); also the settings namespace. */
export const ENTRY_ID = 'rolesubagents'

/** The npm package name; the key of this page in the Plugins page's `plugins.bundle.config` slot. */
export const PACKAGE_NAME = 'dsh-rolesubagents'

/** What every generated Remote method resolves to. */
export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** One path edit of a revision-fenced settings write. */
export type FormOp = { op: 'set'; path: string[]; value: unknown } | { op: 'unset'; path: string[] }

/** Sync state of one Host settings namespace. */
export interface FormSnapshot {
  /** `ready` while the Host serves the entry to this client. */
  readonly status: 'loading' | 'ready' | 'unavailable'
  /** The schema-resolved section (`{ enabled, roles }`), undefined before the first acceptance. */
  readonly value: unknown
  /** Whether the Host document accepts writes. */
  readonly writable: boolean
  /** Revision fencing the next write. */
  readonly revision: number | undefined
}

/** The shared configuration form of one Host entry. */
export interface ConfigFormLike {
  getSnapshot(): FormSnapshot
  subscribe(listener: () => void): () => void
  /** Apply the edits atomically; resolves false when the Host refused them. Transport failures reject. */
  mutate(ops: readonly FormOp[], expectedRevision?: number): Promise<boolean>
}

/** One adapter-owned reasoning effort. */
export interface CatalogEffort {
  readonly id: string
  readonly name: string
}

/** `remote.session.modelCatalog()` answer, reduced to what the page reads. */
export interface ModelCatalogLike {
  readonly groups: readonly {
    readonly id: string
    readonly name: string
    readonly models: readonly {
      readonly id: string
      readonly name: string
      readonly reasoning?: { readonly efforts: readonly CatalogEffort[]; readonly defaultEffort?: string }
    }[]
  }[]
  readonly failures: readonly unknown[]
}

/** `remote.agentPresets.list()` answer, reduced to what the page reads. */
export interface PresetRosterLike {
  readonly presets: readonly { readonly id: string; readonly name?: string; readonly broken?: string }[]
}

/** The Remote namespaces this page calls. Both are optional at runtime. */
export interface DshRemote {
  readonly session?: { modelCatalog(): Promise<RemoteResult<ModelCatalogLike>> }
  readonly agentPresets?: { list(): Promise<RemoteResult<PresetRosterLike>> }
  /** Subscribe to a forwarded Host event; returns the disposer. */
  $on(event: string, listener: () => void): () => unknown
}

/** One model a CLI listed in a connection test. */
export interface ProbeModelLike {
  readonly id: string
  readonly name?: string
  readonly efforts?: readonly string[]
}

/**
 * `rolesubagentsCli/probe` answer (the Host's `ProbeResult` in src/host/external/types.ts).
 * `message` is a fixed word: `subprocess-unavailable`, `not-found` or `probe-failed`.
 */
export interface ProbeResultLike {
  readonly cli: CliId
  readonly found: boolean
  readonly path?: string
  readonly version?: string
  readonly auth?: 'ok' | 'missing' | 'unknown'
  readonly models?: readonly ProbeModelLike[]
  readonly message?: string
}

/** Metadata-only Host check; no raw or interpolated role/config values are returned. */
export type RoleWriteSafetyLike =
  | { readonly safe: true; readonly revision: number; readonly reason: 'literal-role-settings' }
  | {
      readonly safe: false
      readonly revision?: number
      readonly reason: 'expression-backed-role-settings' | 'safety-unavailable' | 'revision-conflict'
    }

/**
 * The `connection` client service, reduced to its generic unary RPC caller
 * (packages/client/connection/src/rpc.ts `ClientConnectionRpc.call`). A failed
 * transport (e.g. HTTP 404 from a Host without the Gateway route) rejects.
 */
export interface ConnectionLike {
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RemoteResult<unknown>>
  }
}

export interface DshLocale {
  getLocale(): { readonly active: string }
  subscribe(listener: () => void): () => void
}

export interface DshSlots {
  inject(key: string, callback: () => (() => unknown) | undefined): void
  register<P>(options: Record<string, unknown>, component: ComponentType<P>): () => unknown
}

export interface DshClientContext {
  readonly slots: DshSlots
  readonly locale: DshLocale
  readonly remote: DshRemote
  readonly configForms: { get(entryId: string): ConfigFormLike }
  on(event: 'connection/reset', listener: () => void): () => unknown
  /**
   * Cordis' reflect mixin: reads a service that is not in `inject`, or undefined while
   * it is not provided. Used for the optional `connection` service (CLI connection test).
   */
  get?(name: string): unknown
  effect(execute: () => () => unknown, label?: string): unknown
}
