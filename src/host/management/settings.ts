/** Canonical profile writer for this plugin only. Never edits files, Volatiles or Session snapshots. */
import { literalRoleSettings, type RoleWriteSafety } from './literal.ts'
export interface ManagementSettingsDescriptor {
  readonly ns: string
  readonly value: unknown
  readonly revision: number
}
export interface ManagementSettingsPort {
  readonly writable: boolean
  describe(options?: { redactSecrets?: boolean }): readonly ManagementSettingsDescriptor[]
  mutate(
    ns: string,
    ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[],
    expectedRevision: number,
  ): Promise<void>
}
export interface ManagementSettingsRead {
  readonly namespace: string
  readonly revision: number
  readonly value: Readonly<Record<string, unknown>>
  readonly allowed: boolean
  readonly writable: boolean
  readonly literalRolesSupported: boolean
}
export class ManagementFailure extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ManagementFailure'
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Standard single-entry client namespace; a rebound/ambiguous instance must not edit a different row. */
export function ownManagementNamespace(ctx: unknown): () => string | undefined {
  const context = ctx as { fiber?: { entry?: { options?: { id?: unknown }; fiber?: unknown } } }
  let binding: { fiber: unknown; entry: unknown; owner: unknown } | undefined
  return () => {
    const fiber = context.fiber
    const entry = fiber?.entry
    const ns = entry?.options?.id
    if (ns !== 'rolesubagents' || !entry?.fiber) return undefined
    binding ??= { fiber, entry, owner: entry.fiber }
    return binding.fiber === fiber && binding.entry === entry && binding.owner === entry.fiber ? ns : undefined
  }
}

export function ownManagementRawConfig(ctx: unknown, namespace: () => string | undefined): () => unknown {
  return () => {
    if (!namespace())
      throw new ManagementFailure('settings-unavailable', 'The owning configuration entry is unavailable.')
    const entry = (ctx as { fiber?: { entry?: { options?: { config?: unknown } } } }).fiber?.entry
    if (!entry?.options)
      throw new ManagementFailure('settings-unavailable', 'The owning raw configuration is unavailable.')
    return entry.options.config ?? {}
  }
}

export function managementSettings(deps: {
  settings: () => unknown
  namespace: () => string | undefined
  rawConfig?: () => unknown
}) {
  function read(): ManagementSettingsRead {
    const namespace = deps.namespace()
    const candidate = deps.settings()
    if (
      !namespace ||
      !record(candidate) ||
      typeof candidate.describe !== 'function' ||
      typeof candidate.mutate !== 'function'
    ) {
      throw new ManagementFailure(
        'settings-unavailable',
        'The role settings service or this plugin instance is unavailable.',
      )
    }
    const service = candidate as unknown as ManagementSettingsPort
    const found = service.describe().filter(item => item.ns === namespace)
    if (
      found.length !== 1 ||
      !record(found[0]?.value) ||
      !Number.isSafeInteger(found[0]?.revision) ||
      found[0]!.revision < 0
    ) {
      throw new ManagementFailure('settings-unavailable', 'This plugin has no unique active settings namespace.')
    }
    const descriptor = found[0]!
    const value = descriptor.value as Record<string, unknown>
    return {
      namespace,
      value,
      revision: descriptor.revision,
      allowed: value.allowAiRoleManagement === true,
      writable: service.writable === true,
      literalRolesSupported: literalRoleSettings(deps.rawConfig ? deps.rawConfig() : value),
    }
  }
  async function writeRoles(
    expected: ManagementSettingsRead,
    roles: readonly unknown[],
  ): Promise<{ committed: true; observed?: ManagementSettingsRead }> {
    const current = read()
    if (!current.allowed) throw new ManagementFailure('management-disabled', 'AI role management is disabled.')
    if (!current.literalRolesSupported)
      throw new ManagementFailure(
        'expression-backed-role-settings',
        'Executable or nonliteral role configuration must be edited through the native profile, not restated as evaluated values.',
      )
    if (!current.writable)
      throw new ManagementFailure('settings-read-only', 'The active profile does not accept role settings writes.')
    if (current.namespace !== expected.namespace || current.revision !== expected.revision)
      throw new ManagementFailure(
        'revision-conflict',
        'Role settings changed. Read them again and preview a new change; nothing was overwritten.',
      )
    const service = deps.settings() as ManagementSettingsPort
    try {
      // Host settings.mutate checks the fence INSIDE the profile's file lock. OFF is fenced by the same revision.
      await service.mutate(current.namespace, [{ op: 'set', path: ['roles'], value: roles }], current.revision)
    } catch (error) {
      if (record(error) && error.code === 'SETTINGS_CONFLICT')
        throw new ManagementFailure(
          'revision-conflict',
          'Role settings changed before commit. Nothing was overwritten; preview again.',
        )
      throw new ManagementFailure(
        'settings-write-failed',
        'The Host could not persist the role changes. Read the current settings before retrying.',
      )
    }
    // The write committed. A later read failure must not be reported as an unapplied write.
    try {
      return { committed: true, observed: read() }
    } catch {
      return { committed: true }
    }
  }
  function writeSafety(expectedRevision: number): RoleWriteSafety {
    try {
      // Reject executable syntax before asking the SDK to project/interpolate any settings values.
      if (deps.rawConfig && !literalRoleSettings(deps.rawConfig()))
        return { safe: false, reason: 'expression-backed-role-settings' }
      const current = read()
      if (current.revision !== expectedRevision)
        return { safe: false, revision: current.revision, reason: 'revision-conflict' }
      return {
        safe: current.literalRolesSupported,
        revision: current.revision,
        reason: current.literalRolesSupported ? 'literal-role-settings' : 'expression-backed-role-settings',
      }
    } catch {
      return { safe: false, reason: 'safety-unavailable' }
    }
  }
  return { read, writeRoles, writeSafety }
}
