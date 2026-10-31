import { describe, expect, it, vi } from 'vitest'
import { literalRoleSettings } from '../src/host/management/literal.ts'
import { createManagementRemoteClass } from '../src/host/management/remote.ts'
import { managementSettings, ownManagementNamespace, ownManagementRawConfig } from '../src/host/management/settings.ts'
import type { TypertModule } from '../src/host/external/probe-service.ts'
import { DEFAULT_ROLES } from '../src/shared/roles.ts'

const roles = () => structuredClone(DEFAULT_ROLES)
function fixture(raw: unknown, value: unknown = { roles: roles(), allowAiRoleManagement: true }) {
  const port = {
    writable: true,
    describe: vi.fn(() => [{ ns: 'rolesubagents', revision: 4, value }]),
    mutate: vi.fn(async () => {}),
  }
  const settings = managementSettings({ namespace: () => 'rolesubagents', settings: () => port, rawConfig: () => raw })
  return { port, settings }
}
describe('literal-only role writing and read-only syntax attestation', () => {
  it('supports literal data/defaults while unrelated configuration expressions are not restated', () => {
    expect(literalRoleSettings({})).toBe(true)
    expect(literalRoleSettings({ roles: roles(), clis: { __jsExpr: 'unrelated' } })).toBe(true)
    expect(
      literalRoleSettings({
        roles: [
          ...roles(),
          {
            id: 'literal',
            instructions: '__jsExpr is plain text',
            opaque: Object.fromEntries([['__proto__', { inert: true }]]),
          },
        ],
      }),
    ).toBe(true)
  })
  it.each([
    { __jsExpr: 'SECRET_WHOLE_CONFIG' },
    { roles: { __jsExpr: 'SECRET_ROLE_ARRAY' } },
    { roles: [...roles(), { id: 'opaque', opaque: { nested: { __jsExpr: 'SECRET_OPAQUE_EXPRESSION' } } }] },
    { roles: [{ id: 'known', instructions: { __jsExpr: 'SECRET_INSTRUCTION' } }] },
  ])('refuses executable expressions without exposing their sources', raw => {
    const t = fixture(raw)
    expect(literalRoleSettings(raw)).toBe(false)
    expect(t.settings.writeSafety(4)).toEqual({ safe: false, reason: 'expression-backed-role-settings' })
    expect(t.port.describe).not.toHaveBeenCalled()
    expect(JSON.stringify(t.settings.writeSafety(4))).not.toContain('SECRET_')
  })
  it('blocks writes even when live evaluated values look like harmless literal roles', async () => {
    const t = fixture({ roles: [...roles(), { id: 'opaque', opaque: { __jsExpr: 'SECRET_ENV_REFERENCE' } }] })
    const read = t.settings.read()
    expect(read.literalRolesSupported).toBe(false)
    await expect(t.settings.writeRoles(read, roles())).rejects.toMatchObject({
      code: 'expression-backed-role-settings',
    })
    expect(t.port.mutate).not.toHaveBeenCalled()
  })
  it('binds a positive status to the exact canonical revision and does not require the AI gate', () => {
    const t = fixture({ roles: roles() }, { roles: roles(), allowAiRoleManagement: false })
    expect(t.settings.writeSafety(4)).toEqual({ safe: true, revision: 4, reason: 'literal-role-settings' })
    expect(t.settings.writeSafety(3)).toEqual({ safe: false, revision: 4, reason: 'revision-conflict' })
    expect(t.port.mutate).not.toHaveBeenCalled()
  })
  it('rejects accessors without executing them and rejects nonliteral/cyclic/deep metadata', () => {
    const get = vi.fn(() => 'SECRET_GETTER')
    const opaque = Object.defineProperty({}, 'secret', { enumerable: true, get })
    expect(literalRoleSettings({ roles: [{ opaque }] })).toBe(false)
    expect(get).not.toHaveBeenCalled()
    for (const value of [() => {}, Symbol('s'), 1n, Number.NaN, Number.POSITIVE_INFINITY, new Date()])
      expect(literalRoleSettings({ roles: [{ opaque: value }] })).toBe(false)
    for (const opaque of [
      Object.defineProperty({}, 'hidden', { value: 'not-JSON' }),
      Array(2),
      Object.assign([1], { extra: 'not-JSON' }),
    ])
      expect(literalRoleSettings({ roles: [{ opaque }] })).toBe(false)
    expect(literalRoleSettings(Object.assign(Object.create({ __jsExpr: 'inherited-root' }), { roles: roles() }))).toBe(
      false,
    )
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(literalRoleSettings({ roles: [cycle] })).toBe(false)
    let deep: unknown = 'leaf'
    for (let i = 0; i < 70; i++) deep = { deep }
    expect(literalRoleSettings({ roles: [deep] })).toBe(false)
  })
  it('uses the owning RAW composed configuration, not an interpolated form value', () => {
    const entry = {
      options: { id: 'rolesubagents', config: { roles: [{ opaque: { __jsExpr: 'SECRET_INHERITED' } }] } },
      fiber: {},
    }
    const ctx = { fiber: { entry } }
    const ns = ownManagementNamespace(ctx)
    const raw = ownManagementRawConfig(ctx, ns)
    const port = {
      writable: true,
      describe: vi.fn(() => [{ ns: 'rolesubagents', revision: 0, value: { roles: roles() } }]),
      mutate: vi.fn(async () => {}),
    }
    const settings = managementSettings({ settings: () => port, namespace: ns, rawConfig: raw })
    expect(settings.writeSafety(0)).toMatchObject({ safe: false, reason: 'expression-backed-role-settings' })
    expect(port.describe).not.toHaveBeenCalled()
    entry.fiber = {}
    expect(settings.writeSafety(0)).toEqual({ safe: false, reason: 'safety-unavailable' })
  })
  it('exposes only a bounded metadata status through a fixed read-only Remote method', async () => {
    const decorated: string[] = []
    const typert: TypertModule = {
      TypertRemoteService: class {},
      Remote: name => (_method, context) => {
        decorated.push(name)
        context.addInitializer(() => {})
      },
    }
    const status = vi.fn(() => ({ safe: true, revision: 4, reason: 'literal-role-settings' as const }))
    let disposed = false
    const Remote = createManagementRemoteClass(typert, { writeSafety: status, isDisposed: () => disposed })
    const remote = new Remote({})
    expect(decorated).toEqual(['writeSafety'])
    expect(await remote.writeSafety({ expectedRevision: 4 })).toEqual({
      safe: true,
      revision: 4,
      reason: 'literal-role-settings',
    })
    expect(status).toHaveBeenCalledWith(4)
    for (const input of [
      null,
      {},
      [],
      { expectedRevision: -1 },
      { expectedRevision: 4, namespace: 'other' },
      { expectedRevision: 4, roles: roles() },
    ])
      expect(await remote.writeSafety(input)).toEqual({ safe: false, reason: 'safety-unavailable' })
    expect(status).toHaveBeenCalledTimes(1)
    disposed = true
    expect(await remote.writeSafety({ expectedRevision: 4 })).toEqual({ safe: false, reason: 'safety-unavailable' })
  })
})
