/**
 * Fail-closed rules for external runs: the access ceiling, the effective
 * permission preset, the delegation depth, and working-directory checks.
 *
 * An external child never gets more access than its role allows nor more than
 * the delegating parent has; DSH's own sandbox and approvals do not reach it,
 * so these checks are the only gate.
 */

import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { ACCESS_ORDER, type AccessLevel, type CliDescriptor, presetAccess } from '../../shared/cli/index.ts'
import type { RoleRunner } from '../../shared/runner.ts'
import type { AgentPort, SandboxPolicyPort } from '../ports.ts'

/**
 * Map a DSH sandbox mode to an access level. Unknown or missing modes count as
 * `workspace-write` (DSH's approval presets such as `auto` write the workspace).
 * @param mode - `sandboxPolicy.resolve(...).mode`.
 * @returns the matching level.
 */
export function accessOfSandboxMode(mode: string | undefined): AccessLevel {
  if (mode === 'read-only') return 'read-only'
  if (mode === 'danger-full-access') return 'full-access'
  return 'workspace-write'
}

/** The parent's limits for one delegation. */
export interface Ceiling {
  /** The most a child of this parent may do. */
  readonly access: AccessLevel
  /** The parent's workspace root, when known (`sandboxPolicy`). */
  readonly workspaceRoot?: string
}

/**
 * The ceiling an external child of `parent` runs under.
 * @param parent - the delegating Agent.
 * @param parentReadOnly - whether the parent's own role is read-only.
 * @param sandbox - the optional `sandboxPolicy` service.
 * @returns `read-only` for a read-only parent, else the parent's resolved sandbox level, plus its workspace root.
 */
export function accessCeiling(
  parent: AgentPort,
  parentReadOnly: boolean,
  sandbox: SandboxPolicyPort | undefined,
): Ceiling {
  let mode: string | undefined
  let workspaceRoot: string | undefined
  try {
    const policy = sandbox?.resolve({ session: parent.session })
    mode = policy?.mode
    workspaceRoot = typeof policy?.workspaceRoot === 'string' ? policy.workspaceRoot : undefined
  } catch {
    // An unresolvable policy is treated like a missing service.
  }
  const access = parentReadOnly ? 'read-only' : accessOfSandboxMode(mode)
  return { access, ...(workspaceRoot === undefined ? {} : { workspaceRoot }) }
}

/** The preset a run actually uses. */
export interface EffectivePermission {
  readonly preset: string
  readonly access: AccessLevel
  /** True when the role's own preset was above the ceiling and was lowered. */
  readonly lowered: boolean
}

/**
 * Lower a runner's preset to the ceiling when needed; never widen it.
 * @param descriptor - the runner's CLI.
 * @param runner - the normalized runner.
 * @param ceiling - the most the child may do.
 * @returns the role's preset when it fits, else the CLI's preset for the ceiling level.
 * @throws when the runner's preset is unknown (normalization prevents this).
 */
export function effectivePermission(
  descriptor: CliDescriptor,
  runner: RoleRunner,
  ceiling: AccessLevel,
): EffectivePermission {
  const level = presetAccess(descriptor, runner.permission)
  if (level === undefined) throw new Error(`unknown ${descriptor.displayName} permission "${runner.permission}"`)
  if (ACCESS_ORDER[level] <= ACCESS_ORDER[ceiling]) return { preset: runner.permission, access: level, lowered: false }
  return { preset: descriptor.presetForAccess[ceiling], access: ceiling, lowered: true }
}

/**
 * Refuse a delegation that would exceed DSH's depth limit (DSH does not check external children).
 * @param parent - the delegating Agent.
 * @param maxDepth - `ctx.subagents.resolveMaxDepth(undefined)`.
 * @throws when the child's depth would exceed the limit.
 */
export function assertDepth(parent: AgentPort, maxDepth: number | undefined): void {
  const depth = parent.session.header.delegationDepth ?? 0
  if (maxDepth !== undefined && depth + 1 > maxDepth) {
    throw new Error(`delegation depth limit reached (current ${depth}, maximum ${maxDepth}); do the work directly`)
  }
}

/**
 * Assert a working directory is absolute and an existing directory the Host can enter
 * (as `@deepseek-ai/dsh-subagent`'s `assertUsableCwd`).
 * @param cwd - the candidate directory.
 * @returns `cwd`.
 * @throws a message naming the directory when it is unusable.
 */
export function assertUsableCwd(cwd: string): string {
  if (!isAbsolute(cwd)) throw new Error(`the working directory must be an absolute path: ${cwd}`)
  try {
    if (!statSync(cwd).isDirectory()) throw new Error('not a directory')
    accessSync(cwd, constants.X_OK)
  } catch {
    throw new Error(`the working directory is not an accessible directory: ${cwd}`)
  }
  return cwd
}

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Whether `path` is `root` or inside it, after resolving symbolic links.
 * @param root - the containing directory.
 * @param path - the candidate.
 * @returns true when contained.
 */
export function isInside(root: string, path: string): boolean {
  const rel = relative(real(root), real(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Below full access, the child must stay inside the parent's workspace.
 * @param cwd - the child's validated working directory.
 * @param access - the run's effective access.
 * @param workspaceRoot - the parent's workspace root; unknown skips the check.
 * @throws when the directory is outside the workspace.
 */
export function assertCwdAllowed(cwd: string, access: AccessLevel, workspaceRoot: string | undefined): void {
  if (access === 'full-access' || workspaceRoot === undefined) return
  if (!isInside(workspaceRoot, cwd)) {
    throw new Error(`the working directory ${cwd} is outside the parent's workspace ${workspaceRoot}`)
  }
}
