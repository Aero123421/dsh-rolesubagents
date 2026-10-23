/** Pi has no own sandbox: default execution uses DSH confinement; explicit native requires a full parent. */
import type { CliDescriptor } from './types.ts'

export const PI: CliDescriptor = Object.freeze({
  id: 'pi',
  displayName: 'Pi',
  executable: 'pi',
  needsProvider: false,
  modelSuggestions: Object.freeze([]),
  efforts: Object.freeze(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  effortFreeText: false,
  permissions: Object.freeze([
    Object.freeze({ id: 'workspace-write', access: 'workspace-write', confinement: 'host-sandbox' }),
    Object.freeze({ id: 'native', access: 'full-access', confinement: 'none', nativeHarness: true }),
  ]),
  defaultPermission: 'workspace-write',
  presetForAccess: Object.freeze({ 'workspace-write': 'workspace-write', 'full-access': 'native' }),
  instructionsChannel: 'system',
  toolScope: 'cwd',
} satisfies CliDescriptor)
