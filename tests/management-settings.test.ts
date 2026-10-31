import { describe, expect, it, vi } from 'vitest'
import {
  managementSettings,
  ownManagementNamespace,
  ManagementFailure,
  type ManagementSettingsPort,
} from '../src/host/management/settings.ts'
import { DEFAULT_ROLES } from '../src/shared/roles.ts'

function setup() {
  const state = {
    revision: 4,
    value: {
      allowAiRoleManagement: true,
      enabled: true,
      roles: structuredClone(DEFAULT_ROLES),
      clis: { pi: { executable: '/never-run/pi' } },
      workflowModel: null,
      opaque: 'SECRET_UNRELATED',
    },
    writable: true,
    descriptors: 1,
    readFailure: false,
    writeFailure: false,
    postCommitReadFailure: false,
  }
  let beforeCommit: undefined | (() => void | Promise<void>)
  const service: ManagementSettingsPort = {
    get writable() {
      return state.writable
    },
    describe: vi.fn(() => {
      if (state.readFailure) throw new Error('SECRET_READ')
      return Array.from({ length: state.descriptors }, () => ({
        ns: 'rolesubagents',
        revision: state.revision,
        value: structuredClone(state.value),
      }))
    }),
    mutate: vi.fn(async (ns, ops, revision) => {
      await beforeCommit?.()
      if (ns !== 'rolesubagents' || revision !== state.revision)
        throw Object.assign(new Error('SECRET_CONFLICT'), { code: 'SETTINGS_CONFLICT' })
      if (state.writeFailure) throw new Error('SECRET_WRITE')
      expect(ops).toHaveLength(1)
      expect(ops[0]).toMatchObject({ op: 'set', path: ['roles'] })
      state.value = { ...state.value, roles: structuredClone(ops[0]!.value) as typeof state.value.roles }
      state.revision++
      if (state.postCommitReadFailure) state.readFailure = true
    }),
  }
  const writer = managementSettings({ settings: () => service, namespace: () => 'rolesubagents' })
  return {
    state,
    service,
    writer,
    beforeCommit: (hook: typeof beforeCommit) => {
      beforeCommit = hook
    },
    manualGate: (allowed: boolean) => {
      state.value.allowAiRoleManagement = allowed
      state.revision++
    },
  }
}
async function rejects(run: () => unknown | Promise<unknown>, code: string) {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(ManagementFailure)
    expect((error as ManagementFailure).code).toBe(code)
    expect((error as Error).message).not.toContain('SECRET')
    return
  }
  throw new Error('expected settings rejection')
}

describe('owned role settings namespace', () => {
  it('uses options.id, not a qualified Entry.id or arbitrary caller namespace', () => {
    const owner = {}
    const ctx = {
      fiber: { entry: { id: 'qualified/tree/rolesubagents', options: { id: 'rolesubagents' }, fiber: owner } },
    }
    expect(ownManagementNamespace(ctx)()).toBe('rolesubagents')
    expect(
      ownManagementNamespace({
        fiber: { entry: { id: 'rolesubagents', options: { id: 'other-entry' }, fiber: owner } },
      })(),
    ).toBeUndefined()
    expect(ownManagementNamespace({})()).toBeUndefined()
    expect(ownManagementNamespace({ fiber: { entry: { options: { id: 'rolesubagents' } } } })()).toBeUndefined()
  })
  it('fences replacement of the fiber, entry or entry owner after initial binding', () => {
    for (const replace of ['fiber', 'entry', 'owner'] as const) {
      const ctx = { fiber: { entry: { options: { id: 'rolesubagents' }, fiber: {} } } }
      const ns = ownManagementNamespace(ctx)
      expect(ns()).toBe('rolesubagents')
      if (replace === 'fiber') ctx.fiber = { ...ctx.fiber }
      if (replace === 'entry') ctx.fiber.entry = { ...ctx.fiber.entry }
      if (replace === 'owner') ctx.fiber.entry.fiber = {}
      expect(ns()).toBeUndefined()
    }
  })
})

describe('canonical roles-only settings persistence', () => {
  it('reads gate and roles from one authoritative described revision', () => {
    const t = setup()
    const value = t.writer.read()
    expect(value).toMatchObject({ namespace: 'rolesubagents', revision: 4, allowed: true, writable: true })
    expect(value.value.roles).toEqual(DEFAULT_ROLES)
    expect(t.service.describe).toHaveBeenCalledTimes(1)
  })
  it.each([undefined, {}, { describe: () => [], mutate: undefined }])(
    'refuses missing/incompatible services',
    candidate => {
      const writer = managementSettings({ settings: () => candidate, namespace: () => 'rolesubagents' })
      expect(() => writer.read()).toThrow(ManagementFailure)
    },
  )
  it('refuses unavailable, duplicated or malformed namespace descriptors', () => {
    const t = setup()
    for (const descriptors of [0, 2]) {
      t.state.descriptors = descriptors
      expect(() => t.writer.read()).toThrow(ManagementFailure)
    }
    const writer = managementSettings({ settings: () => t.service, namespace: () => undefined })
    expect(() => writer.read()).toThrow(ManagementFailure)
    const malformed = managementSettings({
      settings: () => ({ ...t.service, describe: () => [{ ns: 'rolesubagents', revision: -1, value: {} }] }),
      namespace: () => 'rolesubagents',
    })
    expect(() => malformed.read()).toThrow(ManagementFailure)
  })
  it('writes only roles with the exact revision, preserving every unrelated setting', async () => {
    const t = setup()
    const old = t.writer.read()
    const before = structuredClone(t.state.value)
    const roles = structuredClone(DEFAULT_ROLES).filter(role => role.id !== 'worker')
    const result = await t.writer.writeRoles(old, roles)
    expect(t.service.mutate).toHaveBeenCalledWith('rolesubagents', [{ op: 'set', path: ['roles'], value: roles }], 4)
    expect(result).toMatchObject({ committed: true, observed: { revision: 5 } })
    expect({ ...t.state.value, roles: before.roles }).toEqual(before)
  })
  it('refuses OFF and nonwritable settings without calling persistence', async () => {
    const t = setup()
    const old = t.writer.read()
    t.manualGate(false)
    await rejects(() => t.writer.writeRoles(old, old.value.roles as unknown[]), 'management-disabled')
    t.manualGate(true)
    t.state.writable = false
    await rejects(() => t.writer.writeRoles(t.writer.read(), []), 'settings-read-only')
    expect(t.service.mutate).not.toHaveBeenCalled()
  })
  it('rejects stale revisions and namespace mismatches without retry', async () => {
    const t = setup()
    const old = t.writer.read()
    t.state.revision++
    await rejects(() => t.writer.writeRoles(old, []), 'revision-conflict')
    await rejects(
      () => t.writer.writeRoles({ ...t.writer.read(), namespace: 'another-plugin' }, []),
      'revision-conflict',
    )
    expect(t.service.mutate).not.toHaveBeenCalled()
  })
  it.each(['off', 'off-on'] as const)('CAS fences a queued writer when %s commits first', async mode => {
    const t = setup()
    const old = t.writer.read()
    t.beforeCommit(() => {
      t.manualGate(false)
      if (mode === 'off-on') t.manualGate(true)
    })
    await rejects(() => t.writer.writeRoles(old, []), 'revision-conflict')
    expect(t.state.value.roles).toEqual(DEFAULT_ROLES)
    expect(t.service.mutate).toHaveBeenCalledTimes(1)
  })
  it('allows only one of two concurrent writes at the same revision', async () => {
    const t = setup()
    const old = t.writer.read()
    const outcomes = await Promise.allSettled([t.writer.writeRoles(old, []), t.writer.writeRoles(old, [])])
    expect(outcomes.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(t.state.revision).toBe(5)
    expect(t.service.mutate).toHaveBeenCalledTimes(2)
  })
  it('reports persistence failure with a fixed diagnostic and no success state', async () => {
    const t = setup()
    const old = t.writer.read()
    t.state.writeFailure = true
    await rejects(() => t.writer.writeRoles(old, []), 'settings-write-failed')
    expect(t.state.revision).toBe(4)
    expect(t.state.value.roles).toEqual(DEFAULT_ROLES)
    expect(t.service.mutate).toHaveBeenCalledTimes(1)
  })
  it('does not label an already committed write unapplied when readback fails', async () => {
    const t = setup()
    t.state.postCommitReadFailure = true
    expect(await t.writer.writeRoles(t.writer.read(), [])).toEqual({ committed: true })
    expect(t.state.value.roles).toEqual([])
    expect(t.state.revision).toBe(5)
  })
})
