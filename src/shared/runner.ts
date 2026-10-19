/**
 * The external-CLI half of the role settings contract: a role's `runner` and
 * the plugin-level `clis` settings, with their normalization rules.
 *
 * Kept apart from `roles.ts` so the DSH-only rules there stay readable;
 * `normalizeSettings` calls into this module and re-exports its types.
 * Every rule here is idempotent: a value this module produced passes through
 * it again unchanged and without a problem.
 */

import { CLI_IDS, type CliDescriptor, type CliId, cliDescriptor, isCliId, presetAccess } from './cli/index.ts'

/** Runs the role's child on a host CLI instead of DSH. Absent = DSH in-process child. */
export interface RoleRunner {
  cli: CliId
  /** CLI-native model id/alias; omitted = the CLI's configured default (never omitted for OpenCode). */
  model?: string
  /** OpenCode only; always set together with `model` there. */
  provider?: string
  /** One of the descriptor's efforts (free text for OpenCode); omitted = the model's default. */
  effort?: string
  /** One of the descriptor's permission preset ids. */
  permission: string
  /** Wall-clock limit, integer 1..1440; omitted = {@link DEFAULT_RUNNER_TIMEOUT_MINUTES}. */
  timeoutMinutes?: number
}

/** Plugin-level settings of one CLI. Never holds secrets. */
export interface CliSettings {
  /** Absolute path or bare PATH name; omitted = the descriptor's executable. */
  executable?: string
  /** Names of Host environment variables forwarded to the CLI (values are read at spawn time). */
  envPassthrough?: string[]
}

/** Settings of every configured CLI. */
export type CliSettingsMap = Partial<Record<CliId, CliSettings>>

export const DEFAULT_RUNNER_TIMEOUT_MINUTES = 30
export const MAX_RUNNER_TIMEOUT_MINUTES = 1_440
export const MAX_RUNNER_NAME_LENGTH = 128
export const MAX_EXECUTABLE_LENGTH = 4_096
export const MAX_ENV_PASSTHROUGH = 32
export const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Problem codes this module reports (a subset of `SettingsProblem['code']`). */
export type RunnerProblemCode =
  | 'invalid-runner'
  | 'invalid-runner-model'
  | 'invalid-runner-effort'
  | 'invalid-runner-permission'
  | 'runner-readonly-permission'
  | 'invalid-runner-timeout'
  | 'invalid-cli-settings'

/** Receives one adjustment. */
export type ReportProblem = (code: RunnerProblemCode, message: string) => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether a stored field counts as "not set": undefined, null or the empty string. */
function unset(value: unknown): boolean {
  return value === undefined || value === null || value === ''
}

function name(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 || trimmed.length > MAX_RUNNER_NAME_LENGTH ? undefined : trimmed
}

/** The role a runner belongs to, as far as runner rules care. */
export interface RunnerOwner {
  readonly id: string
  readonly readOnly: boolean
  readonly enabled: boolean
}

/** Result of {@link normalizeRunner}. */
export interface NormalizedRunner {
  /** The runner, or undefined when it was dropped (`invalid-runner`). */
  readonly runner?: RoleRunner
  /** True when the role must be switched off (an OpenCode role without provider + model). */
  readonly disable: boolean
}

/**
 * Whether a raw stored runner names a supported CLI, i.e. the role will run externally.
 * @param raw - the stored `runner` value.
 * @returns true when {@link normalizeRunner} keeps a runner for it.
 */
export function isRunnerShape(raw: unknown): boolean {
  return isRecord(raw) && isCliId(raw.cli)
}

function normalizeModel(
  raw: Record<string, unknown>,
  descriptor: CliDescriptor,
  owner: RunnerOwner,
  report: ReportProblem,
): { model?: string; provider?: string; disable: boolean } {
  const model = name(raw.model)
  const provider = name(raw.provider)
  const badModel = !unset(raw.model) && model === undefined
  const badProvider = !unset(raw.provider) && (provider === undefined || !descriptor.needsProvider)
  const half = descriptor.needsProvider && (model === undefined) !== (provider === undefined)
  const invalid = badModel || badProvider || half
  if (invalid) {
    report(
      'invalid-runner-model',
      descriptor.needsProvider
        ? `role "${owner.id}" on ${descriptor.displayName} needs both a provider and a model (each 1-${MAX_RUNNER_NAME_LENGTH} characters)`
        : `model of role "${owner.id}" must be 1-${MAX_RUNNER_NAME_LENGTH} characters; ${descriptor.displayName} has no provider field. The CLI's default model is used instead`,
    )
  }
  const kept = invalid
    ? {}
    : { ...(model === undefined ? {} : { model }), ...(provider === undefined ? {} : { provider }) }
  if (descriptor.needsProvider && kept.model === undefined && owner.enabled) {
    // Never fall back to the CLI's own (possibly remote, free) default model: switch the role off instead.
    if (!invalid) {
      report(
        'invalid-runner-model',
        `role "${owner.id}" on ${descriptor.displayName} needs a provider and a model; it is switched off until both are set`,
      )
    }
    return { ...kept, disable: true }
  }
  return { ...kept, disable: false }
}

function normalizeEffort(
  raw: unknown,
  descriptor: CliDescriptor,
  owner: RunnerOwner,
  report: ReportProblem,
): string | undefined {
  if (unset(raw)) return undefined
  const effort = name(raw)
  if (effort !== undefined && (descriptor.effortFreeText || descriptor.efforts.includes(effort))) return effort
  report(
    'invalid-runner-effort',
    descriptor.effortFreeText || descriptor.efforts.length === 0
      ? `effort of role "${owner.id}" is not a valid name; the model's default effort is used`
      : `effort of role "${owner.id}" must be one of ${descriptor.efforts.join(', ')}; the model's default effort is used`,
  )
  return undefined
}

function normalizePermission(
  raw: unknown,
  descriptor: CliDescriptor,
  owner: RunnerOwner,
  report: ReportProblem,
): string {
  let permission = typeof raw === 'string' ? raw : ''
  if (presetAccess(descriptor, permission) === undefined) {
    report(
      'invalid-runner-permission',
      `permission of role "${owner.id}" must be one of ${descriptor.permissions.map(preset => preset.id).join(', ')}; it uses ${descriptor.defaultPermission}`,
    )
    permission = descriptor.defaultPermission
  }
  if (owner.readOnly && presetAccess(descriptor, permission) !== 'read-only') {
    const readOnly = descriptor.presetForAccess['read-only']
    report(
      'runner-readonly-permission',
      `role "${owner.id}" is read-only, so it uses ${descriptor.displayName}'s ${readOnly} permission`,
    )
    permission = readOnly
  }
  return permission
}

function normalizeTimeout(raw: unknown, owner: RunnerOwner, report: ReportProblem): number | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= MAX_RUNNER_TIMEOUT_MINUTES) return raw
  report(
    'invalid-runner-timeout',
    `timeout of role "${owner.id}" must be a whole number of minutes from 1 to ${MAX_RUNNER_TIMEOUT_MINUTES}; it uses ${DEFAULT_RUNNER_TIMEOUT_MINUTES}`,
  )
  return undefined
}

/**
 * Validate and repair one stored runner. Built-in roles, fork rules and DSH-only
 * fields are the caller's concern (see `normalizeSettings`).
 * @param raw - the stored `runner` value (not undefined/null).
 * @param owner - the role it belongs to.
 * @param report - receives each adjustment.
 * @returns the runner (or none when it is unusable) and whether the role must be switched off.
 */
export function normalizeRunner(raw: unknown, owner: RunnerOwner, report: ReportProblem): NormalizedRunner {
  if (!isRecord(raw) || !isCliId(raw.cli)) {
    report(
      'invalid-runner',
      `runner of role "${owner.id}" must name one of ${CLI_IDS.join(', ')}; the role runs on DSH instead`,
    )
    return { disable: false }
  }
  const descriptor = cliDescriptor(raw.cli)
  const { model, provider, disable } = normalizeModel(raw, descriptor, owner, report)
  const effort = normalizeEffort(raw.effort, descriptor, owner, report)
  const permission = normalizePermission(raw.permission, descriptor, owner, report)
  const timeoutMinutes = normalizeTimeout(raw.timeoutMinutes, owner, report)
  const runner: RoleRunner = {
    cli: descriptor.id,
    ...(model === undefined ? {} : { model }),
    ...(provider === undefined ? {} : { provider }),
    ...(effort === undefined ? {} : { effort }),
    permission,
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
  }
  return { runner, disable }
}

/**
 * Whether an executable setting is an absolute path (POSIX or Windows) or a bare
 * PATH name. Relative paths with a separator are rejected, as DSH's subprocess
 * service rejects them too.
 * @param value - a trimmed, non-empty executable setting.
 * @returns true when it is usable.
 */
export function isUsableExecutable(value: string): boolean {
  if (value.length > MAX_EXECUTABLE_LENGTH || /[\u0000-\u001f]/.test(value)) return false
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')) return true
  return !/[\\/]/.test(value)
}

function normalizeCliEntry(id: CliId, raw: unknown, report: ReportProblem): CliSettings | undefined {
  const label = cliDescriptor(id).displayName
  if (!isRecord(raw)) {
    report('invalid-cli-settings', `settings of ${label} are not an object and are ignored`)
    return undefined
  }
  const settings: CliSettings = {}
  if (!unset(raw.executable)) {
    const executable = typeof raw.executable === 'string' ? raw.executable.trim() : ''
    if (executable !== '' && isUsableExecutable(executable)) settings.executable = executable
    else {
      report(
        'invalid-cli-settings',
        `executable of ${label} must be an absolute path or a bare command name; the default "${cliDescriptor(id).executable}" is used`,
      )
    }
  }
  if (raw.envPassthrough !== undefined && raw.envPassthrough !== null) {
    const names = raw.envPassthrough
    if (
      !Array.isArray(names) ||
      names.length > MAX_ENV_PASSTHROUGH ||
      !names.every(entry => typeof entry === 'string' && ENV_NAME_PATTERN.test(entry))
    ) {
      report(
        'invalid-cli-settings',
        `forwarded variables of ${label} must be at most ${MAX_ENV_PASSTHROUGH} names like MY_API_KEY; none are forwarded`,
      )
    } else if (names.length > 0) settings.envPassthrough = [...new Set(names as string[])]
  }
  return Object.keys(settings).length === 0 ? undefined : settings
}

/**
 * Validate and repair the stored `clis` settings. Unknown CLIs and malformed
 * fields are dropped; empty entries are omitted.
 * @param raw - the stored value (not undefined/null).
 * @param report - receives each adjustment.
 * @returns the settings, or undefined when nothing usable remains.
 */
export function normalizeClis(raw: unknown, report: ReportProblem): CliSettingsMap | undefined {
  if (!isRecord(raw)) {
    report('invalid-cli-settings', 'external CLI settings are not an object and are ignored')
    return undefined
  }
  const result: CliSettingsMap = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!isCliId(key)) {
      report('invalid-cli-settings', `"${key}" is not a supported CLI; its settings are ignored`)
      continue
    }
    const entry = normalizeCliEntry(key, value, report)
    if (entry !== undefined) result[key] = entry
  }
  // Keep a stable key order so a round trip compares equal.
  const ordered: CliSettingsMap = {}
  for (const id of CLI_IDS) {
    const entry = result[id]
    if (entry !== undefined) ordered[id] = entry
  }
  return Object.keys(ordered).length === 0 ? undefined : ordered
}

/**
 * The wall-clock limit of a runner in milliseconds.
 * @param runner - a normalized runner.
 * @returns its timeout, or the default.
 */
export function runnerTimeoutMs(runner: RoleRunner): number {
  return (runner.timeoutMinutes ?? DEFAULT_RUNNER_TIMEOUT_MINUTES) * 60_000
}
