/**
 * Test doubles for the external-run engine: a scriptable fake of DSH's `ctx.subprocess` and a small
 * line-protocol test adapter. Nothing here starts a real process.
 */

import { PassThrough } from 'node:stream'
import { vi } from 'vitest'
import { CODEX } from '../src/shared/cli/codex.ts'
import type { CliDescriptor } from '../src/shared/cli/index.ts'
import type { CliAdapter, PlanInput, RunOutcome, RunPlan, RunSession, SessionIO } from '../src/host/external/types.ts'
import type { SubprocessHandlePort, SubprocessPort, SubprocessSpawnSpecPort } from '../src/host/ports.ts'

/** One spawned fake process, as a test script drives it. */
export interface FakeProcess {
  readonly spec: SubprocessSpawnSpecPort
  /** Everything written to stdin so far. */
  stdinText(): string
  readonly stdinEnded: boolean
  /** Write raw bytes or text to stdout / stderr. */
  stdout(chunk: string | Uint8Array): void
  stderr(chunk: string | Uint8Array): void
  /** Close stdout and stderr and settle `done`. */
  exit(code: number | null, signal?: string | null): void
  /** Reject `done` (e.g. ENOENT) after closing the streams. */
  fail(error: Error): void
  readonly terminated: number
  readonly exited: boolean
  /** Leave a daemon/background child in the managed range: it outlives the CLI until `terminate()`. */
  leaveChild(): void
  /** True while a leftover child is alive in the range. */
  readonly childAlive: boolean
  /** Resolves when stdin is closed by the session. */
  readonly stdinClosed: Promise<string>
}

export interface FakeSubprocessOptions {
  /** Executables `resolveExecutable` finds: name → path. Default: any bare name resolves to `/bin/<name>`. */
  readonly executables?: Record<string, string>
  /** Drives a pipe-mode process (the real run). Default: exits 0 immediately. */
  readonly onRun?: (process: FakeProcess) => void
  /** Collected-mode processes (probes, pre-flights): argv → result. */
  readonly onCollect?: (spec: SubprocessSpawnSpecPort) => { code: number | null; stdout?: string; stderr?: string }
  /** When true, `terminate()` does not end the process (it must exit by itself). */
  readonly ignoreTerminate?: boolean
  /** Throw synchronously from `spawn` for pipe-mode processes. */
  readonly spawnThrows?: boolean
  /** Every pipe-mode process leaves a background child in its range (see {@link FakeProcess.leaveChild}). */
  readonly leftoverChild?: boolean
  /** `terminate()` throws once the CLI process has exited. */
  readonly terminateThrowsAfterExit?: boolean
}

export interface FakeSubprocess extends SubprocessPort {
  readonly processes: FakeProcess[]
  readonly collected: SubprocessSpawnSpecPort[]
  readonly resolveCalls: { command: string; env?: Readonly<Record<string, string>> }[]
}

function collectedHandle(spec: SubprocessSpawnSpecPort, options: FakeSubprocessOptions): SubprocessHandlePort {
  const result = options.onCollect?.(spec) ?? { code: 0 }
  const reader = (text: string) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  return {
    collected: { stdout: reader(result.stdout ?? ''), stderr: reader(result.stderr ?? '') },
    done: Promise.resolve({ exitCode: result.code, signal: null }),
    terminate: () => {},
    waitForExit: async () => true,
  }
}

/**
 * A fake `ctx.subprocess`.
 * @param options - executables, the run script and probe answers.
 * @returns the service plus everything it saw.
 */
export function fakeSubprocess(options: FakeSubprocessOptions = {}): FakeSubprocess {
  const processes: FakeProcess[] = []
  const collected: SubprocessSpawnSpecPort[] = []
  const resolveCalls: FakeSubprocess['resolveCalls'] = []
  return {
    processes,
    collected,
    resolveCalls,
    async resolveExecutable(command, env) {
      resolveCalls.push({ command, ...(env === undefined ? {} : { env }) })
      if (options.executables !== undefined) {
        const found = options.executables[command]
        if (found === undefined) throw new Error(`${command} not found`)
        return found
      }
      if (command.startsWith('/')) return command
      return `/bin/${command}`
    },
    spawn(spec) {
      if (typeof spec.stdio.stdout === 'object') {
        collected.push(spec)
        return collectedHandle(spec, options)
      }
      if (options.spawnThrows === true) throw new Error('spawn failed: secret detail')
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let input = ''
      let stdinEnded = false
      let terminated = 0
      let exited = false
      let settle!: (outcome: { exitCode: number | null; signal: string | null }) => void
      let reject!: (error: Error) => void
      const done = new Promise<{ exitCode: number | null; signal: string | null }>((resolve, fail) => {
        settle = resolve
        reject = fail
      })
      const stdinClosed = new Promise<string>(resolve => {
        stdin.on('data', chunk => {
          input += String(chunk)
        })
        stdin.on('end', () => {
          stdinEnded = true
          resolve(input)
        })
      })
      const close = (): void => {
        stdout.end()
        stderr.end()
      }
      // The managed range (DSH: systemd scope or process group): `waitForExit` resolves only once the
      // CLI exited AND no leftover child remains; `terminate()` kills the whole range, leftovers included.
      let childAlive = options.leftoverChild === true
      let rangeEmptied!: () => void
      const rangeEmpty = new Promise<void>(resolve => {
        rangeEmptied = resolve
      })
      const killChild = (): void => {
        childAlive = false
        rangeEmptied()
      }
      if (!childAlive) rangeEmptied()
      let rangeWait = rangeEmpty
      const process: FakeProcess = {
        spec,
        stdinText: () => input,
        get stdinEnded() {
          return stdinEnded
        },
        stdout: chunk => {
          if (!exited) stdout.write(chunk)
        },
        stderr: chunk => {
          if (!exited) stderr.write(chunk)
        },
        exit(code, signal = null) {
          if (exited) return
          exited = true
          close()
          settle({ exitCode: code, signal })
        },
        fail(error) {
          if (exited) return
          exited = true
          close()
          reject(error)
        },
        get terminated() {
          return terminated
        },
        get exited() {
          return exited
        },
        leaveChild() {
          if (childAlive) return
          childAlive = true
          // A fresh, pending range promise: replace the resolved one.
          rangeWait = new Promise<void>(resolve => {
            rangeEmptied = resolve
          })
        },
        get childAlive() {
          return childAlive
        },
        stdinClosed,
      }
      processes.push(process)
      const handle: SubprocessHandlePort = {
        stdin,
        stdout,
        stderr,
        collected: {},
        done,
        terminate() {
          if (options.terminateThrowsAfterExit === true && exited) throw new Error('range gone')
          terminated++
          if (options.ignoreTerminate !== true) {
            process.exit(null, 'SIGTERM')
            killChild()
          }
        },
        async waitForExit() {
          await done.catch(() => {})
          await rangeWait
          return true
        },
      }
      queueMicrotask(() => (options.onRun ?? (p => p.exit(0)))(process))
      return handle
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// A line-protocol test adapter

/**
 * Protocol of the test adapter (and of `tests/support/fake-cli/fake-cli.mjs`):
 * stdin carries the task text then EOF; stdout lines are JSON
 * `{"type":"text","text":…}` (appended to the answer), `{"type":"done"}` (terminal success) or
 * `{"type":"error","category":…}` (terminal failure). Anything else is ignored.
 */
export class LineSession implements RunSession {
  answer = ''
  done = false
  failure: RunOutcome['category'] | undefined
  readonly lines: string[] = []
  cancelled = 0
  io: SessionIO | undefined
  readonly #task: string

  constructor(task: string, cancellable: boolean) {
    this.#task = task
    if (!cancellable) this.cancel = undefined
  }

  start(io: SessionIO): void {
    this.io = io
    io.write(this.#task)
    io.end()
  }

  line(text: string): void {
    this.lines.push(text)
    let event: { type?: unknown; text?: unknown; category?: unknown }
    try {
      event = JSON.parse(text)
    } catch {
      return
    }
    if (event.type === 'text' && typeof event.text === 'string') this.answer += event.text
    else if (event.type === 'done') this.done = true
    else if (event.type === 'error') this.failure = event.category as RunOutcome['category']
  }

  cancel: (() => void) | undefined = () => {
    this.cancelled++
    this.io?.end()
  }

  finish(exit: { code: number | null }): RunOutcome {
    if (this.failure !== undefined) return { status: 'failed', category: this.failure, answer: this.answer }
    if (this.done) return { status: 'completed', answer: this.answer }
    return { status: 'failed', category: 'cli-crashed', answer: this.answer, facts: { 'exit code': exit.code ?? -1 } }
  }
}

export interface TestAdapterOptions {
  readonly descriptor?: CliDescriptor
  /** Changes the plan the adapter returns. */
  readonly plan?: (input: PlanInput, nonce: string) => Partial<RunPlan>
  /** Whether sessions implement `cancel` (default true). */
  readonly cancellable?: boolean
}

/** A test adapter speaking {@link LineSession}'s protocol; records sessions and plans. */
export function testAdapter(options: TestAdapterOptions = {}): CliAdapter & {
  sessions: LineSession[]
  inputs: PlanInput[]
  nonces: string[]
} {
  const sessions: LineSession[] = []
  const inputs: PlanInput[] = []
  const nonces: string[] = []
  return {
    descriptor: options.descriptor ?? CODEX,
    sessions,
    inputs,
    nonces,
    plan: vi.fn((input: PlanInput, nonce: string): RunPlan => {
      inputs.push(input)
      nonces.push(nonce)
      return { argv: ['run', '--preset', input.preset], env: {}, cancelGraceMs: 50, ...options.plan?.(input, nonce) }
    }),
    createSession(input) {
      const session = new LineSession(input.task, options.cancellable !== false)
      sessions.push(session)
      return session
    },
  }
}

/** One JSON stdout line of the test protocol. */
export const line = (event: Record<string, unknown>): string => `${JSON.stringify(event)}\n`
