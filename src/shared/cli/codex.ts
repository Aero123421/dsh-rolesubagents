/**
 * Codex CLI (`codex exec --json`). Presets are Codex's own sandbox modes
 * (`-s <preset>`); instructions travel as `developer_instructions`.
 */

import type { CliDescriptor } from './types.ts'

export const CODEX: CliDescriptor = Object.freeze({
  id: 'codex',
  displayName: 'Codex',
  executable: 'codex',
  needsProvider: false,
  // `codex debug models` (bundled catalog, visibility "list").
  modelSuggestions: Object.freeze([
    'gpt-6.1-sol',
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5.5',
  ]),
  // `ultra` is deliberately absent: it also turns on automatic delegation.
  efforts: Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  effortFreeText: false,
  permissions: Object.freeze([
    Object.freeze({ id: 'read-only', access: 'read-only' }),
    Object.freeze({ id: 'workspace-write', access: 'workspace-write' }),
    Object.freeze({ id: 'danger-full-access', access: 'full-access' }),
  ]),
  defaultPermission: 'workspace-write',
  presetForAccess: Object.freeze({
    'read-only': 'read-only',
    'workspace-write': 'workspace-write',
    'full-access': 'danger-full-access',
  }),
  instructionsChannel: 'system',
} satisfies CliDescriptor)
