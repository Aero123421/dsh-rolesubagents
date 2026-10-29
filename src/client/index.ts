/**
 * Browser plugin entry. DSH loads `lib/client.js`, injects the Cordis services
 * named in `inject`, and calls `apply(ctx)`. Everything the plugin owns (style
 * tag, controller, subscriptions, slot registration) is tied to `ctx`, so
 * unloading the plugin removes it.
 *
 * The role editor is this bundle's own configuration page: it is registered in
 * the Plugins page's keyed `plugins.bundle.config` slot under the package name
 * (packages/client/ui-plugin-manager/src/client/slot-contract.ts), and edits the
 * `rolesubagents` Host entry through the shared configuration form.
 *
 * The External CLIs connection test calls the Host's `rolesubagentsCli/probe`
 * through the `connection` service. That service is deliberately NOT in
 * `inject`: Cordis treats every listed name as required, so a client without it
 * would never load the page at all. It is read lazily with `ctx.get` (Cordis'
 * reflect mixin, as DSH's own ui-settings-general does) when a test runs.
 * Missing CLI diagnostics remain retryable without making claims about CLI installation.
 * Role-array saves separately require the metadata-only rolesubagentsManagement/writeSafety endpoint,
 * because Host form values are interpolated and cannot safely round-trip executable expressions.
 * Its absence fails role saves closed; the page and independent management-OFF switch still work.
 */

import type { CliId } from '../shared/cli/index.ts'
import { mountCatalog } from './catalog-mount.ts'
import { roleDisplayCaller } from './role-display.ts'
import { externalRunsCaller } from './external-runs.ts'
import { createController, type ProbeCall, ProbeUnavailableError, type RoleWriteSafetyCall } from './controller.ts'
import { type ConnectionLike, type DshClientContext, ENTRY_ID, PACKAGE_NAME, type RemoteResult } from './dsh.ts'
import { RolesPage } from './RolesPage.tsx'
import { installStyles } from './styles.ts'

/** Cordis services this plugin needs. `remote.session` and `remote.agentPresets` carry the model and preset lists. */
export const inject = ['slots', 'locale', 'remote', 'remote.session', 'remote.agentPresets', 'configForms']

/** Remote endpoint of the Host's CLI connection test (src/host/external/probe-service.ts). */
export const PROBE_ENDPOINT = 'rolesubagentsCli/probe'
/** Metadata-only syntax guard: no raw configuration/role values cross this endpoint. */
export const ROLE_WRITE_SAFETY_ENDPOINT = 'rolesubagentsManagement/writeSafety'
export const ROLE_WRITE_SAFETY_TIMEOUT_MS = 10_000

function connectionOf(ctx: DshClientContext): ConnectionLike | undefined {
  try {
    const connection = ctx.get?.('connection') as Partial<ConnectionLike> | undefined
    return typeof connection?.rpc?.call === 'function' ? (connection as ConnectionLike) : undefined
  } catch {
    return undefined
  }
}

/**
 * The connection test caller. Missing services are reported per attempt, so retry stays available.
 * @param ctx - the plugin context.
 * @returns a caller that reads `connection` on every call.
 */
export function probeCaller(ctx: DshClientContext): ProbeCall {
  return async (cli: CliId, signal: AbortSignal): Promise<RemoteResult<unknown>> => {
    const connection = connectionOf(ctx)
    if (connection === undefined) throw new ProbeUnavailableError()
    return await connection.rpc.call('/api', PROBE_ENDPOINT, { args: { request: { cli } } }, signal)
  }
}

/** Production role-array writes always need a positive, same-revision syntax check. */
export function roleWriteSafetyCaller(ctx: DshClientContext): RoleWriteSafetyCall {
  return async (expectedRevision, signal) => {
    const unavailable = () => new Error('role-write-safety-unavailable')
    const connection = connectionOf(ctx)
    if (connection === undefined || signal.aborted) throw unavailable()
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let stop: (() => void) | undefined
    try {
      const interrupted = new Promise<never>((_resolve, reject) => {
        stop = () => {
          abort.abort()
          reject(unavailable())
        }
        signal.addEventListener('abort', stop, { once: true })
        timer = setTimeout(stop, ROLE_WRITE_SAFETY_TIMEOUT_MS)
        if (signal.aborted) stop()
      })
      const pending = Promise.resolve().then(() => {
        if (abort.signal.aborted) throw unavailable()
        return connection.rpc.call(
          '/api',
          ROLE_WRITE_SAFETY_ENDPOINT,
          { args: { request: { expectedRevision } } },
          abort.signal,
        )
      })
      const result = await Promise.race([pending, interrupted])
      if (result?.ok !== true) throw unavailable()
      return result
    } catch {
      throw unavailable()
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      if (stop !== undefined) signal.removeEventListener('abort', stop)
    }
  }
}

function activeLocale(ctx: DshClientContext): string {
  try {
    const active = ctx.locale.getLocale()?.active
    return typeof active === 'string' ? active : 'en'
  } catch {
    return 'en'
  }
}

export function apply(ctx: DshClientContext): void {
  mountCatalog(ctx, { getRoles: roleDisplayCaller(ctx), getExternalRuns: externalRunsCaller(ctx) })
  const probe = probeCaller(ctx)
  const controller = createController({
    form: ctx.configForms.get(ENTRY_ID),
    remote: ctx.remote,
    locale: activeLocale(ctx),
    roleWriteSafety: roleWriteSafetyCaller(ctx),
    ...(probe === undefined ? {} : { probe }),
  })

  ctx.effect(() => installStyles(document), 'dsh-rolesubagents:styles')
  ctx.effect(() => () => controller.dispose(), 'dsh-rolesubagents:controller')
  ctx.effect(() => ctx.locale.subscribe(() => controller.setLocale(activeLocale(ctx))), 'dsh-rolesubagents:locale')
  // A new connection may reach a restarted Host, and a changed adapter set changes which models exist.
  ctx.effect(
    () =>
      ctx.on('connection/reset', () => {
        controller.resetRoleWriteSafety()
        controller.invalidateReference()
        controller.resetProbes()
      }),
    'dsh-rolesubagents:reconnect',
  )
  ctx.effect(
    () => ctx.remote.$on('llm/adapters-updated', () => controller.invalidateReference()),
    'dsh-rolesubagents:adapters',
  )

  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME, inject: () => ({ controller }) }, RolesPage),
  )
}
