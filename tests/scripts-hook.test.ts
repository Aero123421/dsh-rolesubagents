import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- a plain .mjs script module without type declarations.
import { hostResolveHook } from '../scripts/host-resolve-hook.mjs'

describe('scripts/host-resolve-hook.mjs', () => {
  it('resolves @deepseek-ai/* from the host installation and passes other specifiers on', () => {
    const hostRequire = { resolve: vi.fn((specifier: string) => `/opt/dsh/node_modules/${specifier}/index.js`) }
    const hook = hostResolveHook(hostRequire)
    const next = vi.fn(() => ({ url: 'node:fs' }))
    expect(hook.resolve('@deepseek-ai/cordis', {}, next)).toEqual({
      url: 'file:///opt/dsh/node_modules/@deepseek-ai/cordis/index.js',
      shortCircuit: true,
    })
    expect(next).not.toHaveBeenCalled()
    expect(hook.resolve('node:fs', {}, next)).toEqual({ url: 'node:fs' })
  })

  it('does not recurse when require.resolve re-enters the hook (Node 24)', () => {
    let hook: ReturnType<typeof hostResolveHook>
    const next = vi.fn((specifier: string) => ({ url: `file:///default/${specifier}` }))
    // As on Node 24: require.resolve runs the registered hooks, i.e. calls this hook again.
    const hostRequire = {
      resolve: vi.fn((specifier: string) => {
        const nested = hook.resolve(specifier, { conditions: [] }, next) as { url: string }
        return new URL(nested.url).pathname
      }),
    }
    hook = hostResolveHook(hostRequire)
    expect(hook.resolve('@deepseek-ai/dsh-tools', {}, next)).toEqual({
      url: 'file:///default/@deepseek-ai/dsh-tools',
      shortCircuit: true,
    })
    expect(next).toHaveBeenCalledTimes(1)
    // The guard is released afterwards.
    expect((hook.resolve('@deepseek-ai/x', {}, next) as { shortCircuit?: boolean }).shortCircuit).toBe(true)
  })
})
