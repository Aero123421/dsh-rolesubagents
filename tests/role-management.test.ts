import { describe, expect, it, vi } from 'vitest'
import { cliDescriptor } from '../src/shared/cli/index.ts'
import { DEFAULT_ROLES, MAX_ROLES, normalizeSettings } from '../src/shared/roles.ts'
import {
  eligibleRawRoleSourceIds,
  mergeKnownRoles,
  previewRoleChanges,
  RoleManagementError,
  type RoleChange,
} from '../src/shared/role-management.ts'

const baseline = () => ({ enabled: true, roles: structuredClone(DEFAULT_ROLES) })
const create = (role: unknown): RoleChange => ({ op: 'create', role })
const update = (id: string, patch: unknown): RoleChange => ({ op: 'update', id, patch })
const remove = (id: string): RoleChange => ({ op: 'delete', id })
function error(run: () => unknown, code: string): RoleManagementError {
  try {
    run()
  } catch (caught) {
    expect(caught).toBeInstanceOf(RoleManagementError)
    expect((caught as RoleManagementError).code).toBe(code)
    return caught as RoleManagementError
  }
  throw new Error('expected management rejection')
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) frozen(child)
    Object.freeze(value)
  }
  return value
}
const known = (raw: unknown) => normalizeSettings(raw).settings.roles

describe('pure manage_roles commands', () => {
  it('creates a DSH role with explicit safe defaults, ignoring unrelated global settings', () => {
    const input = {
      ...baseline(),
      enabled: false,
      clis: 'invalid-but-unrelated',
      workflowModel: { apiKey: 'SECRET_GLOBAL' },
    }
    const result = previewRoleChanges(
      input,
      [create({ id: 'tester', description: 'Run scoped tests' })],
      'workspace-write',
    )
    expect(result.roles.at(-1)).toEqual({
      id: 'tester',
      enabled: true,
      description: 'Run scoped tests',
      instructions: '',
      context: 'spawn',
      readOnly: false,
    })
    expect(result.rawRoles.slice(0, DEFAULT_ROLES.length)).toEqual(input.roles)
    expect(result.diff).toEqual([
      {
        op: 'create',
        id: 'tester',
        after: result.roles.at(-1),
        fields: ['id', 'enabled', 'description', 'instructions', 'context', 'readOnly'],
      },
    ])
    expect(JSON.stringify(result)).not.toContain('SECRET_GLOBAL')
  })

  it.each(['codex', 'grok-build', 'pi'] as const)(
    'defaults omitted %s permission without needing a full parent',
    cli => {
      const result = previewRoleChanges(
        baseline(),
        [create({ id: 'cli_worker', description: 'Work', runner: { cli } })],
        'workspace-write',
      )
      expect(result.roles.at(-1)?.runner).toEqual({ cli, permission: cliDescriptor(cli).defaultPermission })
    },
  )

  it.each(['grok-build', 'pi'] as const)('preserves explicit %s native only under a full caller ceiling', cli => {
    const changes = [create({ id: 'native_worker', description: 'Work', runner: { cli, permission: 'native' } })]
    error(() => previewRoleChanges(baseline(), changes, 'workspace-write'), 'permission-ceiling')
    expect(previewRoleChanges(baseline(), changes, 'full-access').roles.at(-1)?.runner?.permission).toBe('native')
  })

  it('does not reject unrelated stored full-access roles when editing a normal DSH role', () => {
    const input = {
      ...baseline(),
      roles: [
        ...baseline().roles,
        {
          id: 'native',
          enabled: true,
          description: 'Native',
          instructions: '',
          context: 'spawn',
          readOnly: false,
          runner: { cli: 'pi', permission: 'native' },
        },
      ],
    }
    const result = previewRoleChanges(input, [update('worker', { description: 'Updated' })], 'workspace-write')
    expect(result.diff.map(item => item.id)).toEqual(['worker'])
    error(
      () => previewRoleChanges(input, [update('native', { description: 'Changed' })], 'workspace-write'),
      'permission-ceiling',
    )
    expect(previewRoleChanges(input, [remove('native')], 'workspace-write').diff[0]?.op).toBe('delete')
  })

  it('rejects mutations for a read-only caller, including no-op requests', () => {
    error(() => previewRoleChanges(baseline(), [update('worker', {})], 'read-only'), 'read-only')
    expect(previewRoleChanges(baseline(), [], 'read-only').diff).toEqual([])
  })

  it.each([
    create({ id: 'tester', description: 'Test', apiKey: 'SECRET_UNKNOWN' }),
    create({ id: 'tester', description: 'Test', model: { provider: 'fake', model: 'fake', apiKey: 'SECRET_UNKNOWN' } }),
    create({ id: 'tester', description: 'Test', runner: { cli: 'pi', executable: 'SECRET_UNKNOWN' } }),
    update('worker', { clis: 'SECRET_UNKNOWN' }),
    update('worker', { id: 'renamed' }),
    update('general', { builtin: 'fork' }),
    { op: 'delete', id: 'worker', path: 'SECRET_UNKNOWN' } as unknown as RoleChange,
  ])('rejects unknown fields without echoing their values', change => {
    const failure = error(() => previewRoleChanges(baseline(), [change], 'full-access'), 'unknown-field')
    expect(JSON.stringify({ message: failure.message, code: failure.code, issues: failure.issues })).not.toContain(
      'SECRET_UNKNOWN',
    )
  })

  it.each([
    create({ description: 'No id' }),
    create({ id: 'tester' }),
    create({ id: ' tester', description: 'Bad' }),
    create({ id: 'tester', description: 5 }),
    update('worker', { enabled: 'yes' }),
    create({ id: 'tester', description: 'Bad', context: 'invalid' }),
    create({ id: 'tester', description: 'Bad', model: { provider: '', model: 'fake' } }),
    create({ id: 'tester', description: 'Bad', model: { provider: ' fake ', model: 'fake' } }),
    create({ id: 'tester', description: 'Bad', runner: { cli: 'unsupported' } }),
    create({ id: 'tester', description: 'Bad', runner: { cli: 'pi', permission: 'made-up' } }),
    create({ id: 'tester', description: 'Bad', runner: { cli: 'pi', timeoutMinutes: 0 } }),
    create({ id: 'tester', description: 'Bad', runner: { cli: 'pi', effort: 'made-up' } }),
    create({ id: 'tester', description: 'Bad', runner: { cli: 'pi', model: '--unsafe' } }),
    create({ id: 'tester', description: 'Bad', runner: { cli: 'opencode', provider: 'only-provider' } }),
  ])('rejects malformed typed settings instead of coercing or repairing', change => {
    error(() => previewRoleChanges(baseline(), [change], 'full-access'), 'invalid-role')
  })

  it('accepts manual CLI model ids and complete provider/model pairs without model discovery', () => {
    const result = previewRoleChanges(
      baseline(),
      [
        create({
          id: 'manual',
          description: 'Manual',
          runner: { cli: 'opencode', provider: 'custom', model: 'not-in-any-catalog', effort: 'custom-variant' },
        }),
      ],
      'workspace-write',
    )
    expect(result.roles.at(-1)?.runner).toMatchObject({
      provider: 'custom',
      model: 'not-in-any-catalog',
      effort: 'custom-variant',
    })
  })

  it.each(['general', 'fork'])('protects built-in %s identity and existence', id => {
    error(
      () => previewRoleChanges(baseline(), [create({ id, description: 'Shadow' })], 'full-access'),
      'builtin-protected',
    )
    error(() => previewRoleChanges(baseline(), [remove(id)], 'full-access'), 'builtin-protected')
    error(() => previewRoleChanges(baseline(), [update(id, { id: 'renamed' })], 'full-access'), 'unknown-field')
  })

  it('permits valid built-in text changes but not context repair or runners', () => {
    expect(
      previewRoleChanges(baseline(), [update('general', { instructions: 'Scoped briefing' })], 'workspace-write')
        .roles[0]?.instructions,
    ).toBe('Scoped briefing')
    error(() => previewRoleChanges(baseline(), [update('general', { context: 'fork' })], 'full-access'), 'invalid-role')
    error(
      () => previewRoleChanges(baseline(), [update('general', { runner: { cli: 'pi' } })], 'full-access'),
      'invalid-role',
    )
  })

  it('rejects duplicate operations and existing/nonexistent identity conflicts', () => {
    error(
      () => previewRoleChanges(baseline(), [update('worker', {}), remove('worker')], 'full-access'),
      'duplicate-operation',
    )
    error(
      () => previewRoleChanges(baseline(), [create({ id: 'worker', description: 'Duplicate' })], 'full-access'),
      'role-exists',
    )
    error(() => previewRoleChanges(baseline(), [update('missing', {})], 'full-access'), 'role-not-found')
    error(() => previewRoleChanges(baseline(), [remove('missing')], 'full-access'), 'role-not-found')
  })

  it('bounds change batches and total roles', () => {
    const changes = Array.from({ length: 16 }, (_, index) => create({ id: `custom_${index}`, description: 'Custom' }))
    expect(previewRoleChanges(baseline(), changes, 'workspace-write').diff).toHaveLength(16)
    error(
      () => previewRoleChanges(baseline(), [...changes, create({ id: 'last', description: 'Last' })], 'full-access'),
      'too-many-changes',
    )
    const full = {
      roles: [
        ...structuredClone(DEFAULT_ROLES.slice(0, 2)),
        ...Array.from({ length: MAX_ROLES - 2 }, (_, index) => ({
          id: `custom_${index}`,
          enabled: true,
          description: 'Custom',
          instructions: '',
          context: 'spawn',
          readOnly: false,
        })),
      ],
    }
    error(
      () => previewRoleChanges(full, [create({ id: 'last', description: 'Last' })], 'full-access'),
      'too-many-roles',
    )
  })

  it.each([
    undefined,
    {},
    { roles: null },
    { roles: [...baseline().roles, baseline().roles[2]] },
    { roles: baseline().roles.slice(1) },
    { roles: [...baseline().roles, { id: 'SECRET_INVALID ID', description: 'SECRET_VALUE' }] },
    { roles: baseline().roles.map(role => (role.id === 'worker' ? { ...role, enabled: 'SECRET_VALUE' } : role)) },
    { roles: baseline().roles.map(role => (role.id === 'worker' ? { ...role, context: 'SECRET_VALUE' } : role)) },
    {
      roles: baseline().roles.map(role =>
        role.id === 'worker' ? { ...role, runner: { cli: 'pi', permission: 'SECRET_VALUE' } } : role,
      ),
    },
  ])('refuses stored settings needing repair before touching any role', raw => {
    const failure = error(
      () => previewRoleChanges(raw, [create({ id: 'new_role', description: 'New' })], 'full-access'),
      'settings-repair-needed',
    )
    expect(JSON.stringify({ message: failure.message, issues: failure.issues })).not.toContain('SECRET_')
  })

  it('requires explicit incompatible-field clears during context changes', () => {
    const input = {
      ...baseline(),
      roles: [
        ...baseline().roles,
        {
          id: 'configured',
          enabled: true,
          description: 'Configured',
          instructions: '',
          context: 'spawn',
          readOnly: false,
          model: { provider: 'fake', model: 'fake' },
          agentPreset: 'custom',
        },
      ],
    }
    error(
      () => previewRoleChanges(input, [update('configured', { context: 'fork' })], 'workspace-write'),
      'invalid-role',
    )
    const fork = previewRoleChanges(
      input,
      [update('configured', { context: 'fork', forkScope: 'full', model: null, agentPreset: null })],
      'workspace-write',
    )
    expect(fork.roles.at(-1)).toMatchObject({ context: 'fork', forkScope: 'full' })
    expect(fork.roles.at(-1)?.model).toBeUndefined()
    error(
      () =>
        previewRoleChanges({ roles: fork.rawRoles }, [update('configured', { context: 'spawn' })], 'workspace-write'),
      'invalid-role',
    )
    expect(
      previewRoleChanges(
        { roles: fork.rawRoles },
        [update('configured', { context: 'spawn', forkScope: null })],
        'workspace-write',
      ).roles.at(-1)?.forkScope,
    ).toBeUndefined()
  })

  it('only preserves or clears an existing agent preset, never assigns one', () => {
    const input = baseline()
    Object.assign(input.roles[2]!, { agentPreset: 'custom' })
    expect(
      previewRoleChanges(input, [update('worker', { description: 'New' })], 'workspace-write').roles[2]?.agentPreset,
    ).toBe('custom')
    expect(
      previewRoleChanges(input, [update('worker', { agentPreset: null })], 'workspace-write').roles[2]?.agentPreset,
    ).toBeUndefined()
    error(
      () => previewRoleChanges(input, [update('worker', { agentPreset: 'custom' })], 'full-access'),
      'agent-preset-forbidden',
    )
    error(
      () =>
        previewRoleChanges(
          input,
          [create({ id: 'preset', description: 'Preset', agentPreset: 'custom' })],
          'full-access',
        ),
      'agent-preset-forbidden',
    )
  })

  it('validates fork and read-only runner constraints without silently lowering/disabling', () => {
    for (const role of [
      { id: 'bad', description: 'Bad', context: 'spawn', forkScope: 'task' },
      { id: 'bad', description: 'Bad', context: 'fork', model: { provider: 'fake', model: 'fake' } },
      { id: 'bad', description: 'Bad', context: 'fork', runner: { cli: 'pi' } },
      { id: 'bad', description: 'Bad', readOnly: true, runner: { cli: 'codex' } },
      { id: 'bad', description: 'Bad', readOnly: true, enabled: false, runner: { cli: 'pi' } },
    ])
      error(() => previewRoleChanges(baseline(), [create(role)], 'full-access'), 'invalid-role')
    expect(
      previewRoleChanges(
        baseline(),
        [
          create({
            id: 'reader',
            description: 'Read',
            readOnly: true,
            runner: { cli: 'codex', permission: 'read-only' },
          }),
        ],
        'workspace-write',
      ).roles.at(-1)?.readOnly,
    ).toBe(true)
  })

  it('preserves all untouched raw metadata and replaces only known nested fields', () => {
    const input = {
      ...baseline(),
      roles: [
        ...baseline().roles,
        {
          id: 'configured',
          enabled: true,
          description: 'Configured',
          instructions: '',
          context: 'spawn',
          readOnly: false,
          privateMetadata: { secret: 'SECRET_OPAQUE' },
          model: { provider: 'fake', model: 'old', reasoningEffort: 'old', futureModel: { secret: 'SECRET_MODEL' } },
        },
      ],
    }
    frozen(input)
    const result = previewRoleChanges(
      input,
      [update('configured', { model: { provider: 'fake', model: 'new' } })],
      'workspace-write',
    )
    expect(result.rawRoles[0]).toBe(input.roles[0])
    expect(result.rawRoles.at(-1)).toMatchObject({
      privateMetadata: { secret: 'SECRET_OPAQUE' },
      model: { provider: 'fake', model: 'new', futureModel: { secret: 'SECRET_MODEL' } },
    })
    expect((result.rawRoles.at(-1) as { model: unknown }).model).not.toHaveProperty('reasoningEffort')
    expect(result.diff[0]?.fields).toEqual(['model'])
    expect(JSON.stringify({ roles: result.roles, diff: result.diff })).not.toContain('SECRET_')
    expect(input.roles.at(-1)).toHaveProperty('model.model', 'old')
  })

  it('replaces runner known values, retains unknown runner metadata, and permits explicit whole-object clearing', () => {
    const input = {
      ...baseline(),
      roles: [
        ...baseline().roles,
        {
          id: 'configured',
          enabled: true,
          description: 'Configured',
          instructions: '',
          context: 'spawn',
          readOnly: false,
          runner: {
            cli: 'pi',
            permission: 'workspace-write',
            model: 'old',
            effort: 'high',
            opaque: { secret: 'SECRET_RUNNER' },
          },
        },
      ],
    }
    frozen(input)
    const result = previewRoleChanges(
      input,
      [update('configured', { runner: { cli: 'grok-build' } })],
      'workspace-write',
    )
    expect(result.rawRoles.at(-1)).toHaveProperty('runner', {
      cli: 'grok-build',
      permission: 'workspace-write',
      opaque: { secret: 'SECRET_RUNNER' },
    })
    const cleared = previewRoleChanges(
      { roles: result.rawRoles },
      [update('configured', { runner: null })],
      'workspace-write',
    )
    expect(cleared.rawRoles.at(-1)).not.toHaveProperty('runner')
    expect(input.roles.at(-1)).toHaveProperty('runner.model', 'old')
  })

  it('has immutable no-op/empty output and does not canonicalize untouched defaults', () => {
    const input = {
      ...baseline(),
      roles: [...baseline().roles, { id: 'minimal', description: 'Minimal', opaque: 'SECRET' }],
    }
    frozen(input)
    const result = previewRoleChanges(
      input,
      [update('minimal', { enabled: true, instructions: '' }), update('worker', {})],
      'workspace-write',
    )
    expect(result.diff).toEqual([])
    expect(result.rawRoles.at(-1)).toBe(input.roles.at(-1))
    expect(result.rawRoles.at(-1)).not.toHaveProperty('enabled')
    expect(previewRoleChanges(input, [], 'workspace-write').diff).toEqual([])
    expect(
      previewRoleChanges(
        baseline(),
        [create({ id: 'clear', description: 'Clear', model: null, runner: null, forkScope: null })],
        'workspace-write',
      ).roles.at(-1),
    ).not.toHaveProperty('runner')
  })

  it('projects only roles without touching unrelated global accessors', () => {
    const input = baseline()
    const getter = vi.fn(() => {
      throw new Error('SECRET_GLOBAL_ACCESSOR')
    })
    Object.defineProperty(input, 'clis', { enumerable: true, get: getter })
    expect(
      previewRoleChanges(input, [update('worker', { description: 'Changed' })], 'workspace-write').diff,
    ).toHaveLength(1)
    expect(getter).not.toHaveBeenCalled()
  })

  it('preserves inert opaque prototype-named keys without prototype pollution', () => {
    const input = baseline()
    const worker = { ...input.roles[2], ...JSON.parse('{"__proto__":{"polluted":"SECRET"}}') }
    const roles = input.roles.map(role => (role.id === 'worker' ? worker : role))
    const result = previewRoleChanges({ roles }, [update('worker', { description: 'Changed' })], 'workspace-write')
    expect(Object.hasOwn(result.rawRoles[2] as object, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(result.rawRoles[2])).toBe(Object.prototype)
    expect({}).not.toHaveProperty('polluted')
    expect(JSON.stringify(result.diff)).not.toContain('SECRET')
  })

  it('does not invoke input accessors or expose unexpected thrown error text', () => {
    const getter = vi.fn(() => {
      throw new Error('SECRET_ACCESSOR')
    })
    const role = { description: 'Getter' }
    Object.defineProperty(role, 'id', { enumerable: true, get: getter })
    error(() => previewRoleChanges(baseline(), [create(role)], 'workspace-write'), 'invalid-role')
    expect(getter).not.toHaveBeenCalled()
    const failure = new RoleManagementError('SECRET_UNKNOWN_CODE', [
      { code: 'not valid SECRET', id: 'SECRET INVALID', field: 'bad field SECRET' },
    ])
    expect(failure.message).toBe('The requested role settings are invalid.')
    expect(failure.issues).toEqual([{ code: 'invalid-role' }])
  })
})

describe('raw-backed known role serialization', () => {
  it('preserves raw identity by default when known fields are unchanged', () => {
    const input = baseline()
    Object.assign(input.roles[2]!, { opaque: { secret: 'SECRET' } })
    frozen(input)
    const result = mergeKnownRoles(input.roles, known(input))
    expect(result[2]).toBe(input.roles[2])
  })

  it('explicit empty origins means no metadata inheritance, including same-id recreation', () => {
    const input = baseline()
    Object.assign(input.roles[2]!, { opaque: 'SECRET' })
    const result = mergeKnownRoles(input.roles, known(input), [])
    expect(result[2]).not.toHaveProperty('opaque')
    expect(result[2]).not.toBe(input.roles[2])
  })

  it('explicit origins preserve only mapped rows and follow renamed ids', () => {
    const input = baseline()
    Object.assign(input.roles[2]!, { opaque: { secret: 'SECRET' } })
    Object.assign(input.roles[3]!, { opaque: 'DO_NOT_INHERIT' })
    const roles = known(input).map(role => (role.id === 'worker' ? { ...role, id: 'renamed' } : role))
    frozen(input)
    const result = mergeKnownRoles(input.roles, roles, [{ id: 'renamed', sourceId: 'worker' }])
    expect(result[2]).toMatchObject({ id: 'renamed', opaque: { secret: 'SECRET' } })
    expect(result[3]).not.toHaveProperty('opaque')
    expect(input.roles[2]?.id).toBe('worker')
  })

  it('retains old nested opaque keys but drops omitted known keys on UI replacements', () => {
    const input = {
      ...baseline(),
      roles: [
        ...baseline().roles,
        {
          id: 'configured',
          enabled: true,
          description: 'Configured',
          instructions: '',
          context: 'spawn',
          readOnly: false,
          runner: { cli: 'pi', permission: 'workspace-write', model: 'old', opaque: 'SECRET' },
        },
      ],
    }
    const roles = known(input).map(role =>
      role.id === 'configured' ? { ...role, runner: { cli: 'pi' as const, permission: 'workspace-write' } } : role,
    )
    const result = mergeKnownRoles(input.roles, roles)
    expect(result.at(-1)).toHaveProperty('runner', { cli: 'pi', permission: 'workspace-write', opaque: 'SECRET' })
  })

  it('does not persist opaque incoming properties from a known projection', () => {
    const input = baseline()
    const roles = known(input).map(role =>
      role.id === 'worker' ? { ...role, description: 'Changed', injected: 'SECRET' } : role,
    )
    expect(mergeKnownRoles(input.roles, roles)[2]).not.toHaveProperty('injected')
  })

  it('serializes accepted duplicate-id repair from the first selected raw row only', () => {
    const input = baseline()
    const first = { ...input.roles[2], metadata: 'first-selected' }
    const discarded = { ...input.roles[2], metadata: 'SECRET_DISCARDED_DUPLICATE' }
    const raw = [...input.roles.slice(0, 2), first, ...input.roles.slice(3), discarded]
    const roles = known({ roles: raw })
    const merged = mergeKnownRoles(
      raw,
      roles,
      eligibleRawRoleSourceIds(raw).map(id => ({ id, sourceId: id })),
    )
    expect(merged.find(role => (role as { id: string }).id === 'worker')).toBe(first)
    expect(JSON.stringify(merged)).not.toContain('SECRET_DISCARDED_DUPLICATE')
    expect(normalizeSettings({ roles: merged }).problems).toEqual([])
    error(() => previewRoleChanges({ roles: raw }, [], 'workspace-write'), 'settings-repair-needed')
  })

  it('restores missing builtins without inventing an opaque origin', () => {
    const raw = baseline().roles.filter(role => role.builtin !== 'general')
    const sources = eligibleRawRoleSourceIds(raw)
    expect(sources).not.toContain('general')
    const roles = known({ roles: raw })
    const merged = mergeKnownRoles(
      raw,
      roles,
      sources.map(id => ({ id, sourceId: id })),
    )
    expect(merged[0]).toMatchObject({ id: 'general', builtin: 'general', enabled: false })
    expect(normalizeSettings({ roles: merged }).problems).toEqual([])
    error(() => mergeKnownRoles(raw, roles, [{ id: 'general', sourceId: 'general' }]), 'invalid-origins')
  })

  it('uses effective builtin ids and discards later repeated builtin markers', () => {
    const raw = baseline().roles.map(role =>
      role.builtin === 'general' ? { ...role, id: 'renamed_raw_id', metadata: 'first-builtin' } : role,
    )
    raw.push({ ...raw[0]!, id: 'another_raw_id', metadata: 'SECRET_DISCARDED_BUILTIN' } as (typeof raw)[number])
    const sources = eligibleRawRoleSourceIds(raw)
    expect(sources).toContain('general')
    expect(sources).not.toContain('renamed_raw_id')
    const merged = mergeKnownRoles(
      raw,
      known({ roles: raw }),
      sources.map(id => ({ id, sourceId: id })),
    )
    expect(merged[0]).toMatchObject({ id: 'general', builtin: 'general', metadata: 'first-builtin' })
    expect(JSON.stringify(merged)).not.toContain('SECRET_DISCARDED_BUILTIN')
    expect(normalizeSettings({ roles: merged }).problems).toEqual([])
  })

  it('excludes invalid and cap-trimmed raw rows from origin eligibility', () => {
    const raw = [
      null,
      { id: 'Bad ID', metadata: 'SECRET_INVALID' },
      ...Array.from({ length: MAX_ROLES + 1 }, (_, index) => ({
        id: `custom_${index}`,
        description: 'Custom',
        metadata: `raw_${index}`,
      })),
    ]
    const sources = eligibleRawRoleSourceIds(raw)
    const roles = known({ roles: raw })
    expect(sources).toEqual(Array.from({ length: MAX_ROLES - 2 }, (_, index) => `custom_${index}`))
    const merged = mergeKnownRoles(
      raw,
      roles,
      sources.map(id => ({ id, sourceId: id })),
    )
    expect(merged).toHaveLength(MAX_ROLES)
    expect(JSON.stringify(merged)).not.toContain('SECRET_INVALID')
    expect(normalizeSettings({ roles: merged }).problems).toEqual([])
    error(
      () => mergeKnownRoles(raw, roles, [{ id: 'general', sourceId: `custom_${MAX_ROLES - 1}` }]),
      'invalid-origins',
    )
  })

  it('actually removes ignored known fields during an accepted semantic repair', () => {
    const raw = baseline().roles.map(role =>
      role.builtin === 'general'
        ? { ...role, metadata: 'general-opaque', runner: { cli: 'pi', permission: 'native' } }
        : role.builtin === 'fork'
          ? { ...role, metadata: 'fork-opaque', model: { provider: 'fake', model: 'fake' }, agentPreset: 'ignored' }
          : role,
    )
    const projected = normalizeSettings({ roles: raw })
    expect(projected.problems.map(problem => problem.code)).toEqual(
      expect.arrayContaining(['builtin-runner-ignored', 'fork-model-ignored', 'fork-preset-ignored']),
    )
    const merged = mergeKnownRoles(raw, projected.settings.roles)
    expect(merged[0]).toHaveProperty('metadata', 'general-opaque')
    expect(merged[0]).not.toHaveProperty('runner')
    expect(merged[1]).toHaveProperty('metadata', 'fork-opaque')
    expect(merged[1]).not.toHaveProperty('model')
    expect(merged[1]).not.toHaveProperty('agentPreset')
    expect(normalizeSettings({ roles: merged }).problems).toEqual([])
    error(() => previewRoleChanges({ roles: raw }, [], 'full-access'), 'settings-repair-needed')
  })

  it('never evaluates nested accessors while selecting or repairing opaque sources', () => {
    const getter = vi.fn(() => {
      throw new Error('SECRET_ACCESSOR')
    })
    const model = { provider: 'fake', model: 'fake' }
    Object.defineProperty(model, 'opaque', { enumerable: true, get: getter })
    const raw = baseline().roles.map(role => (role.id === 'worker' ? { ...role, model, metadata: 'kept' } : role))
    const roles = known(baseline()).map(role =>
      role.id === 'worker' ? { ...role, model: { provider: 'fake', model: 'fake' } } : role,
    )
    const sources = eligibleRawRoleSourceIds(raw)
    const merged = mergeKnownRoles(
      raw,
      roles,
      sources.map(id => ({ id, sourceId: id })),
    )
    expect(getter).not.toHaveBeenCalled()
    expect(merged[2]).toHaveProperty('model', { provider: 'fake', model: 'fake' })
    expect(merged[2]).toHaveProperty('metadata', 'kept')
  })

  it('rejects invalid explicit mappings safely rather than guessing missing origins', () => {
    const input = baseline()
    error(() => mergeKnownRoles(input.roles, known(input), [{ id: 'worker', sourceId: 'missing' }]), 'invalid-origins')
    error(
      () =>
        mergeKnownRoles(input.roles, known(input), [
          { id: 'worker', sourceId: 'worker' },
          { id: 'worker', sourceId: 'explorer' },
        ]),
      'invalid-origins',
    )
    error(() => mergeKnownRoles(undefined, known(input)), 'settings-repair-needed')
  })
})
