/**
 * Workspace integrity checks the engine runs before a CLI whose limits are enforced by its own tool
 * permissions (`tool-scope` presets) may write.
 *
 * Such a CLI confines its file tools to a directory by path checks, not by an operating-system sandbox,
 * so (verified with the real CLIs, see `docs/external-cli.md`):
 * - OpenCode's scope is the whole git worktree around its directory, not the directory itself;
 * - every such CLI follows symbolic links, so a link inside the directory that leads elsewhere lets a
 *   write land outside the workspace;
 * - OpenCode loads project plugins (`.opencode/plugin`) at start even with its project config disabled.
 * The checks only read the filesystem. Internal directory links are followed once per real path. Hard links are not
 * detected (a hard-linked file inside the directory is the same file as its other names).
 */

import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { isInside } from './policy.ts'

/** Most directory entries the symbolic-link scan looks at. */
export const SCAN_MAX_ENTRIES = 100_000

/** Longest the symbolic-link scan may take, in milliseconds. */
export const SCAN_MAX_MS = 2_000

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch {
    return false
  }
}

async function realOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return resolve(path)
  }
}

/**
 * The top-level of the git worktree that contains `cwd`, when it lies above `cwd` (a `.git` directory or
 * file found walking up from the real path of `cwd`; no git binary is needed).
 * @param cwd - an existing directory.
 * @returns the top-level directory, or undefined when `cwd` is not in a worktree or is its top-level.
 */
export async function gitTopLevelAbove(cwd: string): Promise<string | undefined> {
  const start = await realOrResolved(cwd)
  if (await exists(join(start, '.git'))) return undefined
  for (let dir = dirname(start); ; dir = dirname(dir)) {
    if (await exists(join(dir, '.git'))) return dir
    if (dirname(dir) === dir) return undefined
  }
}

/**
 * The git top-level that contains `cwd` (itself included), if any.
 * @param cwd - an existing directory.
 * @returns the top-level directory or undefined.
 */
async function gitTopLevel(cwd: string): Promise<string | undefined> {
  const start = await realOrResolved(cwd)
  for (let dir = start; ; dir = dirname(dir)) {
    if (await exists(join(dir, '.git'))) return dir
    if (dirname(dir) === dir) return undefined
  }
}

/**
 * The first of `names` (relative directory names such as `.opencode/plugin`) that exists in `cwd` or one of
 * its parents up to the enclosing git top-level (to the filesystem root outside git). The user's home
 * directory itself is skipped: what is there is the user's own configuration.
 * @param cwd - an existing directory.
 * @param names - relative names to look for.
 * @param home - the user's home directory.
 * @returns the path found, or undefined.
 */
export async function findStartupCodeDir(
  cwd: string,
  names: readonly string[],
  home: string | undefined,
): Promise<string | undefined> {
  if (names.length === 0) return undefined
  const start = await realOrResolved(cwd)
  const stop = (await gitTopLevel(start)) ?? undefined
  const realHome = home === undefined ? undefined : await realOrResolved(home)
  for (let dir = start; ; dir = dirname(dir)) {
    if (dir !== realHome) {
      for (const name of names) if (await exists(join(dir, name))) return join(dir, name)
    }
    if (dir === stop || dirname(dir) === dir) return undefined
  }
}

/** Why the symbolic-link scan refuses. */
export type LinkScanFinding =
  | { readonly kind: 'link'; readonly path: string }
  | { readonly kind: 'budget' }
  | { readonly kind: 'unreadable'; readonly path: string }

/** Limits of {@link findEscapingLink}; tests pass small ones. */
export interface LinkScanLimits {
  readonly maxEntries?: number
  readonly maxMs?: number
  readonly now?: () => number
}

/** Resolve missing descendants against the nearest existing real ancestor. */
async function futureRealPath(path: string): Promise<string> {
  let current = path
  const missing: string[] = []
  for (;;) {
    try {
      return join(await realpath(current), ...missing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(current) === current) throw error
      // Do not treat an unresolved link as an ordinary missing path component.
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error('unresolved symbolic link')
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') throw linkError
      }
      missing.unshift(basename(current))
      current = dirname(current)
    }
  }
}

/** Where a symbolic link leads: its real target, or for a dangling link the path it would create. */
async function linkTarget(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    const target = resolve(dirname(path), await readlink(path))
    return futureRealPath(target)
  }
}

/**
 * Walk all reachable directories under `cwd`, including `.git` and internal directory links, for a link whose target is
 * outside `root`. A dangling link counts by the path it would create.
 * @param cwd - the run's directory.
 * @param root - the directory writes must stay in (the parent's workspace root, else `cwd`).
 * @param signal - aborts the walk.
 * @param limits - entry and time budget; exceeding it is a finding (fail closed).
 * @returns the first finding, or undefined when the tree is clean.
 */
export async function findEscapingLink(
  cwd: string,
  root: string,
  signal: AbortSignal,
  limits: LinkScanLimits = {},
): Promise<LinkScanFinding | undefined> {
  const maxEntries = limits.maxEntries ?? SCAN_MAX_ENTRIES
  const maxMs = limits.maxMs ?? SCAN_MAX_MS
  const now = limits.now ?? Date.now
  const started = now()
  const realRoot = await realOrResolved(root)
  const stack = [await realOrResolved(cwd)]
  const visited = new Set<string>()
  let entries = 0
  while (stack.length > 0) {
    signal.throwIfAborted()
    const dir = stack.pop() as string
    if (visited.has(dir)) continue
    visited.add(dir)
    let children: import('node:fs').Dirent[]
    try {
      children = await readdir(dir, { withFileTypes: true })
    } catch {
      return { kind: 'unreadable', path: dir } // A known child path can still be writable without listing access.
    }
    for (const child of children) {
      entries++
      if (entries > maxEntries || now() - started > maxMs) return { kind: 'budget' }
      const path = join(dir, child.name)
      if (child.isSymbolicLink()) {
        let target: string
        try {
          target = await linkTarget(path)
        } catch {
          return { kind: 'unreadable', path }
        }
        if (!isInside(realRoot, target)) return { kind: 'link', path }
        try {
          if ((await stat(target)).isDirectory()) stack.push(target)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return { kind: 'unreadable', path }
        }
      } else if (child.isDirectory()) stack.push(path)
    }
  }
  return undefined
}
