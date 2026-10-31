/** Default DSH-confined workspace route plus explicit full-parent native Grok execution. */
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
    Object.freeze({ id: 'workspace-write', access: 'workspace-write', confinement: 'host-sandbox' }),
    Object.freeze({ id: 'native', access: 'full-access', confinement: 'none', nativeHarness: true }),
  ]),
  defaultPermission: 'workspace-write',
  presetForAccess: Object.freeze({ 'workspace-write': 'workspace-write', 'full-access': 'native' }),
  instructionsChannel: 'system',
  toolScope: 'cwd',
} satisfies CliDescriptor)
