/**
 * OpenCode probe: version and model list for the editor, without calling a model.
 *
 * - `opencode --version` prints a bare semver line (`1.19.3`).
 * - `opencode models --verbose` prints, per model, a `provider/model` line followed by a
 *   pretty-printed JSON object whose `variants` keys are the model's effort names.
 *   The `provider/model` lines alone are the plain `opencode models` output, so ids survive
 *   even when a JSON block is cut off by the output limit.
 * Sign-in state is not cheap to read reliably (credentials can come from auth.json, env vars
 * or config), so it is reported as `unknown`.
 */

import type { ProbeModel, ProbeResult, ProbeRunner } from '../../external/types.ts'

/** Time box of each probe command. */
export const PROBE_TIMEOUT_MS = 20_000

/** Most models reported to the editor. */
const MAX_MODELS = 500

/** Environment of probe commands: no auto-update, no writes to the user's session database. */
const PROBE_ENV = Object.freeze({ OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DB: ':memory:' })

const MODEL_LINE = /^([A-Za-z0-9][\w.@-]*\/\S+)$/
const SAFE_NAME = /^[^\u0000-\u001f]{1,128}$/
const SAFE_EFFORT = /^[A-Za-z0-9][\w.-]{0,31}$/

/**
 * Parse `opencode --version` output.
 * @param stdout - the command's stdout.
 * @returns the version, or undefined.
 */
export function parseVersion(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^v?(\d+\.\d+\.\d+[\w.+-]*)$/.exec(line.trim())
    if (match !== null) return match[1]
  }
  return undefined
}

function modelDetails(block: string): { name?: string; efforts?: string[] } {
  if (block.trim() === '') return {}
  let value: unknown
  try {
    value = JSON.parse(block)
  } catch {
    return {}
  }
  if (typeof value !== 'object' || value === null) return {}
  const record = value as { name?: unknown; variants?: unknown }
  const name = typeof record.name === 'string' && SAFE_NAME.test(record.name) ? record.name : undefined
  const variants =
    typeof record.variants === 'object' && record.variants !== null && !Array.isArray(record.variants)
      ? Object.keys(record.variants).filter(key => SAFE_EFFORT.test(key))
      : []
  return { ...(name === undefined ? {} : { name }), ...(variants.length === 0 ? {} : { efforts: variants }) }
}

/**
 * Parse `opencode models [--verbose]` output.
 * @param stdout - the command's stdout (ANSI-free; plain or verbose).
 * @returns the models in output order, de-duplicated.
 */
export function parseModels(stdout: string): ProbeModel[] {
  const models: ProbeModel[] = []
  const seen = new Set<string>()
  let current: string | undefined
  let block: string[] = []
  const flush = (): void => {
    if (current !== undefined && !seen.has(current) && models.length < MAX_MODELS) {
      seen.add(current)
      models.push({ id: current, ...modelDetails(block.join('\n')) })
    }
    current = undefined
    block = []
  }
  const lines = stdout.split(/\r?\n/)
  // Verbose output follows every id with a JSON block: a trailing id without one was cut off by the output limit.
  while (lines.length > 0 && lines.at(-1)?.trim() === '') lines.pop()
  if (stdout.includes('{') && MODEL_LINE.test(lines.at(-1) ?? '')) lines.pop()
  for (const raw of lines) {
    const match = MODEL_LINE.exec(raw)
    if (match !== null) {
      flush()
      current = match[1]
    } else if (current !== undefined) block.push(raw)
  }
  flush()
  return models
}

/**
 * Probe OpenCode.
 * @param run - runs the resolved executable.
 * @param signal - aborts the probe.
 * @returns version, models (when listed) and `auth: 'unknown'`.
 */
export async function probeOpencode(run: ProbeRunner, signal: AbortSignal): Promise<ProbeResult> {
  const version = await run(['--version'], { timeoutMs: PROBE_TIMEOUT_MS, env: PROBE_ENV }, signal)
  const parsedVersion = version.code === 0 ? parseVersion(version.stdout) : undefined
  const listed = await run(['models', '--verbose'], { timeoutMs: PROBE_TIMEOUT_MS, env: PROBE_ENV }, signal)
  const models = listed.code === 0 ? parseModels(listed.stdout) : []
  return {
    cli: 'opencode',
    found: true,
    ...(parsedVersion === undefined ? {} : { version: parsedVersion }),
    auth: 'unknown',
    ...(models.length === 0 ? {} : { models }),
    ...(listed.code === 0 ? {} : { message: listed.timedOut ? 'models-timeout' : 'models-unavailable' }),
  }
}
