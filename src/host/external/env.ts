/**
 * Child environment composition for external runs.
 *
 * DSH's subprocess service merges the overlay built here over its scrubbed
 * copy of the Host environment (credential-shaped names and `DSH_*` removed;
 * an `undefined` entry removes an inherited one). So:
 * 1. markers of running inside another coding agent are removed ({@link FIXED_REMOVALS});
 * 2. inherited names with an adapter-declared prefix are removed (e.g. `CLAUDE_CODE_`);
 * 3. the adapter's overlay applies;
 * 4. variables the user forwards by name are copied from the Host environment —
 *    they override removals but never an explicit adapter value.
 */

/** Inherited variables that would make a CLI believe it runs nested inside another agent. */
export const FIXED_REMOVALS: readonly string[] = Object.freeze([
  'CLAUDECODE',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
])

/** Inputs of {@link composeEnv}. */
export interface EnvInput {
  /** The adapter's overlay, placeholders already substituted. */
  readonly overlay: Readonly<Record<string, string | undefined>>
  /** Inherited variables starting with one of these are removed. */
  readonly removePrefixes?: readonly string[]
  /** Variable names forwarded from the Host environment (the CLI's `envPassthrough`). */
  readonly passthrough?: readonly string[]
  /** The Host environment (`process.env`). */
  readonly hostEnv: Readonly<Record<string, string | undefined>>
}

/**
 * Build the overlay handed to `ctx.subprocess.spawn`.
 * @param input - adapter overlay, prefix removals, forwarded names and the Host environment.
 * @returns entries to set (string) or remove (undefined).
 */
export function composeEnv(input: EnvInput): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {}
  for (const name of FIXED_REMOVALS) env[name] = undefined
  for (const prefix of input.removePrefixes ?? []) {
    if (prefix === '') continue
    for (const name of Object.keys(input.hostEnv)) if (name.startsWith(prefix)) env[name] = undefined
  }
  for (const [name, value] of Object.entries(input.overlay)) env[name] = value
  for (const name of input.passthrough ?? []) {
    const value = input.hostEnv[name]
    if (value !== undefined && typeof input.overlay[name] !== 'string') env[name] = value
  }
  return env
}

/**
 * The string-only view used for executable lookup (`resolveExecutable` takes no removals).
 * @param env - a composed overlay.
 * @returns entries with a value.
 */
export function definedEntries(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) if (value !== undefined) result[name] = value
  return result
}
