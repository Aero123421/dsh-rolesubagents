/** Pi tools/extensions execute with account permissions; native is not a sandbox. */
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
    Object.freeze({ id: 'native', access: 'full-access', confinement: 'none', nativeHarness: true }),
  ]),
  defaultPermission: 'native',
  presetForAccess: Object.freeze({ 'full-access': 'native' }),
  instructionsChannel: 'system',
  toolScope: 'cwd',
} satisfies CliDescriptor)
