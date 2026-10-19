/**
 * OpenCode adapter — STUB (Phase A).
 *
 * Contract for the implementation that replaces this stub:
 * - Keep the export `export const opencodeAdapter: CliAdapter` (registered in `src/host/external/registry.ts`).
 * - `descriptor` stays `OPENCODE` from `src/shared/cli/opencode.ts`.
 * - `plan` / `createSession` follow `src/host/external/types.ts` and DESIGN §5; keep them pure.
 * - Put the stdout parser in `./parser.ts` and test it against recorded transcripts in
 *   `tests/fixtures/cli/opencode/`.
 */

import { OPENCODE } from '../../../shared/cli/opencode.ts'
import type { CliAdapter, PlanInput, RunPlan, RunSession } from '../../external/types.ts'

export const opencodeAdapter: CliAdapter = {
  descriptor: OPENCODE,
  plan(_input: PlanInput, _nonce: string): RunPlan {
    throw new Error('OpenCode runner is not implemented yet')
  },
  createSession(_input: PlanInput, _nonce: string): RunSession {
    throw new Error('OpenCode runner is not implemented yet')
  },
}
