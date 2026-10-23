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
 * Missing capabilities and failed diagnostics remain retryable, without
 * disabling role editing or making claims about whether a CLI is installed.
 */

import type { CliId } from '../shared/cli/index.ts'
import { createController, type ProbeCall, ProbeUnavailableError } from './controller.ts'
import { type ConnectionLike, type DshClientContext, ENTRY_ID, PACKAGE_NAME, type RemoteResult } from './dsh.ts'
import { RolesPage } from './RolesPage.tsx'
import { installStyles } from './styles.ts'

/** Cordis services this plugin needs. `remote.session` and `remote.agentPresets` carry the model and preset lists. */
export const inject = ['slots', 'locale', 'remote', 'remote.session', 'remote.agentPresets', 'configForms']

/** Remote endpoint of the Host's CLI connection test (src/host/external/probe-service.ts). */
export const PROBE_ENDPOINT = 'rolesubagentsCli/probe'

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

function activeLocale(ctx: DshClientContext): string {
  try {
    const active = ctx.locale.getLocale()?.active
    return typeof active === 'string' ? active : 'en'
  } catch {
    return 'en'
  }
}

export function apply(ctx: DshClientContext): void {
  const probe = probeCaller(ctx)
  const controller = createController({
    form: ctx.configForms.get(ENTRY_ID),
    remote: ctx.remote,
    locale: activeLocale(ctx),
    ...(probe === undefined ? {} : { probe }),
  })

  ctx.effect(() => installStyles(document), 'dsh-rolesubagents:styles')
  ctx.effect(() => () => controller.dispose(), 'dsh-rolesubagents:controller')
  ctx.effect(() => ctx.locale.subscribe(() => controller.setLocale(activeLocale(ctx))), 'dsh-rolesubagents:locale')
  // A new connection may reach a restarted Host, and a changed adapter set changes which models exist.
  ctx.effect(
    () =>
      ctx.on('connection/reset', () => {
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
