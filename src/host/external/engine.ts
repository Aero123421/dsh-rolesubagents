/**
 * The generic external-run engine: one CLI process per delegation.
 *
 * Given an adapter and its {@link PlanInput}, the engine resolves the
 * executable, composes the environment, writes the plan's files, runs the
 * optional pre-flight, spawns the process through DSH's `ctx.subprocess`,
 * feeds stdout lines to the adapter's session, enforces the timeout and
 * cancellation, and settles a DSH `SubagentRun` whose `result` never rejects.
 * Everything CLI-specific stays in the adapter.
 *
 * Lifecycle of one run:
 *   start → [files] → [pre-flight] → spawn → session.start → lines… → exit
 *   → stdout drained → session.finish → result → files removed.
 * Stop ladder — the same for an aborted signal (interrupt), `dispose()` (DSH's
 * interrupt also disposes; plugin unload) and the timeout:
 *   1. graceful cancel: `session.cancel()` when the session has one (e.g. ACP
 *      `session/cancel` + stdin EOF, which lets OpenCode stop its tool trees);
 *   2. after `plan.cancelGraceMs`: `terminate()` — SIGTERM, then DSH's KILL after
 *      {@link SPAWN_GRACE_MS}.
 * A session without `cancel` is terminated at once (step 2 without the wait).
 * `dispose()` then waits for the result, sends one more `terminate()` to the managed
 * range (it kills a daemon/background child the CLI left behind; cheap when the
 * range is already empty) and waits until the range is empty.
 *
 * Errors thrown by {@link startExternalRun} reach the parent model verbatim,
 * so every message is built here from fixed text, the CLI's display name and
 * the working directory — never from CLI output.
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, normalize, sep } from 'node:path'
import { permissionPreset } from '../../shared/cli/index.ts'
import type { CliSettings } from '../../shared/runner.ts'
import type { LoggerPort, SubagentResultPort, SubagentRunPort, SubprocessHandlePort, SubprocessPort } from '../ports.ts'
import { formatDiagnostic } from './diagnostic.ts'
import { composeEnv, definedEntries } from './env.ts'
import { ByteTail, LineSplitter } from './lines.ts'
import { assertUsableCwd } from './policy.ts'
import { findEscapingLink, findStartupCodeDir, gitTopLevelAbove, SCAN_MAX_ENTRIES, SCAN_MAX_MS } from './workspace.ts'
import {
  type CliAdapter,
  FAILURE_CATEGORIES,
  type FailureCategory,
  type PlanInput,
  type ProbeRunner,
  type RunOutcome,
  type RunPlan,
  type RunSession,
} from './types.ts'

/** TERM → KILL grace handed to DSH's subprocess service. */
export const SPAWN_GRACE_MS = 3_000

/** Longest wait for stdout to drain after the process exited. */
const DRAIN_MS = 2_000

/** Output kept by a probe or pre-flight run. */
const PROBE_STDOUT_BYTES = 1024 * 1024
const PROBE_STDERR_BYTES = 64 * 1024

/** Live runs owned by the plugin; disposed when the plugin unloads. */
export type RunTracker = Set<SubagentRunPort>

/** Randomness used by the engine; tests replace it for stable values. */
export interface EngineRandom {
  /** 12 hex characters for adapter-visible unique names. */
  nonce(): string
  /** Value of the `${SECRET}` placeholder. */
  secret(): string
  /** The run id reported to DSH. */
  id(): string
}

const defaultRandom: EngineRandom = {
  nonce: () => randomBytes(6).toString('hex'),
  secret: () => randomBytes(16).toString('hex'),
  id: () => randomUUID(),
}

/** Services and environment the engine uses. */
export interface EngineDeps {
  /** Lazily resolves `ctx.subprocess`; undefined refuses external runs. */
  readonly subprocess: () => SubprocessPort | undefined
  readonly logger: LoggerPort
  /** Every live run is added here until it settles or is disposed. */
  readonly runs: RunTracker
  /** Host environment; defaults to `process.env`. */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>
  /** Where `${RUN_DIR}` directories are created; defaults to the OS temp dir. */
  readonly tmpDir?: string
  readonly random?: EngineRandom
  /** The plugin's lifetime: aborted on unload, so a run still starting then never spawns. */
  readonly lifetime?: AbortSignal
}

/** One run to start. */
export interface ExternalRunSpec {
  readonly adapter: CliAdapter
  /** Plan input; its `cwd` is validated here. */
  readonly input: PlanInput
  /** The CLI's plugin settings (executable, forwarded variables). */
  readonly settings: CliSettings
  /** Wall-clock limit in milliseconds. */
  readonly timeoutMs: number
  /** DSH's manager-owned signal: interrupt_agent and disposal abort it. */
  readonly signal: AbortSignal
  /** The parent's workspace root, when known: the bound of the symbolic-link check (else `input.cwd`). */
  readonly workspaceRoot?: string
}

// ---------------------------------------------------------------------------------------------------------------
// Placeholders and files

const PLACEHOLDER = /\$\{(RUN_DIR|HOME|SECRET)\}/g
const RUN_DIR_TOKEN = '$' + '{RUN_DIR}'

/** Values of the three placeholders for one run. */
interface Placeholders {
  readonly RUN_DIR: string
  readonly HOME: string
  readonly SECRET: string
}

function substitute(text: string, values: Placeholders): string {
  return text.replace(PLACEHOLDER, (_match, name: keyof Placeholders) => values[name])
}

/** Substitute an argv element only when it starts with a placeholder (user text is never rewritten). */
function substituteArg(arg: string, values: Placeholders): string {
  return /^\$\{(RUN_DIR|HOME|SECRET)\}/.test(arg) ? substitute(arg, values) : arg
}

/**
 * Substitute placeholders in the string leaves of a JSON value that start with a placeholder.
 * @param value - a JSON-compatible value.
 * @param values - placeholder values.
 * @returns a copy with substituted leaves.
 */
export function substituteLeaves(value: unknown, values: Placeholders): unknown {
  if (typeof value === 'string') return substituteArg(value, values)
  if (Array.isArray(value)) return value.map(item => substituteLeaves(item, values))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteLeaves(item, values)]))
  }
  return value
}

/**
 * Serialize a JSON value for an environment variable, writing `$`, `{` and `}` inside strings as
 * `\u` escapes (structural braces stay as they are).
 * @param value - a JSON-compatible value.
 * @returns JSON text.
 */
export function jsonEnvText(value: unknown): string {
  const text = JSON.stringify(value)
  let out = ''
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string
    if (inString) {
      if (char === '\\') {
        out += char + (text[i + 1] ?? '')
        i++
        continue
      }
      if (char === '"') inString = false
      else if (char === '$' || char === '{' || char === '}') {
        out += `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
        continue
      }
    } else if (char === '"') inString = true
    out += char
  }
  return out
}

/**
 * Resolve one plan file key to an absolute path inside its base directory.
 * @param key - `${RUN_DIR}/…` or `${HOME}/…`.
 * @param values - placeholder values.
 * @returns the absolute path.
 * @throws when the key has another prefix or escapes its base.
 */
export function resolvePlanFile(key: string, values: Pick<Placeholders, 'RUN_DIR' | 'HOME'>): string {
  const match = /^\$\{(RUN_DIR|HOME)\}\/(.+)$/.exec(key)
  if (match === null) throw new Error('a run file must start with the RUN_DIR or HOME placeholder')
  const base = values[match[1] as 'RUN_DIR' | 'HOME']
  const rest = match[2] as string
  if (rest.split(/[\\/]/).some(segment => segment === '..' || segment === '')) {
    throw new Error('a run file path must not contain empty or ".." segments')
  }
  const path = normalize(join(base, rest))
  if (!path.startsWith(base.endsWith(sep) ? base : base + sep)) throw new Error('a run file escapes its directory')
  return path
}

/** Files and the run directory of one run; {@link RunFiles.remove} is idempotent and never throws. */
class RunFiles {
  readonly #created: string[] = []
  #runDir: string | undefined
  #removed: Promise<void> | undefined

  async createRunDir(parent: string): Promise<string> {
    // mkdtemp creates the directory with mode 0700.
    this.#runDir = await mkdtemp(join(parent, 'dsh-rolesubagents-'))
    return this.#runDir
  }

  async write(files: Readonly<Record<string, string>>, values: Placeholders): Promise<void> {
    for (const [key, content] of Object.entries(files)) {
      const path = resolvePlanFile(key, values)
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      // `wx`: never overwrite an existing file (e.g. one of the user's own under HOME).
      await writeFile(path, content, { mode: 0o600, flag: 'wx' })
      this.#created.push(path)
    }
  }

  remove(): Promise<void> {
    this.#removed ??= (async () => {
      for (const path of this.#created.splice(0)) await rm(path, { force: true }).catch(() => {})
      if (this.#runDir !== undefined) await rm(this.#runDir, { recursive: true, force: true }).catch(() => {})
    })()
    return this.#removed
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Probe runner

/**
 * A {@link ProbeRunner} for one executable: no stdin, bounded collected output, a timeout.
 * @param subprocess - DSH's subprocess service.
 * @param executable - the resolved executable path.
 * @param env - the composed environment overlay of a run of this CLI.
 * @param cwd - working directory of the probe.
 * @returns the runner.
 */
export function createProbeRunner(
  subprocess: SubprocessPort,
  executable: string,
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): ProbeRunner {
  return async (argv, opts, signal) => {
    signal.throwIfAborted()
    const timeout = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      timeout.abort()
    }, opts.timeoutMs)
    const onAbort = (): void => timeout.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      let handle: SubprocessHandlePort
      try {
        handle = subprocess.spawn({
          argv: [executable, ...argv],
          cwd,
          stdio: {
            stdin: 'ignore',
            stdout: { maxBytes: PROBE_STDOUT_BYTES },
            stderr: { maxBytes: PROBE_STDERR_BYTES },
          },
          graceMs: 1_000,
          signal: timeout.signal,
          env: { ...env, ...opts.env },
        })
      } catch {
        return { code: null, stdout: '', stderr: '', timedOut: false }
      }
      const outcome = await handle.done.catch(() => ({ exitCode: null, signal: null }))
      await handle.waitForExit().catch(() => false)
      signal.throwIfAborted()
      return {
        code: timedOut ? null : outcome.exitCode,
        stdout: handle.collected.stdout?.readFrom(0).text ?? '',
        stderr: handle.collected.stderr?.readFrom(0).text ?? '',
        timedOut,
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Results

function textOutput(answer: string | undefined): SubagentResultPort['output'] {
  return answer !== undefined && answer.trim() !== '' ? [{ type: 'text', text: answer }] : []
}

function knownCategory(category: FailureCategory | undefined): FailureCategory {
  return category !== undefined && FAILURE_CATEGORIES.includes(category) ? category : 'unknown'
}

/**
 * Map a session's outcome to DSH's result vocabulary.
 * @param outcome - what the session concluded.
 * @param displayName - the CLI's display name, for the diagnostic.
 * @param flags - whether the run was cancelled or timed out (these win over the outcome).
 * @returns the result.
 */
export function toSubagentResult(
  outcome: RunOutcome,
  displayName: string,
  flags: { cancelled: boolean; timedOut: boolean },
): SubagentResultPort {
  const output = textOutput(outcome.answer)
  const failed = (category: FailureCategory): SubagentResultPort => ({
    output,
    stopReason: 'error',
    diagnostic: formatDiagnostic(displayName, category, outcome.facts),
  })
  if (flags.cancelled) return { output, stopReason: 'aborted' }
  if (flags.timedOut) return failed('timeout')
  switch (outcome.status) {
    case 'completed':
      return output.length > 0 ? { output, stopReason: 'completed' } : failed('empty-answer')
    case 'max-tokens':
      return {
        output,
        stopReason: 'max-tokens',
        diagnostic: formatDiagnostic(displayName, 'max-tokens', outcome.facts),
      }
    case 'refusal':
      return { output, stopReason: 'refusal' }
    default:
      return failed(knownCategory(outcome.category))
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Runs

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Ignore a throw from adapter code: sessions must not throw, and a throw must not escape into a stream callback. */
function contained(action: () => void, onThrow: (error: unknown) => void): void {
  try {
    action()
  } catch (error) {
    onThrow(error)
  }
}

/**
 * Start one external run.
 * @param spec - adapter, plan input, settings, timeout and DSH's signal.
 * @param deps - services and environment.
 * @returns the run; its `result` never rejects and `dispose` is idempotent.
 * @throws a safe message when the run cannot start (no subprocess service, bad cwd, CLI not found,
 * invalid plan, failed pre-flight, spawn failure). Nothing is left behind on a throw.
 */
export async function startExternalRun(spec: ExternalRunSpec, deps: EngineDeps): Promise<SubagentRunPort> {
  const { adapter, settings } = spec
  const name = adapter.descriptor.displayName
  const random = deps.random ?? defaultRandom
  const hostEnv = deps.hostEnv ?? process.env
  // The delegation's signal and the plugin's lifetime: an unload during startup must not spawn afterwards.
  const signal = deps.lifetime === undefined ? spec.signal : AbortSignal.any([spec.signal, deps.lifetime])
  signal.throwIfAborted()
  const subprocess = deps.subprocess()
  if (subprocess === undefined) {
    throw new Error(`${name} roles need the Host's subprocess service, which is not available`)
  }
  const cwd = assertUsableCwd(spec.input.cwd)
  const input: PlanInput = { ...spec.input, cwd }
  await checkWorkspace({ adapter, input, workspaceRoot: spec.workspaceRoot, home: hostEnv.HOME, signal, deps })
  signal.throwIfAborted()
  const nonce = random.nonce()
  const plan: RunPlan = adapter.plan(input, nonce)
  const session: RunSession = adapter.createSession(input, nonce)

  const files = new RunFiles()
  try {
    const placeholdersBase = { SECRET: random.secret() }
    // HOME: the plan's own override (rare), else the Host's.
    const planHome = plan.env.HOME
    const home = typeof planHome === 'string' ? planHome : (hostEnv.HOME ?? homedir())
    const needsRunDir = JSON.stringify([
      plan.argv,
      plan.env,
      plan.envJson ?? {},
      Object.keys(plan.files ?? {}),
    ]).includes(RUN_DIR_TOKEN)
    const runDir = needsRunDir ? await files.createRunDir(deps.tmpDir ?? tmpdir()) : ''
    signal.throwIfAborted()
    const values: Placeholders = { ...placeholdersBase, RUN_DIR: runDir, HOME: home }
    const overlay: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(plan.env)) {
      overlay[key] = value === undefined ? undefined : substitute(value, values)
    }
    for (const [key, value] of Object.entries(plan.envJson ?? {})) {
      overlay[key] = jsonEnvText(substituteLeaves(value, values))
    }
    const env = composeEnv({
      overlay,
      ...(plan.envRemovePrefixes === undefined ? {} : { removePrefixes: plan.envRemovePrefixes }),
      ...(settings.envPassthrough === undefined ? {} : { passthrough: settings.envPassthrough }),
      hostEnv,
    })
    const argv = plan.argv.map(arg => substituteArg(arg, values))

    const command = settings.executable ?? adapter.descriptor.executable
    let executable: string
    try {
      executable = await subprocess.resolveExecutable(command, definedEntries(env), signal)
    } catch {
      signal.throwIfAborted()
      throw new Error(`${name} was not found (set its path in the plugin settings)`)
    }
    signal.throwIfAborted()
    if (plan.files !== undefined) {
      try {
        await files.write(plan.files, values)
      } catch (error) {
        deps.logger.warn(`rolesubagents: could not prepare ${name} run files: ${message(error)}`)
        throw new Error(`${name} run files could not be prepared`)
      }
      signal.throwIfAborted()
    }
    if (plan.preflight !== undefined) {
      const check = await createProbeRunner(
        subprocess,
        executable,
        env,
        cwd,
      )(plan.preflight.argv, { timeoutMs: plan.preflight.timeoutMs }, signal)
      signal.throwIfAborted()
      if (check.code !== 0) {
        throw new Error(
          formatDiagnostic(name, plan.preflight.category, check.timedOut ? { 'pre-flight': 'timeout' } : {}),
        )
      }
    }
    // Nothing is awaited from here until the run is tracked, so an unload cannot slip in between.
    signal.throwIfAborted()
    let handle: SubprocessHandlePort
    try {
      handle = subprocess.spawn({
        argv: [executable, ...argv],
        cwd,
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        graceMs: SPAWN_GRACE_MS,
        env,
      })
    } catch (error) {
      deps.logger.warn(`rolesubagents: could not spawn ${name}: ${message(error)}`)
      throw new Error(`${name} could not be started`)
    }
    return superviseRun({ spec, deps, plan, session, handle, files, id: random.id(), name })
  } catch (error) {
    await files.remove()
    throw error
  }
}

/**
 * Refuse a run whose CLI could reach outside the workspace (see `workspace.ts`). Messages are fixed text
 * with the CLI's name and the working directory; details (a link's path) go to the Host log only.
 * - below full access: project startup code the CLI would run (`descriptor.startupCodeDirs`);
 * - a workspace-write run of a `tool-scope` preset: a git top-level above the directory when the CLI's tool
 *   scope is the git worktree, and any symbolic link in the directory that leads outside the workspace root.
 * @throws the refusal.
 */
async function checkWorkspace(options: {
  adapter: CliAdapter
  input: PlanInput
  workspaceRoot: string | undefined
  home: string | undefined
  signal: AbortSignal
  deps: EngineDeps
}): Promise<void> {
  const { adapter, input, signal, deps } = options
  const descriptor = adapter.descriptor
  const name = descriptor.displayName
  const { cwd } = input
  const alternatives = 'Use a read-only role, or delegate from a parent with full access.'
  if (input.access !== 'full-access' && descriptor.startupCodeDirs !== undefined) {
    const found = await findStartupCodeDir(cwd, descriptor.startupCodeDirs, options.home)
    if (found !== undefined) {
      deps.logger.warn(`rolesubagents: ${name} refused in ${cwd}: project startup code at ${found}`)
      throw new Error(
        `${name} cannot run in ${cwd}: the project has ${descriptor.startupCodeDirs.join(' or ')} code that ${name} would run at start below full access. Delegate from a parent with full access, or use another CLI.`,
      )
    }
  }
  if (input.access !== 'workspace-write') return
  const confinement = permissionPreset(descriptor, input.preset)?.confinement ?? 'tool-scope'
  if (confinement !== 'tool-scope') return
  if (descriptor.toolScope === 'git-worktree') {
    const top = await gitTopLevelAbove(cwd)
    if (top !== undefined) {
      deps.logger.info(`rolesubagents: ${name} refused in ${cwd}: git top-level ${top} is above it`)
      throw new Error(
        `${name} cannot edit files in ${cwd}: it is below the top-level of a git repository, and ${name}'s file tools would reach the whole repository. Delegate with the repository's top-level directory as cwd. ${alternatives}`,
      )
    }
  }
  signal.throwIfAborted()
  const finding = await findEscapingLink(cwd, options.workspaceRoot ?? cwd, signal)
  if (finding?.kind === 'link') {
    deps.logger.warn(
      `rolesubagents: ${name} refused in ${cwd}: symbolic link ${finding.path} leads outside the workspace`,
    )
    throw new Error(
      `${name} cannot edit files in ${cwd}: the directory contains a symbolic link that leads outside the workspace, and ${name}'s file tools would follow it. Remove the link. ${alternatives}`,
    )
  }
  if (finding?.kind === 'unreadable') {
    deps.logger.warn(`rolesubagents: ${name} could not inspect ${finding.path}`)
    throw new Error(
      `${name} cannot edit files in ${cwd}: part of the workspace could not be checked for symbolic links. ${alternatives}`,
    )
  }
  if (finding?.kind === 'budget') {
    throw new Error(
      `${name} cannot edit files in ${cwd}: the directory is too large to check for symbolic links that lead outside the workspace (over ${SCAN_MAX_ENTRIES} entries or ${SCAN_MAX_MS / 1000} s). Use a smaller directory. ${alternatives}`,
    )
  }
}

interface Supervised {
  readonly spec: ExternalRunSpec
  readonly deps: EngineDeps
  readonly plan: RunPlan
  readonly session: RunSession
  readonly handle: SubprocessHandlePort
  readonly files: RunFiles
  readonly id: string
  readonly name: string
}

/** Wire a spawned process to its session and publish the DSH run handle. */
function superviseRun(parts: Supervised): SubagentRunPort {
  const { spec, deps, plan, session, handle, files, id, name } = parts
  let cancelled = false
  let timedOut = false
  let stopping = false
  let settled = false
  let crashed: unknown
  const timers: ReturnType<typeof setTimeout>[] = []
  const stderr = new ByteTail()
  const crash = (error: unknown): void => {
    crashed ??= error
    stop()
  }

  // --- stdin --------------------------------------------------------------------------------------------------
  const stdin = handle.stdin
  stdin?.on('error', () => {}) // EPIPE after the child exited must not crash the Host.
  let stdinOpen = stdin !== undefined
  const io = {
    write(text: string): void {
      if (!stdinOpen || stdin === undefined || stdin.destroyed === true || stdin.writableEnded === true) return
      stdin.write(text)
    },
    end(): void {
      if (!stdinOpen) return
      stdinOpen = false
      stdin?.end()
    },
  }

  // --- stop: graceful cancel, then terminate -------------------------------------------------------------------
  function stop(): void {
    if (stopping || settled) return
    stopping = true
    if (session.cancel !== undefined) {
      contained(
        () => session.cancel?.(),
        () => {},
      )
      timers.push(setTimeout(() => handle.terminate(), Math.max(0, plan.cancelGraceMs)))
    } else handle.terminate()
  }
  const onAbort = (): void => {
    if (settled) return
    cancelled = true
    stop()
  }
  spec.signal.addEventListener('abort', onAbort, { once: true })
  if (spec.signal.aborted) onAbort()
  timers.push(
    setTimeout(() => {
      if (settled || cancelled) return
      timedOut = true
      stop()
    }, spec.timeoutMs),
  )

  // --- stdout / stderr ---------------------------------------------------------------------------------------
  const splitter = new LineSplitter(line => contained(() => session.line(line), crash), {
    onOverflow: () => deps.logger.warn(`rolesubagents: ${name} run ${id} wrote an oversized line; it was dropped`),
  })
  const drained = new Promise<void>(resolve => {
    const stdout = handle.stdout
    if (stdout === undefined) return resolve()
    stdout.on('data', (chunk: Uint8Array | string) => splitter.push(chunk))
    stdout.once('end', () => resolve())
    stdout.once('close', () => resolve())
    stdout.once('error', () => resolve())
  })
  handle.stderr?.on('data', (chunk: Uint8Array | string) => stderr.push(chunk))
  handle.stderr?.on('error', () => {})
  contained(() => session.start(io), crash)

  // --- settlement -------------------------------------------------------------------------------------------
  /** Untracked once settled; assigned below, before the result can settle. */
  let tracked: SubagentRunPort | undefined
  const result = (async (): Promise<SubagentResultPort> => {
    let exit: { code: number | null; signal: string | null } = { code: null, signal: null }
    try {
      try {
        const outcome = await handle.done
        exit = { code: outcome.exitCode, signal: outcome.signal }
      } catch (error) {
        crashed ??= error
      }
      await Promise.race([drained, new Promise(resolve => timers.push(setTimeout(resolve, DRAIN_MS)))])
      splitter.end()
      io.end()
      let outcome: RunOutcome
      try {
        outcome =
          crashed === undefined
            ? session.finish({ ...exit, stderrTail: stderr.text(), cancelled, timedOut })
            : { status: 'failed', category: 'cli-crashed' }
      } catch (error) {
        crashed ??= error
        outcome = { status: 'failed', category: 'cli-crashed' }
      }
      const facts = { ...(exit.code === null ? {} : { 'exit code': exit.code }), ...outcome.facts }
      const mapped = toSubagentResult({ ...outcome, facts }, name, { cancelled, timedOut })
      if (mapped.stopReason !== 'completed' && mapped.stopReason !== 'aborted') {
        const why = crashed === undefined ? '' : `; ${message(crashed)}`
        const tail = stderr.text().trim()
        deps.logger.warn(
          `rolesubagents: ${name} run ${id} ended with ${mapped.stopReason} (${mapped.diagnostic?.split('\n')[0] ?? ''}${why})` +
            (tail === '' ? '' : `\nstderr tail:\n${tail}`),
        )
      }
      return mapped
    } catch (error) {
      // Defensive: nothing above should throw, but `result` must never reject.
      deps.logger.warn(`rolesubagents: ${name} run ${id} could not be settled: ${message(error)}`)
      return cancelled
        ? { output: [], stopReason: 'aborted' }
        : { output: [], stopReason: 'error', diagnostic: formatDiagnostic(name, 'unknown') }
    } finally {
      settled = true
      for (const timer of timers.splice(0)) clearTimeout(timer)
      spec.signal.removeEventListener('abort', onAbort)
      await files.remove()
      if (tracked !== undefined) deps.runs.delete(tracked)
    }
  })()

  let disposal: Promise<void> | undefined
  const run: SubagentRunPort = {
    id,
    result,
    /**
     * Stop the run if it is still live (graceful cancel → `cancelGraceMs` → terminate), wait for the
     * result, then terminate the managed process range once more and wait until it is empty.
     * The final terminate is what ends a daemon or background child the CLI left behind after its own
     * exit: DSH's `waitForExit` resolves only when the whole range (systemd scope or process group) is
     * empty, so without it a leftover would hang the disposal (and DSH's completion notice) forever. It
     * is cheap when the range is already empty. Idempotent.
     */
    dispose() {
      disposal ??= (async () => {
        spec.signal.removeEventListener('abort', onAbort)
        if (!settled) {
          cancelled = true
          // Graceful cancel, then terminate after cancelGraceMs (immediately without session.cancel).
          stop()
        }
        await result
        try {
          handle.terminate()
        } catch (error) {
          deps.logger.warn(`rolesubagents: could not terminate ${name} run ${id}: ${message(error)}`)
        }
        await handle.waitForExit().catch(() => false)
        deps.runs.delete(run)
      })()
      return disposal
    },
  }
  tracked = run
  if (!settled) deps.runs.add(run)
  return run
}
