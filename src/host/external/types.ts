/**
 * The contract between the generic external-run engine and one CLI adapter.
 *
 * An adapter is pure: `plan` describes the process to start (argv, env
 * overlay, files, an optional pre-flight) and `createSession` returns a small
 * synchronous state machine that writes the child's stdin and parses its
 * stdout lines into a {@link RunOutcome}. The engine (`engine.ts`) owns every
 * side effect: executable lookup, files, spawning, stdio plumbing, line
 * framing, timeouts, cancellation and settlement.
 *
 * Placeholders: argv elements that START with `${RUN_DIR}`, `${HOME}` or
 * `${SECRET}`, every occurrence of them in env values, and file keys are
 * substituted by the engine. File contents, the task text and every other argv
 * element are passed verbatim, so user text can never be rewritten by a
 * placeholder. Adapters must not put free user text into env values.
 * - `${RUN_DIR}`: a private (0700) temp directory created per run and removed after it.
 * - `${HOME}`: the child's HOME (the env overlay's `HOME`, else the Host's).
 * - `${SECRET}`: a fresh random 32-hex-character value per run (e.g. a local server password).
 */

import type { AccessLevel, CliDescriptor } from '../../shared/cli/index.ts'
import type { CliId } from '../../shared/cli/types.ts'
import type { CliSettings, RoleRunner } from '../../shared/runner.ts'

/** Everything an adapter needs to describe one run. */
export interface PlanInput {
  /** The role's normalized runner. */
  readonly runner: RoleRunner
  /** Effective permission preset id after the access ceiling. */
  readonly preset: string
  /** Its access level. */
  readonly access: AccessLevel
  /** `roleContextText(role)`; may be ''. Pass it through the CLI's native instruction channel. */
  readonly instructions: string
  /** The delegate prompt text (the task). */
  readonly task: string
  /** Absolute, validated working directory of the child. */
  readonly cwd: string
}

/** A cheap command run before the real one; a non-zero exit refuses the run. */
export interface PreflightSpec {
  /** Arguments WITHOUT the executable. */
  readonly argv: readonly string[]
  readonly timeoutMs: number
  /** Category reported when the pre-flight fails or times out. */
  readonly category: FailureCategory
}

/** How to start one CLI run. */
export interface RunPlan {
  /** Arguments WITHOUT the executable; never shell-interpreted. */
  readonly argv: readonly string[]
  /** Environment overlay; `undefined` removes a variable (unless the user forwards it by name). */
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * Inherited variables starting with one of these prefixes are removed (e.g. Claude Code's
   * `CLAUDE_CODE_`), unless the user forwards them by name. Needed because `plan` is pure and
   * cannot list the Host's variables itself.
   */
  readonly envRemovePrefixes?: readonly string[]
  /**
   * Files the run needs, created before spawn and removed after the process exited
   * (also on failure/cancel). Keys start with `${RUN_DIR}/` or `${HOME}/` and must not
   * contain `..` segments; values are contents (written verbatim, mode 0600).
   */
  readonly files?: Readonly<Record<string, string>>
  /** Optional pre-flight (e.g. an auth probe). */
  readonly preflight?: PreflightSpec
  /** Grace between a graceful cancel request ({@link RunSession.cancel}) and the engine's terminate. */
  readonly cancelGraceMs: number
}

/** What a session may do with the child's stdin. */
export interface SessionIO {
  /** Write raw text; sessions add their own newlines. Ignored once stdin is closed. */
  write(text: string): void
  /** Close stdin (idempotent). */
  end(): void
}

/** Exit facts handed to {@link RunSession.finish}. */
export interface RunExit {
  readonly code: number | null
  readonly signal: string | null
  /** Last bytes of stderr, for parsers that read a terminal error line. Never forwarded to the parent. */
  readonly stderrTail: string
  /** The run was cancelled (interrupt, disposal or plugin unload). */
  readonly cancelled: boolean
  /** The run hit its wall-clock limit. */
  readonly timedOut: boolean
}

/**
 * One run's protocol state machine. Simple CLIs write the task in `start` and end
 * stdin; ACP-style CLIs (OpenCode) answer responses/requests from `line`.
 * Methods are synchronous and must never throw (the engine still contains a throw:
 * it ends the run as `cli-crashed`).
 */
export interface RunSession {
  /** Called once, right after spawn. */
  start(io: SessionIO): void
  /** One complete stdout line, without its line ending. Non-JSON lines must be tolerated. */
  line(text: string): void
  /** Graceful cancel (e.g. ACP `session/cancel` + end stdin). The engine terminates after `cancelGraceMs`. */
  cancel?(): void
  /** Called once after the process exited and stdout drained. */
  finish(exit: RunExit): RunOutcome
}

/** Fixed vocabulary for why a run did not complete. */
export type FailureCategory =
  | 'auth'
  | 'limit'
  | 'rate-limit'
  | 'model'
  | 'max-tokens'
  | 'service'
  | 'transport'
  | 'permission'
  | 'config'
  | 'cli-missing'
  | 'cli-crashed'
  | 'timeout'
  | 'empty-answer'
  | 'unknown'

/** Every {@link FailureCategory}, for validation and tests. */
export const FAILURE_CATEGORIES: readonly FailureCategory[] = Object.freeze([
  'auth',
  'limit',
  'rate-limit',
  'model',
  'max-tokens',
  'service',
  'transport',
  'permission',
  'config',
  'cli-missing',
  'cli-crashed',
  'timeout',
  'empty-answer',
  'unknown',
])

/** What a session concluded about one run. */
export interface RunOutcome {
  readonly status: 'completed' | 'failed' | 'max-tokens' | 'refusal'
  /** Final answer text (completed); partial text allowed otherwise. */
  readonly answer?: string
  /** Why it did not complete. */
  readonly category?: FailureCategory
  /**
   * Safe facts for the diagnostic, e.g. `{ 'exit code': 1, 'http status': 401 }`. Keys must be short
   * fixed words; values numbers or fixed-vocabulary strings — never provider text.
   */
  readonly facts?: Readonly<Record<string, string | number>>
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number; readonly costUsd?: number }
  /** Number of permission denials, when the CLI reports them. */
  readonly deniedActions?: number
}

/** One model a probe found. */
export interface ProbeModel {
  readonly id: string
  readonly name?: string
  readonly efforts?: readonly string[]
}

/** What the editor's "Test connection" shows. */
export interface ProbeResult {
  readonly cli: CliId
  readonly found: boolean
  readonly path?: string
  readonly version?: string
  readonly auth?: 'ok' | 'missing' | 'unknown'
  readonly models?: readonly ProbeModel[]
  /** Short fixed-vocabulary note (never raw CLI output). */
  readonly message?: string
}

/** Output of one {@link ProbeRunner} call. */
export interface ProbeRun {
  /** Exit code; null when killed, timed out or the program could not start. */
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/**
 * Runs the CLI's executable with `argv` (WITHOUT the executable) for probes and
 * pre-flights: no stdin, bounded output, timeout. The environment is the one a
 * run of this CLI gets (forwarded variables included) plus `opts.env`.
 * Never rejects for a failing command; rejects only when `signal` aborts.
 */
export type ProbeRunner = (
  argv: readonly string[],
  opts: { readonly timeoutMs: number; readonly env?: Readonly<Record<string, string | undefined>> },
  signal: AbortSignal,
) => Promise<ProbeRun>

/** One CLI's Host-side implementation. */
export interface CliAdapter {
  readonly descriptor: CliDescriptor
  /** Pure: no I/O, no randomness except through `nonce` (12 hex chars; tests pass a fixed one). */
  plan(input: PlanInput, nonce: string): RunPlan
  /** A fresh session for one run with the same input and nonce as `plan`. */
  createSession(input: PlanInput, nonce: string): RunSession
  /**
   * Cheap, side-effect-free checks for the editor. Must not call a model.
   * @param exe - the resolved executable path (for messages; `run` already targets it).
   * @param run - runs the executable.
   * @param signal - aborts the probe.
   * @param settings - the CLI's plugin settings (e.g. to see which variables are forwarded).
   */
  probe?(exe: string, run: ProbeRunner, signal: AbortSignal, settings: CliSettings): Promise<ProbeResult>
  /**
   * Called once at plugin start (errors are logged, never thrown to the Host), e.g. to sweep
   * stale generated files under the user's HOME.
   * @param home - the Host user's home directory.
   */
  housekeeping?(home: string): Promise<void>
}
