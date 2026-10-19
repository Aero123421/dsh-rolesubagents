/**
 * The editor's "Test connection" check, as a pure-ish function of injected
 * services so it is testable without DSH's Remote machinery (the Remote
 * service wrapper lives in `probe-service.ts`).
 *
 * It resolves the CLI's executable (settings path or the descriptor's name)
 * and, when the adapter implements `probe`, lets it run cheap side-effect-free
 * commands (version, sign-in state, model list). It never calls a model.
 */

import { homedir } from 'node:os'
import { cliDescriptor, isCliId } from '../../shared/cli/index.ts'
import type { CliSettingsMap } from '../../shared/runner.ts'
import type { SubprocessPort } from '../ports.ts'
import { createProbeRunner } from './engine.ts'
import { composeEnv, definedEntries } from './env.ts'
import type { AdapterLookup } from './registry.ts'
import type { ProbeResult } from './types.ts'

/** What a probe call receives from the browser. */
export interface ProbeRequest {
  readonly cli: string
}

/** Services a probe uses. */
export interface ProbeDeps {
  readonly subprocess: SubprocessPort | undefined
  readonly adapters: AdapterLookup
  readonly settings: CliSettingsMap | undefined
  /** Host environment; defaults to `process.env`. */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>
  /** Working directory of probe commands; defaults to the Host user's home. */
  readonly cwd?: string
}

/**
 * Check one CLI.
 * @param request - `{ cli }` from the editor (validated here).
 * @param deps - services and settings.
 * @param signal - aborts the probe.
 * @returns what was found; `message` is a fixed word (`subprocess-unavailable`, `not-found`, `probe-failed`).
 * @throws for an unknown CLI id, or when `signal` aborts.
 */
export async function probeCli(request: unknown, deps: ProbeDeps, signal: AbortSignal): Promise<ProbeResult> {
  const cli = typeof request === 'object' && request !== null ? (request as { cli?: unknown }).cli : undefined
  if (!isCliId(cli)) throw new Error('unknown CLI')
  signal.throwIfAborted()
  if (deps.subprocess === undefined) return { cli, found: false, message: 'subprocess-unavailable' }
  const settings = deps.settings?.[cli] ?? {}
  const hostEnv = deps.hostEnv ?? process.env
  const env = composeEnv({
    overlay: {},
    ...(settings.envPassthrough === undefined ? {} : { passthrough: settings.envPassthrough }),
    hostEnv,
  })
  let path: string
  try {
    path = await deps.subprocess.resolveExecutable(
      settings.executable ?? cliDescriptor(cli).executable,
      definedEntries(env),
      signal,
    )
  } catch {
    signal.throwIfAborted()
    return { cli, found: false, message: 'not-found' }
  }
  const adapter = deps.adapters(cli)
  if (adapter.probe === undefined) return { cli, found: true, path }
  const run = createProbeRunner(deps.subprocess, path, env, deps.cwd ?? hostEnv.HOME ?? homedir())
  try {
    const result = await adapter.probe(path, run, signal, settings)
    return { ...result, cli, found: true, path }
  } catch {
    signal.throwIfAborted()
    return { cli, found: true, path, message: 'probe-failed' }
  }
}
