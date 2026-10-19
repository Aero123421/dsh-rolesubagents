/**
 * Claude Code adapter — STUB (Phase A).
 *
 * Contract for the implementation that replaces this stub:
 * - Keep the export `export const claudeCodeAdapter: CliAdapter` (registered in `src/host/external/registry.ts`).
 * - `descriptor` stays `CLAUDE_CODE` from `src/shared/cli/claude-code.ts`.
 * - `plan` / `createSession` follow `src/host/external/types.ts` and DESIGN §5; keep them pure.
 * - Put the stdout parser in `./parser.ts` and test it against recorded transcripts in
 *   `tests/fixtures/cli/claude-code/`.
 */

import { CLAUDE_CODE } from '../../../shared/cli/claude-code.ts'
import type { CliAdapter, PlanInput, RunPlan, RunSession } from '../../external/types.ts'

export const claudeCodeAdapter: CliAdapter = {
  descriptor: CLAUDE_CODE,
  plan(_input: PlanInput, _nonce: string): RunPlan {
    throw new Error('Claude Code runner is not implemented yet')
  },
  createSession(_input: PlanInput, _nonce: string): RunSession {
    throw new Error('Claude Code runner is not implemented yet')
  },
}
