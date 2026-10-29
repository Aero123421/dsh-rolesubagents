/**
 * Optional read-only Typert Remote metadata, never full role configuration.
 * RPC: rolesubagentsRoleDisplay/query, { args: { childIds } }.
 * Parameter names are wire-visible; keep the Host bundle unminified.
 */
import {
  MAX_ROLE_DISPLAY_CHILD_ID_LENGTH,
  MAX_ROLE_DISPLAY_CHILD_IDS,
  ROLE_DISPLAY_SERVICE_NAME,
  type RoleDisplayResult,
} from '../shared/role-display.ts'
import { decorateMethod, type TypertModule } from './external/probe-service.ts'
import type { HostContext } from './ports.ts'
import type { RoleState } from './state.ts'
import type { ExternalRunStore } from './external/observability.ts'
import type { ExternalRunsResult } from '../shared/role-display.ts'

export interface RoleDisplayServiceOptions {
  readonly externalRuns?: ExternalRunStore
  readonly state: Pick<RoleState, 'ready' | 'readRoleById'>
  readonly isDisposed: () => boolean
  /** Plugin lifetime: pending cold reads must settle even if storage never opens. */
  readonly lifetime?: AbortSignal
}

function validateChildIds(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length > MAX_ROLE_DISPLAY_CHILD_IDS ||
    // Array.from also rejects sparse slots rather than silently skipping them.
    Array.from(input).some(
      id =>
        typeof id !== 'string' ||
        id.length === 0 ||
        id.length > MAX_ROLE_DISPLAY_CHILD_ID_LENGTH ||
        !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id),
    )
  ) {
    throw new Error('childIds must be an array of at most 100 identifiers (1–256 ASCII letters, digits, _, ., :, -)')
  }
  return [...input] as string[]
}

/** Cancel only this wait; never cancel the shared storage open or other readers. */
async function abortable(ready: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  let abort = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('role display request cancelled'))
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    await Promise.race([ready, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

export function createRoleDisplayServiceClass(typert: TypertModule, options: RoleDisplayServiceOptions) {
  const Base = typert.TypertRemoteService
  const remote = typert.Remote('query')
  // One service-scoped cancellation source, not a global pending-request registry.
  const lifetime = new AbortController()
  // Keep `signal` exclusive to Remote method parameters: Typert injects cancellation by
  // that literal name, and esbuild renames shadowed parameters even without minification.
  const serviceSignal = options.lifetime ? AbortSignal.any([lifetime.signal, options.lifetime]) : lifetime.signal
  const ready = abortable(options.state.ready, serviceSignal)
  // The optional service may be disposed without ever receiving a query.
  void ready.catch(() => {})
  return class RolesubagentsRoleDisplayService extends Base {
    constructor(ctx: unknown) {
      super(ctx as never, ROLE_DISPLAY_SERVICE_NAME)
      decorateMethod(remote, this, 'query')
      decorateMethod(typert.Remote('externalRuns'), this, 'externalRuns')
      // Cordis owns this child context; native disposal cancels cold reads too.
      ;(ctx as Partial<Pick<HostContext, 'effect'>>).effect?.(() => () => lifetime.abort())
    }

    /** Owner identity is injected by the gateway, never accepted as a wire argument. */
    async externalRuns(parentSessionId: unknown, signal: AbortSignal): Promise<ExternalRunsResult> {
      const [id] = validateChildIds([parentSessionId])
      const authorize = () => {
        const invocation = (
          this as unknown as {
            ctx?: { invocation?: { peer?: { principal?: { kind?: string }; signal?: AbortSignal } } }
          }
        ).ctx?.invocation
        if (invocation?.peer?.principal?.kind !== 'owner' || invocation.peer.signal?.aborted)
          throw new Error('external run access denied')
        if (options.isDisposed() || lifetime.signal.aborted || options.lifetime?.aborted)
          throw new Error('role display service is disposed')
        signal.throwIfAborted()
      }
      authorize()
      if (!options.externalRuns) throw new Error('external run history unavailable')
      await abortable(
        options.externalRuns.ready,
        AbortSignal.any([signal, lifetime.signal, ...(options.lifetime ? [options.lifetime] : [])]),
      )
      authorize()
      const result = await options.externalRuns.list(id!)
      authorize()
      return result
    }

    async query(childIds: unknown, signal: AbortSignal): Promise<RoleDisplayResult> {
      const ids = validateChildIds(childIds)
      if (options.isDisposed() || lifetime.signal.aborted || options.lifetime?.aborted)
        throw new Error('role display service is disposed')
      await abortable(ready, signal)
      signal.throwIfAborted()
      if (options.isDisposed() || lifetime.signal.aborted || options.lifetime?.aborted)
        throw new Error('role display service is disposed')
      return ids.map(id => {
        const role = options.state.readRoleById(id)
        if (role === undefined) return null
        return {
          roleId: role.id,
          displayName: role.id,
          ...(role.builtin === 'general' || role.builtin === 'fork' ? { builtin: role.builtin } : {}),
        }
      })
    }
  }
}

let warnedUnavailable = false

/** Optional dependency and registration failures never disable delegation; a later mount can retry. */
export async function mountRoleDisplayService(
  ctx: HostContext,
  options: RoleDisplayServiceOptions,
  load: () => Promise<TypertModule> = () =>
    import('@deepseek-ai/dsh-typert-protocol') as unknown as Promise<TypertModule>,
): Promise<void> {
  const plugin = ctx.plugin?.bind(ctx)
  if (plugin === undefined || options.isDisposed()) return
  let typert: TypertModule
  try {
    typert = await load()
    if (typeof typert.TypertRemoteService !== 'function' || typeof typert.Remote !== 'function')
      throw new Error('unexpected module shape')
  } catch {
    if (!options.isDisposed() && !warnedUnavailable) {
      warnedUnavailable = true
      ctx.logger.info('rolesubagents: role display is unavailable')
    }
    return
  }
  if (options.isDisposed()) return
  try {
    plugin(createRoleDisplayServiceClass(typert, options))
  } catch {
    if (!options.isDisposed()) ctx.logger.warn('rolesubagents: could not mount role display')
  }
}
