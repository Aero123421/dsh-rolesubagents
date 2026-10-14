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
 */

import { createController } from './controller.ts'
import { type DshClientContext, ENTRY_ID, PACKAGE_NAME } from './dsh.ts'
import { RolesPage } from './RolesPage.tsx'
import { installStyles } from './styles.ts'

/** Cordis services this plugin needs. `remote.session` and `remote.agentPresets` carry the model and preset lists. */
export const inject = ['slots', 'locale', 'remote', 'remote.session', 'remote.agentPresets', 'configForms']

function activeLocale(ctx: DshClientContext): string {
  try {
    const active = ctx.locale.getLocale()?.active
    return typeof active === 'string' ? active : 'en'
  } catch {
    return 'en'
  }
}

export function apply(ctx: DshClientContext): void {
  const controller = createController({
    form: ctx.configForms.get(ENTRY_ID),
    remote: ctx.remote,
    locale: activeLocale(ctx),
  })

  ctx.effect(() => installStyles(document), 'dsh-rolesubagents:styles')
  ctx.effect(() => () => controller.dispose(), 'dsh-rolesubagents:controller')
  ctx.effect(() => ctx.locale.subscribe(() => controller.setLocale(activeLocale(ctx))), 'dsh-rolesubagents:locale')
  // A new connection may reach a restarted Host, and a changed adapter set changes which models exist.
  ctx.effect(() => ctx.on('connection/reset', () => controller.invalidateReference()), 'dsh-rolesubagents:reconnect')
  ctx.effect(
    () => ctx.remote.$on('llm/adapters-updated', () => controller.invalidateReference()),
    'dsh-rolesubagents:adapters',
  )

  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register({ name: 'plugins.bundle.config', key: PACKAGE_NAME, inject: () => ({ controller }) }, RolesPage),
  )
}
