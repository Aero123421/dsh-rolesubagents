/**
 * Antigravity adapter — STUB (Phase A).
 *
 * Contract for the implementation that replaces this stub:
 * - Keep the export `export const agyAdapter: CliAdapter` (registered in `src/host/external/registry.ts`).
 * - `descriptor` stays `AGY` from `src/shared/cli/agy.ts`.
 * - `plan` / `createSession` follow `src/host/external/types.ts` and DESIGN §5; keep them pure.
 * - Put the stdout parser in `./parser.ts` and test it against recorded transcripts in
 *   `tests/fixtures/cli/agy/`.
 */

import { AGY } from '../../../shared/cli/agy.ts'
import type { CliAdapter, PlanInput, RunPlan, RunSession } from '../../external/types.ts'

export const agyAdapter: CliAdapter = {
  descriptor: AGY,
  plan(_input: PlanInput, _nonce: string): RunPlan {
    throw new Error('Antigravity runner is not implemented yet')
  },
  createSession(_input: PlanInput, _nonce: string): RunSession {
    throw new Error('Antigravity runner is not implemented yet')
  },
}
