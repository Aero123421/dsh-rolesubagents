/**
 * Claude Code (`claude -p --output-format stream-json`). Presets are Claude
 * Code permission modes; the adapter narrows the two restricted ones with
 * `--tools` (no Bash) and no setting sources: `read-only` (dontAsk + read
 * tools) and `acceptEdits` (read tools + file edits). `auto` is full access:
 * its classifier can approve arbitrary shell commands, which Claude Code does
 * not sandbox.
 */

import type { CliDescriptor } from './types.ts'

export const CLAUDE_CODE: CliDescriptor = Object.freeze({
  id: 'claude-code',
  displayName: 'Claude Code',
  executable: 'claude',
  needsProvider: false,
  modelSuggestions: Object.freeze(['default', 'opus', 'sonnet', 'haiku', 'fable']),
  efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  effortFreeText: false,
  permissions: Object.freeze([
    Object.freeze({ id: 'read-only', access: 'read-only', confinement: 'tool-scope' }),
    Object.freeze({ id: 'acceptEdits', access: 'workspace-write', confinement: 'tool-scope' }),
    Object.freeze({ id: 'auto', access: 'full-access', confinement: 'none' }),
    Object.freeze({ id: 'bypassPermissions', access: 'full-access', confinement: 'none' }),
  ]),
  defaultPermission: 'acceptEdits',
  presetForAccess: Object.freeze({
    'read-only': 'read-only',
    'workspace-write': 'acceptEdits',
    'full-access': 'bypassPermissions',
  }),
  instructionsChannel: 'system',
  toolScope: 'cwd',
} satisfies CliDescriptor)
