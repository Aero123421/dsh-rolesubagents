/** Read-only UI syntax attestation. Whole-array writes still use the normal revision-fenced form API. */
import type { HostContext } from '../ports.ts'
import { decorateMethod, type TypertModule } from '../external/probe-service.ts'
import type { RoleWriteSafety } from './literal.ts'

export const MANAGEMENT_REMOTE_NAME = 'rolesubagentsManagement'
export interface ManagementRemoteOptions {
  readonly writeSafety: (expectedRevision: number) => RoleWriteSafety
  readonly isDisposed: () => boolean
}
export function createManagementRemoteClass(typert: TypertModule, options: ManagementRemoteOptions) {
  const Base = typert.TypertRemoteService
  const remote = typert.Remote('writeSafety')
  return class RolesubagentsManagementService extends Base {
    constructor(ctx: unknown) {
      super(ctx as never, MANAGEMENT_REMOTE_NAME)
      decorateMethod(remote, this, 'writeSafety')
    }
    /** request is a wire parameter name; do not minify the Host bundle. No gate is needed for a human UI check. */
    async writeSafety(request: unknown): Promise<RoleWriteSafety> {
      if (options.isDisposed() || !request || typeof request !== 'object' || Array.isArray(request))
        return { safe: false, reason: 'safety-unavailable' }
      const args = request as Record<string, unknown>
      if (
        Object.keys(args).some(key => key !== 'expectedRevision') ||
        typeof args.expectedRevision !== 'number' ||
        !Number.isSafeInteger(args.expectedRevision) ||
        args.expectedRevision < 0
      )
        return { safe: false, reason: 'safety-unavailable' }
      try {
        return options.writeSafety(args.expectedRevision)
      } catch {
        return { safe: false, reason: 'safety-unavailable' }
      }
    }
  }
}
export async function mountManagementRemote(
  ctx: HostContext,
  options: ManagementRemoteOptions,
  load: () => Promise<TypertModule> = () =>
    import('@deepseek-ai/dsh-typert-protocol') as unknown as Promise<TypertModule>,
): Promise<void> {
  const plugin = ctx.plugin?.bind(ctx)
  if (!plugin) return
  try {
    const typert = await load()
    if (options.isDisposed()) return
    if (typeof typert.TypertRemoteService !== 'function' || typeof typert.Remote !== 'function')
      throw new Error('unsupported remote service')
    plugin(createManagementRemoteClass(typert, options))
  } catch {
    if (!options.isDisposed())
      ctx.logger.info(
        'rolesubagents: safe role-save status is unavailable; update the Host before saving whole role catalogs from this UI',
      )
  }
}
