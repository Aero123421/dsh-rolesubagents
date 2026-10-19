/**
 * Safe diagnostics for failed external runs.
 *
 * A diagnostic reaches the parent model, so it is built only from fixed
 * vocabulary: the CLI's display name, a {@link FailureCategory}, filtered
 * facts and one fixed hint per category. Raw CLI or provider text (which can
 * carry URLs, keys or request bodies) never appears here.
 */

import type { FailureCategory } from './types.ts'

/** DSH's diagnostic limit in UTF-8 bytes (`SubagentResult.diagnostic`). */
export const MAX_DIAGNOSTIC_BYTES = 4096

const TRUNCATION_SUFFIX = '…'
const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Cut text to {@link MAX_DIAGNOSTIC_BYTES} UTF-8 bytes without splitting a character
 * (same rule as `@deepseek-ai/dsh-subagent`'s `limitSubagentDiagnostic`).
 * @param text - any text.
 * @returns the text, or its prefix plus `…` when it is too long.
 */
export function limitDiagnostic(text: string): string {
  const bytes = encoder.encode(text)
  if (bytes.byteLength <= MAX_DIAGNOSTIC_BYTES) return text
  let end = MAX_DIAGNOSTIC_BYTES - encoder.encode(TRUNCATION_SUFFIX).byteLength
  // Step back over UTF-8 continuation bytes (10xxxxxx) to a character boundary.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--
  return decoder.decode(bytes.subarray(0, end)) + TRUNCATION_SUFFIX
}

/** One fixed explanation per category; `unknown` adds none. */
export const CATEGORY_HINTS: Readonly<Record<FailureCategory, string | undefined>> = Object.freeze({
  auth: 'The CLI is not signed in or its API key was rejected. Sign in with the CLI on the host, or forward its API-key variable in the plugin settings.',
  limit: "The CLI's account reached a usage, budget or turn limit.",
  'rate-limit': 'The model provider rate-limited the request. Try again later.',
  model:
    "The configured model was not found or is not available to this account. Check the role's model in the plugin settings.",
  'max-tokens': "The task did not fit the model's context window. Delegate a smaller task.",
  service: 'The model provider returned a server error. Try again later.',
  transport: 'The CLI could not reach the model provider (network or proxy problem).',
  permission:
    "The CLI's permission preset blocked actions the task needed. Use a role with a wider preset only if that is intended.",
  config:
    "The CLI rejected its configuration (for example an effort the model does not support). Check the role's runner settings.",
  'cli-missing': 'The CLI executable was not found on the host. Set its path in the plugin settings.',
  'cli-crashed': 'The CLI exited without a final result.',
  timeout: "The run exceeded the role's time limit and was stopped.",
  'empty-answer': 'The CLI finished without a final answer.',
  unknown: undefined,
})

const FACT_KEY = /^[a-z][a-z ]{0,31}$/
const FACT_TEXT = /^[A-Za-z0-9_.:-]{1,64}$/

/**
 * Keep only facts that are safe by construction: short lowercase keys, finite
 * numbers or short identifier-like strings.
 * @param facts - facts reported by a session.
 * @returns `key: value` parts in input order.
 */
export function safeFacts(facts: Readonly<Record<string, string | number>> | undefined): string[] {
  if (facts === undefined) return []
  const parts: string[] = []
  for (const [key, value] of Object.entries(facts)) {
    if (!FACT_KEY.test(key)) continue
    if (typeof value === 'number' ? Number.isFinite(value) : typeof value === 'string' && FACT_TEXT.test(value)) {
      parts.push(`${key}: ${value}`)
    }
  }
  return parts
}

/**
 * The diagnostic for one failed run, e.g.
 * `Subagent failure (CLI: Codex; category: auth; exit code: 1)` plus the category's hint line.
 * @param displayName - the CLI's display name (from its descriptor).
 * @param category - why the run failed.
 * @param facts - optional safe facts (filtered by {@link safeFacts}).
 * @returns at most {@link MAX_DIAGNOSTIC_BYTES} bytes of fixed-vocabulary text.
 */
export function formatDiagnostic(
  displayName: string,
  category: FailureCategory,
  facts?: Readonly<Record<string, string | number>>,
): string {
  const head = `Subagent failure (${[`CLI: ${displayName}`, `category: ${category}`, ...safeFacts(facts)].join('; ')})`
  const hint = CATEGORY_HINTS[category]
  return limitDiagnostic(hint === undefined ? head : `${head}\n${hint}`)
}
