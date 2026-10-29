/** One-shot delegate settings. Never edit a catalog role or infer a provider/model route. */
import { cliDescriptor } from './cli/index.ts'
import { MAX_NAME_LENGTH, normalizeSettings, type RoleDefinition } from './roles.ts'

export interface DelegationOverrides {
  provider?: string
  model?: string
  effort?: string
  readOnly?: boolean
}

export interface DelegationArgs extends DelegationOverrides {
  description: string
  prompt: string
  role?: string
  cwd?: string
}

const ARGUMENTS = new Set(['description', 'prompt', 'role', 'cwd', 'provider', 'model', 'effort', 'readOnly'])

/** Also validate direct execute calls, which can bypass the tool JSON schema. */
export function validateDelegationArgs(raw: unknown): DelegationArgs {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('delegate arguments must be an object')
  const args = raw as Record<string, unknown>
  for (const key of Object.keys(args)) {
    if (!ARGUMENTS.has(key)) throw new Error(`unknown delegate argument "${key}"`)
  }
  for (const key of ['description', 'prompt']) {
    if (typeof args[key] !== 'string') throw new Error(`delegate ${key} must be a string`)
  }
  for (const key of ['role', 'cwd']) {
    if (args[key] !== undefined && typeof args[key] !== 'string') throw new Error(`delegate ${key} must be a string`)
  }
  validateOverrides(args)
  return args as unknown as DelegationArgs
}

function validateOverrides(args: DelegationOverrides): void {
  for (const key of ['provider', 'model', 'effort'] as const) {
    const value = args[key]
    if (
      value !== undefined &&
      (typeof value !== 'string' ||
        value.trim().length === 0 ||
        value.trim().length > MAX_NAME_LENGTH ||
        /[\u0000-\u001f\u007f]/u.test(value))
    ) {
      throw new Error(
        `delegate ${key} must be a non-empty string of at most ${MAX_NAME_LENGTH} characters without control characters`,
      )
    }
  }
  if (args.readOnly !== undefined && args.readOnly !== true)
    throw new Error('delegate readOnly may only be true; permissions cannot be weakened')
}

/** Clone and normalize the selected role for this run only. Unsupported fields fail closed. */
export function resolveDelegationOverrides(base: RoleDefinition, args: DelegationOverrides): RoleDefinition {
  validateOverrides(args)
  const routeOverride = args.model !== undefined || args.provider !== undefined || args.effort !== undefined
  if (routeOverride && base.runner !== undefined) {
    throw new Error(
      'one-shot model/provider/effort overrides are supported only for DSH roles; external CLI runners have adapter-specific settings, so select a configured CLI role instead',
    )
  }
  if (routeOverride && base.context === 'fork')
    throw new Error('fork roles inherit their model; one-shot model/provider/effort overrides require a spawn role')
  if ((args.provider === undefined) !== (args.model === undefined))
    throw new Error('delegate provider and model must be supplied together')
  const role = structuredClone(base)
  if (args.model !== undefined && args.provider !== undefined) {
    // A replacement route must not carry the old role's (or parent's) effort.
    role.model = { provider: args.provider.trim(), model: args.model.trim() }
  }
  if (args.effort !== undefined) {
    if (role.model === undefined)
      throw new Error('delegate effort requires a configured role model or an explicit provider/model pair')
    role.model.reasoningEffort = args.effort.trim()
  }
  if (args.readOnly === true) {
    role.readOnly = true
    if (role.runner !== undefined) {
      const preset = cliDescriptor(role.runner.cli).presetForAccess['read-only']
      if (preset === undefined) throw new Error(`role "${role.id}": external CLI has no supported read-only preset`)
      role.runner.permission = preset
    }
  }
  const normalized = normalizeSettings({ enabled: true, roles: [role] })
  const problems = normalized.problems.filter(problem => problem.code !== 'builtin-missing')
  if (problems.length > 0)
    throw new Error(`invalid delegated role: ${problems.map(problem => problem.message).join('; ')}`)
  const result = normalized.settings.roles.find(entry => entry.id === role.id)
  if (result === undefined || !result.enabled) throw new Error(`role "${role.id}" is not available for delegation`)
  return result
}
