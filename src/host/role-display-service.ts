/**
 * Optional, read-only Typert Remote service.
 * Browser: rpc.call('/api', 'rolesubagentsRoleDisplay/query', { args: { childIds } }, signal)
 * returns the gateway envelope { ok: true, value: RoleDisplayResult } (or { ok: false, error }).
 * The method parameter names are wire-visible; keep the Host bundle unminified.
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

export interface RoleDisplayServiceOptions {
  readonly state: Pick<RoleState, 'ready' | 'readRoleById'>
  readonly isDisposed: () => boolean
}

function validateChildIds(input: unknown): string[] {
  if (
    !Array.isArray(input) ||
    input.length > MAX_ROLE_DISPLAY_CHILD_IDS ||
    // Array.from also turns sparse slots into undefined, so they cannot bypass validation.
    Array.from(input).some(
      id =>
        typeof id !== 'string' ||
        id.length === 0 ||
        id.length > MAX_ROLE_DISPLAY_CHILD_ID_LENGTH ||
        !/^[A-Za-z0-9]/.test(id) ||
        /[^A-Za-z0-9_.:-]/.test(id),
    )
  ) {
    throw new Error('childIds must be an array of at most 100 identifiers (1–256 ASCII letters, digits, _, ., :, -)')
  }
  return [...input] as string[]
}

/** Build a Cordis-scoped service; only explicit display fields cross the browser boundary. */
export function createRoleDisplayServiceClass(typert: TypertModule, options: RoleDisplayServiceOptions) {
  const Base = typert.TypertRemoteService
  const remote = typert.Remote('query')
  return class RolesubagentsRoleDisplayService extends Base {
    constructor(ctx: unknown) {
      super(ctx as never, ROLE_DISPLAY_SERVICE_NAME)
      decorateMethod(remote, this, 'query')
    }

    async query(childIds: unknown, signal: AbortSignal): Promise<RoleDisplayResult> {
      const ids = validateChildIds(childIds)
      signal.throwIfAborted()
      if (options.isDisposed()) throw new Error('role display service is disposed')
      await options.state.ready
      signal.throwIfAborted()
      if (options.isDisposed()) throw new Error('role display service is disposed')
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

/** Mount only when optional Typert is available; Cordis owns unmounting the child service. */
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
    if (typeof typert.TypertRemoteService !== 'function' || typeof typert.Remote !== 'function') {
      throw new Error('unexpected module shape')
    }
  } catch (error) {
    if (!options.isDisposed() && !warnedUnavailable) {
      warnedUnavailable = true
      ctx.logger.info(
        `rolesubagents: role display is unavailable (${error instanceof Error ? error.message : String(error)})`,
      )
    }
    return
  }
  if (options.isDisposed()) return
  try {
    plugin(createRoleDisplayServiceClass(typert, options))
  } catch (error) {
    ctx.logger.warn(
      `rolesubagents: could not mount role display: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
