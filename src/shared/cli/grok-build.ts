/** Native Grok harness: preserve user configuration; no claimed filesystem confinement. */
import type { CliDescriptor } from './types.ts'

export const GROK_BUILD: CliDescriptor = Object.freeze({
  id: 'grok-build',
  displayName: 'Grok Build',
  executable: 'grok',
  needsProvider: false,
  modelSuggestions: Object.freeze([]),
  efforts: Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  effortFreeText: true,
  permissions: Object.freeze([
    Object.freeze({ id: 'native', access: 'full-access', confinement: 'none', nativeHarness: true }),
  ]),
  defaultPermission: 'native',
  presetForAccess: Object.freeze({ 'full-access': 'native' }),
  instructionsChannel: 'system',
  toolScope: 'cwd',
} satisfies CliDescriptor)
