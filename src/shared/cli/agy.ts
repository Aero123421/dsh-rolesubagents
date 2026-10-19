/**
 * Antigravity CLI (`agy`). Read-only and edit-files runs use a generated custom
 * agent whose tool allowlist implements the preset; instructions are that agent's
 * body (system prompt). Full access keeps agy's default agent (a custom agent drops
 * its default tools and prompt sections), so there the instructions are a prompt prefix.
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
    Object.freeze({ id: 'read-only', access: 'read-only', confinement: 'tool-scope' }),
    Object.freeze({ id: 'edit-files', access: 'workspace-write', confinement: 'tool-scope' }),
    Object.freeze({ id: 'full-access', access: 'full-access', confinement: 'none' }),
  ]),
  defaultPermission: 'edit-files',
  presetForAccess: Object.freeze({
    'read-only': 'read-only',
    'workspace-write': 'edit-files',
    'full-access': 'full-access',
  }),
  instructionsChannel: 'system',
  toolScope: 'cwd',
} satisfies CliDescriptor)
