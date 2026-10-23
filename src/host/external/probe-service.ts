/**
 * The `rolesubagentsCli` Remote service: exposes {@link probeCli} to the
 * browser editor as `rolesubagentsCli/probe`.
 *
 * Browser call: `ctx.connection.rpc.call('/api', 'rolesubagentsCli/probe', { args: { request } }, signal)`
 * → `{ ok: true, value: ProbeResult } | { ok: false, error }`.
 *
 * `@deepseek-ai/dsh-typert-protocol` is loaded with a dynamic `import()` and
 * the feature is skipped (logged once) when it is missing, since Remote
 * services are not a documented third-party API. The class is built after
 * that import, so `@Remote('probe')` is applied by hand in the constructor:
 * a standard method decorator only registers an initializer that runs per
 * instance right after `super()`, which is exactly what the constructor does.
 * This keeps the source free of decorator syntax (no transform needed by
 * esbuild, tsc or vitest). The gateway reads the method's parameter names, so
 * `probe(request, signal)` must keep those names and the Host bundle must stay
 * unminified.
 */

import type { CliSettingsMap } from '../../shared/runner.ts'
import type { HostContext, SubprocessPort } from '../ports.ts'
import { probeCli } from './probe.ts'
import type { AdapterLookup } from './registry.ts'
import type { ProbeResult } from './types.ts'

/** Cordis service key and Remote namespace. */
export const PROBE_SERVICE_NAME = 'rolesubagentsCli'

/** The members of `@deepseek-ai/dsh-typert-protocol` used here. */
export interface TypertModule {
  readonly TypertRemoteService: new (ctx: never, serviceKey: string) => object
  readonly Remote: (name: string) => (method: unknown, context: MethodDecoratorContextLike) => void
}

/** The subset of a standard method decorator context that Typert's `Remote` reads. */
export interface MethodDecoratorContextLike {
  readonly kind: 'method'
  readonly name: string
  readonly static: false
  readonly private: false
  readonly metadata: Record<PropertyKey, unknown>
  addInitializer(initializer: (this: unknown) => void): void
}

/** What the service needs from the plugin. */
export interface ProbeServiceOptions {
  /** Lazily resolves `ctx.subprocess`. */
  readonly subprocess: () => SubprocessPort | undefined
  readonly adapters: AdapterLookup
  /** The live per-CLI settings. */
  readonly cliSettings: () => CliSettingsMap | undefined
  /** True once the plugin unloaded; a late import then does nothing. */
  readonly isDisposed: () => boolean
  /** Safe in-process metadata observer; never starts another probe or changes the wire result. */
  readonly onResult?: (result: ProbeResult, admittedSettings: CliSettingsMap) => void
}

/**
 * Apply a standard method decorator by hand to one instance (see the module comment).
 * @param decorator - e.g. `Remote('probe')`.
 * @param instance - the freshly constructed instance.
 * @param name - the decorated method's name.
 */
export function decorateMethod(
  decorator: (method: unknown, context: MethodDecoratorContextLike) => void,
  instance: object,
  name: string,
): void {
  const initializers: ((this: unknown) => void)[] = []
  const method = (Object.getPrototypeOf(instance) as Record<string, unknown>)[name]
  decorator(method, {
    kind: 'method',
    name,
    static: false,
    private: false,
    metadata: {},
    addInitializer: initializer => initializers.push(initializer),
  })
  for (const initializer of initializers) initializer.call(instance)
}

/**
 * Build the service class over a loaded Typert module.
 * @param typert - the loaded module.
 * @param options - adapters and settings.
 * @returns a Cordis plugin class; mount it with `ctx.plugin(Class)`.
 */
export function createProbeServiceClass(typert: TypertModule, options: ProbeServiceOptions) {
  const Base = typert.TypertRemoteService
  const remote = typert.Remote('probe')
  // No instance state: Cordis may hand out a proxy of the instance, so everything comes from `options`.
  return class RolesubagentsCliService extends Base {
    constructor(ctx: unknown) {
      super(ctx as never, PROBE_SERVICE_NAME)
      decorateMethod(remote, this, 'probe')
    }

    /** Remote `rolesubagentsCli/probe`. Parameter names are part of the wire contract. */
    async probe(request: unknown, signal: AbortSignal): Promise<ProbeResult> {
      const admittedSettings = structuredClone(options.cliSettings() ?? {})
      const result = await probeCli(
        request,
        { subprocess: options.subprocess(), adapters: options.adapters, settings: admittedSettings },
        signal,
      )
      if (!options.isDisposed()) {
        try {
          options.onResult?.(result, admittedSettings)
        } catch {
          /* Optional reference cache must not break diagnostics. */
        }
      }
      return result
    }
  }
}

let warnedUnavailable = false

/**
 * Mount the probe service when the Host supports Remote services; otherwise log once and do nothing.
 * Never throws and never rejects.
 * @param ctx - the plugin's Host context.
 * @param options - adapters, settings and the plugin's disposed flag.
 * @param load - loads the Typert module (tests inject a fake).
 * @returns settles when the service was mounted or skipped.
 */
export async function mountProbeService(
  ctx: HostContext,
  options: ProbeServiceOptions,
  load: () => Promise<TypertModule> = () =>
    import('@deepseek-ai/dsh-typert-protocol') as unknown as Promise<TypertModule>,
): Promise<void> {
  const plugin = ctx.plugin?.bind(ctx)
  if (plugin === undefined) return
  let typert: TypertModule
  try {
    typert = await load()
    if (typeof typert.TypertRemoteService !== 'function' || typeof typert.Remote !== 'function') {
      throw new Error('unexpected module shape')
    }
  } catch (error) {
    if (!warnedUnavailable) {
      warnedUnavailable = true
      ctx.logger.info(
        `rolesubagents: the CLI connection test is unavailable (${error instanceof Error ? error.message : String(error)})`,
      )
    }
    return
  }
  if (options.isDisposed()) return
  try {
    plugin(createProbeServiceClass(typert, options))
  } catch (error) {
    ctx.logger.warn(
      `rolesubagents: could not mount the CLI connection test: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
