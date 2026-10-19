/**
 * OpenCode (`opencode acp`). Models are always chosen as provider + model, so
 * a role never falls back to OpenCode's free remote default. Efforts are the
 * model's own variant names (free text; the probe suggests them).
 */

import type { CliDescriptor } from './types.ts'

export const OPENCODE: CliDescriptor = Object.freeze({
  id: 'opencode',
  displayName: 'OpenCode',
  executable: 'opencode',
  needsProvider: true,
  modelSuggestions: Object.freeze([]),
  efforts: Object.freeze([]),
  effortFreeText: true,
  permissions: Object.freeze([
    Object.freeze({ id: 'read-only', access: 'read-only' }),
    Object.freeze({ id: 'edit-files', access: 'workspace-write' }),
    Object.freeze({ id: 'full-access', access: 'full-access' }),
  ]),
  defaultPermission: 'edit-files',
  presetForAccess: Object.freeze({
    'read-only': 'read-only',
    'workspace-write': 'edit-files',
    'full-access': 'full-access',
  }),
  instructionsChannel: 'system',
} satisfies CliDescriptor)
