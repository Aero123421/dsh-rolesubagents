/**
 * A `module.registerHooks` resolve hook that resolves every `@deepseek-ai/*` specifier from one DSH
 * installation (as DSH does for plugins), shared by the integration scripts.
 *
 * Re-entrancy: on Node 24, `require.resolve` itself runs the registered resolve hooks, so resolving
 * through `hostRequire.resolve` inside the hook calls the hook again for the same specifier. Without a
 * guard that recursion never ends (`RangeError: Maximum call stack size exceeded`). While the hook is
 * resolving, a nested call goes straight to Node's default resolution (`next`), which is exactly what
 * `hostRequire.resolve` asked for. On Node 22 the nested call simply never happens.
 */

import { pathToFileURL } from 'node:url'

/**
 * @param {{ resolve(specifier: string): string }} hostRequire - `createRequire(<DSH>/package.json)`.
 * @returns {{ resolve(specifier: string, context: unknown, next: Function): unknown }} the hook.
 */
export function hostResolveHook(hostRequire) {
  let depth = 0
  return {
    resolve(specifier, context, next) {
      if (depth > 0 || !specifier.startsWith('@deepseek-ai/')) return next(specifier, context)
      depth++
      try {
        return { url: pathToFileURL(hostRequire.resolve(specifier)).href, shortCircuit: true }
      } finally {
        depth--
      }
    },
  }
}
