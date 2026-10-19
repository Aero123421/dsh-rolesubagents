/**
 * OpenCode adapter: one `opencode acp` process per delegation (DESIGN §5.4).
 *
 * Everything per run is injected through `OPENCODE_CONFIG_CONTENT`, which OpenCode
 * merges over the user's global and project config without touching any file:
 * the model (also as the default, so nothing falls back to OpenCode's free remote
 * model), a uniquely named primary agent `dsh-<nonce>` carrying the preset's
 * permission profile (no user config can merge into a fresh name), the role
 * instructions as an extra `instructions` file (system prompt, after AGENTS.md),
 * and switches for auto-update, sharing, snapshots and title generation.
 * The protocol itself lives in `./parser.ts`; probing in `./probe.ts`.
 */

import { OPENCODE } from '../../../shared/cli/opencode.ts'
import type { CliAdapter, PlanInput, RunPlan, RunSession } from '../../external/types.ts'
import { createOpencodeSession } from './parser.ts'
import { probeOpencode } from './probe.ts'

/** Placeholder of the engine's private per-run directory (kept out of template literals on purpose). */
const RUN_DIR = '$' + '{RUN_DIR}'
const SECRET = '$' + '{SECRET}'

/** Where the role instructions are written for a run. */
export const INSTRUCTIONS_FILE = `${RUN_DIR}/role-instructions.md`

/** Grace between `session/cancel` + stdin EOF and the engine's terminate (opencode exits in ~0.5 s). */
export const OPENCODE_CANCEL_GRACE_MS = 5_000

type Rule = 'allow' | 'deny'
type Profile = Readonly<Record<string, Rule | Readonly<Record<string, Rule>>>>

/** Reads are allowed except secrets in `.env` files. */
const READ_RULES = Object.freeze({
  '*': 'allow',
  '*.env': 'deny',
  '*.env.*': 'deny',
  '*.env.example': 'allow',
} as const)

/**
 * OpenCode permission profiles per preset id. `"*": "deny"` removes every tool that is not
 * listed (bash, write/edit, web fetch, task, skills, MCP tools, …) from the model's tool list.
 */
export const PERMISSION_PROFILES: Readonly<Record<string, Profile>> = Object.freeze({
  'read-only': Object.freeze({
    '*': 'deny',
    read: READ_RULES,
    grep: 'allow',
    glob: 'allow',
    list: 'allow',
    lsp: 'allow',
    todowrite: 'allow',
  }),
  /** Read-only plus file edits (edit covers edit/write/patch) inside the workspace; no shell. */
  'edit-files': Object.freeze({
    '*': 'deny',
    read: READ_RULES,
    grep: 'allow',
    glob: 'allow',
    list: 'allow',
    lsp: 'allow',
    todowrite: 'allow',
    edit: 'allow',
    bash: 'deny',
    external_directory: 'deny',
    question: 'deny',
    doom_loop: 'deny',
  }),
  'full-access': Object.freeze({
    '*': 'allow',
    read: READ_RULES,
    external_directory: 'deny',
    doom_loop: 'deny',
    question: 'deny',
    plan_enter: 'deny',
    plan_exit: 'deny',
  }),
})

/**
 * The permission profile of a preset; unknown presets get the read-only profile (fail closed).
 * @param preset - effective preset id.
 * @returns the profile.
 */
export function permissionProfile(preset: string): Profile {
  return PERMISSION_PROFILES[preset] ?? (PERMISSION_PROFILES['read-only'] as Profile)
}

/**
 * The generated agent's name for a run.
 * @param nonce - the engine's per-run nonce.
 * @returns `dsh-<nonce>`.
 */
export function agentName(nonce: string): string {
  return `dsh-${nonce}`
}

/**
 * The `<provider>/<model>` id of a runner.
 * @param input - the plan input.
 * @returns the qualified model id.
 * @throws when provider or model is missing (normalization prevents this; a fixed message).
 */
export function qualifiedModel(input: PlanInput): string {
  const { provider, model } = input.runner
  if (provider === undefined || provider === '' || model === undefined || model === '') {
    throw new Error('OpenCode roles need a provider and a model')
  }
  return `${provider}/${model}`
}

/**
 * The `OPENCODE_CONFIG_CONTENT` value of a run. Every `$` from the data is written as the JSON
 * escape `$` so the engine's placeholder substitution (which applies to env values) can only
 * touch the instructions path this function places on purpose.
 * @param input - the plan input.
 * @param nonce - the engine's per-run nonce.
 * @returns JSON text.
 */
export function configContent(input: PlanInput, nonce: string): string {
  const config = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    snapshot: false,
    model: qualifiedModel(input),
    ...(input.instructions.trim() === '' ? {} : { instructions: [INSTRUCTIONS_FILE] }),
    agent: {
      title: { disable: true },
      [agentName(nonce)]: {
        mode: 'primary',
        description: 'DSH delegated role',
        permission: permissionProfile(input.preset),
      },
    },
  }
  const escaped = JSON.stringify(config).replaceAll('$', '\\u0024')
  // Restore the one placeholder (structure-only text: data strings cannot contain an unescaped `"instructions":["`).
  const placed = JSON.stringify({ instructions: [INSTRUCTIONS_FILE] }).slice(1, -1)
  return escaped.replace(placed.replaceAll('$', '\\u0024'), placed)
}

export const opencodeAdapter: CliAdapter = {
  descriptor: OPENCODE,

  plan(input: PlanInput, nonce: string): RunPlan {
    const hasInstructions = input.instructions.trim() !== ''
    return {
      argv: ['acp', '--cwd', input.cwd, '--print-logs', '--log-level', 'WARN'],
      env: {
        OPENCODE_CONFIG_CONTENT: configContent(input, nonce),
        // No session rows in the user's opencode.db; no migration race between parallel runs.
        OPENCODE_DB: ':memory:',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        // `opencode acp` serves an HTTP API on 127.0.0.1 for the whole run; without a password any local process could drive it.
        OPENCODE_SERVER_PASSWORD: SECRET,
        OPENCODE_SERVER_USERNAME: undefined,
        // Inherited settings that could widen permissions or share the session.
        OPENCODE_PERMISSION: undefined,
        OPENCODE_AUTO_SHARE: undefined,
        // opencode prefers $PWD over the real working directory.
        PWD: input.cwd,
      },
      ...(hasInstructions ? { files: { [INSTRUCTIONS_FILE]: input.instructions } } : {}),
      cancelGraceMs: OPENCODE_CANCEL_GRACE_MS,
    }
  },

  createSession(input: PlanInput, nonce: string): RunSession {
    const effort = input.runner.effort
    return createOpencodeSession(input, {
      model: qualifiedModel(input),
      agent: agentName(nonce),
      ...(effort === undefined || effort === '' ? {} : { effort }),
    })
  },

  probe: (_exe, run, signal) => probeOpencode(run, signal),
}
