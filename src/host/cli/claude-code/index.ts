/**
 * Claude Code adapter: `claude -p --output-format stream-json --verbose`.
 *
 * One process per delegation. The task goes to stdin, which is closed right
 * away (an open stdin costs a 3 s wait); the role's instructions are appended
 * to Claude Code's own system prompt with `--append-system-prompt`.
 *
 * Presets (verified against 2.1.303 through scripts/check-cli/claude-code.mjs):
 * - `read-only`: `--tools` limited to the read tools (no Bash: `dontAsk` alone does not make the
 *   filesystem read-only — a read-only-looking command such as `git diff` can run a repository's
 *   `diff.external` helper), `--permission-mode dontAsk`, no setting sources, and the write tools
 *   disallowed as well.
 * - `acceptEdits` (workspace write, "Edit files (no shell)"): `--tools` limited to the read tools plus
 *   Edit/Write/NotebookEdit — no Bash, because a user allow rule for Bash would otherwise let commands
 *   write anywhere — and no setting sources, so user or project allow rules, `additionalDirectories` and
 *   hooks cannot widen it (print mode has no trust dialog). Edits outside the working directory need
 *   approval, which print mode refuses.
 * - `auto` and `bypassPermissions`: full access (the `auto` classifier can approve any unsandboxed
 *   command), Claude Code's default tools and setting sources.
 * - `nativeAcceptEdits`: explicit native editing with settings, MCP and tools intact. Requires a full-access
 *   parent (hooks/extensions are not confined), but uses acceptEdits, not bypassPermissions.
 * `--strict-mcp-config` keeps project `.mcp.json` servers out of the legacy presets. With no setting sources,
 * CLAUDE.md files and a model, environment or `apiKeyHelper` from settings are not loaded either.
 *
 * Environment: nested-agent markers and inherited `CLAUDE_CODE_*` variables
 * are removed (variables the user forwards by name win), non-essential traffic
 * and the auto-updater are disabled. Credentials stay in Claude Code's own
 * login unless the user forwards e.g. `ANTHROPIC_API_KEY`.
 *
 * Cancellation is the engine's terminate: print mode has no stdin protocol to
 * ask for a graceful stop, and Bash tool children live in the managed process
 * range the engine terminates.
 */

import { CLAUDE_CODE } from '../../../shared/cli/claude-code.ts'
import type { CliAdapter, PlanInput, ProbeModel, ProbeResult, RunPlan, RunSession } from '../../external/types.ts'
import { ClaudeStreamParser } from './parser.ts'

/** Tools removed from the read-only preset (belt and braces: `--tools` already leaves them out). */
export const READ_ONLY_DISALLOWED_TOOLS = 'Write,Edit,NotebookEdit'

/** The tools of the read-only preset: no Bash, no file writes. */
export const READ_ONLY_TOOLS = 'Read,Glob,Grep,WebFetch,WebSearch'

/** The tools of the workspace-write preset: the read tools plus file edits, no Bash. */
export const EDIT_TOOLS = `${READ_ONLY_TOOLS},Edit,Write,NotebookEdit`

/** Permission arguments of each preset id. */
const PRESET_ARGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'read-only': Object.freeze([
    '--permission-mode',
    'dontAsk',
    '--setting-sources',
    '',
    '--tools',
    READ_ONLY_TOOLS,
    '--disallowedTools',
    READ_ONLY_DISALLOWED_TOOLS,
  ]),
  acceptEdits: Object.freeze(['--permission-mode', 'acceptEdits', '--setting-sources', '', '--tools', EDIT_TOOLS]),
  nativeAcceptEdits: Object.freeze(['--permission-mode', 'acceptEdits']),
  auto: Object.freeze(['--permission-mode', 'auto']),
  bypassPermissions: Object.freeze(['--permission-mode', 'bypassPermissions']),
})

/**
 * Models Claude Code offers. Its live list needs an `initialize` control request over stdin (and the
 * CLI's auth discovery), which a probe cannot send, so the probe reports this list.
 * Source: the 2.1.303 `initialize` response.
 */
export const CLAUDE_CODE_MODELS: readonly ProbeModel[] = Object.freeze(
  (
    [
      ['default', 'Default (recommended)'],
      ['opus', 'Opus'],
      ['fable', 'Fable'],
      ['sonnet', 'Sonnet'],
      ['haiku', 'Haiku'],
    ] as const
  ).map(([id, name]) => Object.freeze({ id, name, efforts: CLAUDE_CODE.efforts })),
)

const VERSION = /^(\d+\.\d+\.\d+)/
const PROBE_TIMEOUT_MS = 10_000

/**
 * Permission arguments for a plan. An unknown preset id falls back to the preset of its access level, and a
 * read-only access always gets the read-only arguments (fail closed).
 * @param input - the plan input.
 * @returns the arguments.
 */
export function permissionArgs(input: Pick<PlanInput, 'preset' | 'access'>): readonly string[] {
  if (input.access === 'read-only') return PRESET_ARGS['read-only'] as readonly string[]
  const own = PRESET_ARGS[input.preset]
  if (own !== undefined && CLAUDE_CODE.permissions.some(p => p.id === input.preset && p.access === input.access)) {
    return own
  }
  const fallback = CLAUDE_CODE.presetForAccess[input.access]
  if (fallback === undefined) throw new Error(`unsupported Claude Code access: ${input.access}`)
  return PRESET_ARGS[fallback] as readonly string[]
}

/**
 * Describe one Claude Code run.
 * @param input - the plan input.
 * @returns argv (without the executable), env overlay and removals.
 */
export function planClaudeCode(input: PlanInput): RunPlan {
  const { runner } = input
  const argv = [
    '-p',
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
    ...(input.preset === 'nativeAcceptEdits' && input.access === 'full-access' ? [] : ['--strict-mcp-config']),
    ...(runner.model === undefined || runner.model === '' ? [] : ['--model', runner.model]),
    ...(runner.effort === undefined || runner.effort === '' ? [] : ['--effort', runner.effort]),
    ...permissionArgs(input),
    ...(input.instructions.trim() === '' ? [] : ['--append-system-prompt', input.instructions]),
  ]
  return {
    argv,
    env: {
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
      CLAUDECODE: undefined,
    },
    envRemovePrefixes: input.preset === 'nativeAcceptEdits' && input.access === 'full-access' ? [] : ['CLAUDE_CODE_'],
    cancelGraceMs: 0,
  }
}

/**
 * A session that writes the task to stdin, closes it and parses stream-json.
 * @param input - the plan input.
 * @returns the session.
 */
export function createClaudeCodeSession(input: PlanInput): RunSession {
  const parser = new ClaudeStreamParser()
  return {
    start(io) {
      io.write(input.task)
      io.end()
    },
    line(text) {
      try {
        parser.line(text)
      } catch {
        // Never throw into the engine; an unreadable line is simply skipped.
      }
    },
    finish(exit) {
      try {
        return parser.finish(exit)
      } catch {
        return { status: 'failed', category: 'unknown' }
      }
    },
  }
}

/**
 * The editor's connection test: version only (sign-in is checked by the first run; `auth status` would
 * write Claude Code's state files and cannot validate a key).
 * @param run - runs the executable.
 * @param signal - aborts the probe.
 * @returns version, the static model list and `auth: 'unknown'`.
 */
export async function probeClaudeCode(
  run: Parameters<NonNullable<CliAdapter['probe']>>[1],
  signal: AbortSignal,
): Promise<Omit<ProbeResult, 'found'>> {
  const result = await run(['--version'], { timeoutMs: PROBE_TIMEOUT_MS }, signal)
  const version = result.code === 0 ? VERSION.exec(result.stdout.trim())?.[1] : undefined
  return {
    cli: 'claude-code',
    ...(version === undefined ? { message: result.timedOut ? 'version-timeout' : 'version-unreadable' } : { version }),
    auth: 'unknown',
    models: CLAUDE_CODE_MODELS,
  }
}

export const claudeCodeAdapter: CliAdapter = {
  descriptor: CLAUDE_CODE,
  plan: (input, _nonce) => planClaudeCode(input),
  createSession: (input, _nonce) => createClaudeCodeSession(input),
  async probe(exe, run, signal) {
    return { ...(await probeClaudeCode(run, signal)), found: true, path: exe }
  },
}
