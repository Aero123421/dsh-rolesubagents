/**
 * Host-side adapters by CLI id. The descriptor registry in
 * `src/shared/cli/index.ts` and this one must list the same CLIs; a test
 * checks that every adapter carries its own descriptor.
 */

import type { CliId } from '../../shared/cli/types.ts'
import { agyAdapter } from '../cli/agy/index.ts'
import { claudeCodeAdapter } from '../cli/claude-code/index.ts'
import { codexAdapter } from '../cli/codex/index.ts'
import { opencodeAdapter } from '../cli/opencode/index.ts'
import type { CliAdapter } from './types.ts'

/** Every adapter by CLI id. */
export const CLI_ADAPTERS: Readonly<Record<CliId, CliAdapter>> = Object.freeze({
  codex: codexAdapter,
  'claude-code': claudeCodeAdapter,
  agy: agyAdapter,
  opencode: opencodeAdapter,
})

/** Looks up the adapter for one CLI; injectable so tests and the integration harness can substitute adapters. */
export type AdapterLookup = (cli: CliId) => CliAdapter

/** The default lookup over {@link CLI_ADAPTERS}. */
export const defaultAdapterLookup: AdapterLookup = cli => CLI_ADAPTERS[cli]
