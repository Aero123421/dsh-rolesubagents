/**
 * Registry of CLI descriptors. Adding a CLI: add its id to `CliId`/`CLI_IDS`
 * in `types.ts`, a descriptor file next to this one, and one entry below; then
 * register its adapter in `src/host/external/registry.ts`.
 */

import { AGY } from './agy.ts'
import { CLAUDE_CODE } from './claude-code.ts'
import { CODEX } from './codex.ts'
import { OPENCODE } from './opencode.ts'
import { type AccessLevel, CLI_IDS, type CliDescriptor, type CliId, type PermissionPreset } from './types.ts'

export * from './types.ts'

/** Every descriptor by id. */
export const CLI_DESCRIPTORS: Readonly<Record<CliId, CliDescriptor>> = Object.freeze({
  codex: CODEX,
  'claude-code': CLAUDE_CODE,
  agy: AGY,
  opencode: OPENCODE,
})

/**
 * Whether a value names a supported CLI.
 * @param value - any value.
 * @returns true for one of {@link CLI_IDS}.
 */
export function isCliId(value: unknown): value is CliId {
  return typeof value === 'string' && (CLI_IDS as readonly string[]).includes(value)
}

/**
 * The descriptor of one CLI.
 * @param id - a supported CLI id.
 * @returns its descriptor.
 */
export function cliDescriptor(id: CliId): CliDescriptor {
  return CLI_DESCRIPTORS[id]
}

/**
 * One preset of a CLI by id.
 * @param descriptor - the CLI.
 * @param id - a preset id.
 * @returns the preset, or undefined when the CLI has none with that id.
 */
export function permissionPreset(descriptor: CliDescriptor, id: string): PermissionPreset | undefined {
  return descriptor.permissions.find(preset => preset.id === id)
}

/**
 * The access level a preset grants.
 * @param descriptor - the CLI.
 * @param id - a preset id.
 * @returns its level, or undefined for an unknown preset.
 */
export function presetAccess(descriptor: CliDescriptor, id: string): AccessLevel | undefined {
  return permissionPreset(descriptor, id)?.access
}
