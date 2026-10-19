/**
 * Claude Code (`claude -p --output-format stream-json`). Presets are Claude
 * Code permission modes, except `read-only`, which the adapter builds from
 * `dontAsk` + no setting sources + disallowed write tools.
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
    Object.freeze({ id: 'read-only', access: 'read-only' }),
    Object.freeze({ id: 'acceptEdits', access: 'workspace-write' }),
    Object.freeze({ id: 'auto', access: 'workspace-write' }),
    Object.freeze({ id: 'bypassPermissions', access: 'full-access' }),
  ]),
  defaultPermission: 'acceptEdits',
  presetForAccess: Object.freeze({
    'read-only': 'read-only',
    'workspace-write': 'acceptEdits',
    'full-access': 'bypassPermissions',
  }),
  instructionsChannel: 'system',
} satisfies CliDescriptor)
