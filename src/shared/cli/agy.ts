/**
 * Antigravity CLI (`agy`). Each run uses a generated custom agent whose tool
 * allowlist implements the preset; instructions are that agent's body.
 */

import type { CliDescriptor } from './types.ts'

export const AGY: CliDescriptor = Object.freeze({
  id: 'agy',
  displayName: 'Antigravity',
  executable: 'agy',
  needsProvider: false,
  // `agy --output-format json models`; the probe adds effort-suffixed slugs.
  modelSuggestions: Object.freeze(['gemini-3.1-pro', 'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash']),
  // Each model supports a subset; agy rejects an invalid combination at start.
  efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']),
  effortFreeText: false,
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
