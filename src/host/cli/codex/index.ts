/**
 * Codex adapter: one `codex exec --json` run per delegation (DESIGN §5.1).
 *
 * The task goes to stdin (which must be closed, or Codex waits for more input);
 * the role's instructions go to `developer_instructions`, which Codex adds as a
 * developer message next to its own base prompt. `-s <preset>` is always passed
 * so a trusted project's `.codex/config.toml` can never widen the sandbox. The
 * remaining flags keep the run hermetic: no rollout files, no plugin sync, no
 * analytics, no user `notify` program, no sub-agents, and tool commands do not
 * inherit credential-shaped variables.
 */

import { CODEX } from '../../../shared/cli/codex.ts'
import type { CliSettings } from '../../../shared/runner.ts'
import type {
  CliAdapter,
  PlanInput,
  ProbeResult,
  ProbeRunner,
  RunExit,
  RunOutcome,
  RunPlan,
  RunSession,
  SessionIO,
} from '../../external/types.ts'
import { CodexStream, parseDebugModels, parseVersion } from './parser.ts'

/** Flags every run gets, before the per-run ones. */
export const CODEX_BASE_ARGS: readonly string[] = Object.freeze([
  'exec',
  '--json',
  '--ephemeral',
  '--skip-git-repo-check',
  '--color',
  'never',
  '--disable',
  'plugins',
  '--disable',
  'multi_agent',
  '-c',
  'analytics.enabled=false',
  '-c',
  'notify=[]',
  '-c',
  'shell_environment_policy.ignore_default_excludes=false',
])

/** The API-key variable Codex's built-in OpenAI provider reads. */
export const CODEX_API_KEY_ENV = 'CODEX_API_KEY'

const PROBE_TIMEOUT_MS = 15_000

/**
 * A TOML basic string for a `-c key=value` override. JSON string syntax is a
 * subset of TOML's except for lone surrogates, which are replaced first.
 */
function tomlString(text: string): string {
  return JSON.stringify(text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�'))
}

/**
 * The argv of one run (without the executable).
 * @param input - the plan input.
 * @returns the arguments; the task itself is read from stdin (`-`).
 */
export function codexArgv(input: PlanInput): string[] {
  const argv = [...CODEX_BASE_ARGS, '-C', input.cwd, '-s', input.preset]
  const { model, effort } = input.runner
  if (model !== undefined && model !== '') argv.push('-m', model)
  if (effort !== undefined && CODEX.efforts.includes(effort))
    argv.push('-c', `model_reasoning_effort=${tomlString(effort)}`)
  if (input.instructions.trim() !== '') argv.push('-c', `developer_instructions=${tomlString(input.instructions)}`)
  argv.push('-')
  return argv
}

/** Session: write the task, close stdin, read the JSONL stream. */
class CodexSession implements RunSession {
  readonly #task: string
  readonly #stream = new CodexStream()

  constructor(task: string) {
    this.#task = task
  }

  start(io: SessionIO): void {
    io.write(this.#task)
    io.end()
  }

  line(text: string): void {
    this.#stream.line(text)
  }

  finish(exit: RunExit): RunOutcome {
    return this.#stream.finish(exit)
  }
}

/**
 * Version, sign-in state and model list; none of these calls a model.
 * `login status` exits 0 when signed in and 1 when not; a forwarded `CODEX_API_KEY` also counts as signed in.
 */
async function probeCodex(
  _exe: string,
  run: ProbeRunner,
  signal: AbortSignal,
  settings: CliSettings,
): Promise<ProbeResult> {
  const opts = { timeoutMs: PROBE_TIMEOUT_MS }
  const [version, login, models] = await Promise.all([
    run(['--version'], opts, signal),
    run(['login', 'status'], opts, signal),
    run(['debug', 'models'], opts, signal),
  ])
  const forwardsKey = settings.envPassthrough?.includes(CODEX_API_KEY_ENV) === true
  const auth = login.code === 0 || forwardsKey ? 'ok' : login.code === 1 ? 'missing' : 'unknown'
  const parsedVersion = version.code === 0 ? parseVersion(version.stdout) : undefined
  const parsedModels = models.code === 0 ? parseDebugModels(models.stdout) : undefined
  return {
    cli: 'codex',
    found: true,
    ...(parsedVersion === undefined ? {} : { version: parsedVersion }),
    auth,
    ...(parsedModels === undefined ? {} : { models: parsedModels }),
  }
}

export const codexAdapter: CliAdapter = {
  descriptor: CODEX,
  plan(input: PlanInput, _nonce: string): RunPlan {
    // No pre-flight: `login status` ignores custom providers and env keys, so it would refuse working setups.
    // No session.cancel: stdin is already closed; the engine's terminate (process-group SIGTERM) stops Codex.
    return { argv: codexArgv(input), env: {}, cancelGraceMs: 0 }
  },
  createSession(input: PlanInput, _nonce: string): RunSession {
    return new CodexSession(input.task)
  },
  probe: probeCodex,
}
