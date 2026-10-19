/**
 * Codex adapter — STUB (Phase A).
 *
 * Contract for the implementation that replaces this stub:
 * - Keep the export `export const codexAdapter: CliAdapter` (registered in `src/host/external/registry.ts`).
 * - `descriptor` stays `CODEX` from `src/shared/cli/codex.ts`.
 * - `plan` / `createSession` follow `src/host/external/types.ts` and DESIGN §5; keep them pure.
 * - Put the stdout parser in `./parser.ts` and test it against recorded transcripts in
 *   `tests/fixtures/cli/codex/`.
 */

import { CODEX } from '../../../shared/cli/codex.ts'
import type { CliAdapter, PlanInput, RunPlan, RunSession } from '../../external/types.ts'

export const codexAdapter: CliAdapter = {
  descriptor: CODEX,
  plan(_input: PlanInput, _nonce: string): RunPlan {
    throw new Error('Codex runner is not implemented yet')
  },
  createSession(_input: PlanInput, _nonce: string): RunSession {
    throw new Error('Codex runner is not implemented yet')
  },
}
