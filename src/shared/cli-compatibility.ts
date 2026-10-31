import grokNativeEvidence from '../../docs/cli-evidence/grok-build-1.0.62-native-final.json' with { type: 'json' }
import piNativeEvidence from '../../docs/cli-evidence/pi-1.3.0-native-final.json' with { type: 'json' }

/** Exact evidence scopes, not a semver support range or a permission grant. */
export interface CompatibilityScope {
  cli: string
  cliVersion: string
  dshVersion: string
  platform: string
  arch: string
  preset: string
  protocol: string
}

export const COMPATIBILITY_SCOPE_FIELDS = [
  'cli',
  'cliVersion',
  'dshVersion',
  'platform',
  'arch',
  'preset',
  'protocol',
] as const
export const REQUIRED_COMPATIBILITY_SUITES = [
  'startup-completion',
  'cancel',
  'timeout',
  'protocol',
  'permission-boundary',
  'configuration-auth',
] as const
export type EvidenceStatus = 'pass' | 'fail' | 'skip'
export interface CompatibilityEvidence {
  schemaVersion: 1
  id: string
  scope: CompatibilityScope
  recordedAt: string
  source: { kind: 'real-cli-local-fake-model'; command: string }
  suites: { id: string; status: EvidenceStatus; cases: { id: string; status: EvidenceStatus }[] }[]
  /** Explicit maintainer classification: an ordinary failed run alone is not proof of incompatibility. */
  incompatibility?: { reason: string; suiteIds: string[] }
}
export type CompatibilityState = 'tested' | 'untested' | 'unknown' | 'known-incompatible'
export interface CompatibilityAssessment {
  state: CompatibilityState
  reason:
    | 'missing-scope'
    | 'no-exact-evidence'
    | 'incomplete-evidence'
    | 'all-required-checks-passed'
    | 'explicit-incompatibility'
  evidenceIds: string[]
}

/** Historical documentation is intentionally NOT machine-verifiable, complete-scope evidence. */
export const HISTORICAL_CLI_BASELINES = [
  { cli: 'codex', cliVersion: '0.163.0', protocol: 'exec --json' },
  { cli: 'claude-code', cliVersion: '2.1.303', protocol: 'stream-json' },
  { cli: 'agy', cliVersion: '1.4.2', protocol: 'stream-json' },
  { cli: 'opencode', cliVersion: '1.19.3', protocol: 'ACP' },
].map(entry => ({
  ...entry,
  source: 'README.md / CHANGELOG.md v0.2.0 / docs/external-cli.md at 28d1f62818c42a9c6cb64af361c93157e2926827',
  testedAt: null,
  dshVersion: null,
  platform: null,
  arch: null,
  preset: null,
  limitation:
    'Historical real-CLI testing is documented, but no complete dated per-scope suite report is recorded here. Not evidence for a tested badge.',
}))

/** Reviewed real-binary localhost runs. Native permission checks are refusals, not OS containment. */
export const CLI_COMPATIBILITY_EVIDENCE: readonly CompatibilityEvidence[] = [
  grokNativeEvidence as CompatibilityEvidence,
  piNativeEvidence as CompatibilityEvidence,
]

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function text(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    value.trim() === value &&
    !/[\u0000-\u001f]/.test(value)
  )
}
function status(value: unknown): value is EvidenceStatus {
  return value === 'pass' || value === 'fail' || value === 'skip'
}
export function hasCompleteCompatibilityScope(value: unknown): value is CompatibilityScope {
  return (
    record(value) &&
    COMPATIBILITY_SCOPE_FIELDS.every(field => text(value[field]) && value[field] !== 'unknown' && value[field] !== '*')
  )
}
function timestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return false
  const date = value.slice(0, 10)
  const midnight = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(midnight) && new Date(midnight).toISOString().slice(0, 10) === date
}
function summary(cases: { status: EvidenceStatus }[]): EvidenceStatus {
  return cases.some(item => item.status === 'fail')
    ? 'fail'
    : cases.length === 0 || cases.some(item => item.status === 'skip')
      ? 'skip'
      : 'pass'
}

/** Validate untrusted persisted JSON; invalid reports cannot create a green badge. */
export function validateCompatibilityEvidence(value: unknown): string[] {
  const errors: string[] = []
  if (!record(value)) return ['evidence must be an object']
  if (value.schemaVersion !== 1) errors.push('schemaVersion must be 1')
  if (!text(value.id)) errors.push('id must be a nonempty string')
  if (!hasCompleteCompatibilityScope(value.scope))
    errors.push('scope must contain all seven exact fields (no unknown or wildcard)')
  if (!timestamp(value.recordedAt)) errors.push('recordedAt must be an ISO date-time with timezone')
  if (!record(value.source) || value.source.kind !== 'real-cli-local-fake-model' || !text(value.source.command))
    errors.push('source must identify real-cli-local-fake-model and its command')
  const suites = value.suites
  const suiteIds = new Set<string>()
  if (!Array.isArray(suites)) errors.push('suites must be an array')
  else
    for (const suite of suites) {
      if (!record(suite) || !text(suite.id) || !status(suite.status) || !Array.isArray(suite.cases)) {
        errors.push('invalid suite')
        continue
      }
      if (suiteIds.has(suite.id)) errors.push(`duplicate suite: ${suite.id}`)
      suiteIds.add(suite.id)
      const caseIds = new Set<string>()
      let valid = true
      for (const item of suite.cases) {
        if (!record(item) || !text(item.id) || !status(item.status)) {
          errors.push(`invalid case in ${suite.id}`)
          valid = false
          continue
        }
        if (caseIds.has(item.id)) errors.push(`duplicate case in ${suite.id}: ${item.id}`)
        caseIds.add(item.id)
      }
      if (valid && suite.status !== summary(suite.cases as { status: EvidenceStatus }[]))
        errors.push(`suite summary disagrees with cases: ${suite.id}`)
    }
  if (value.incompatibility !== undefined) {
    const issue = value.incompatibility
    if (
      !record(issue) ||
      !text(issue.reason) ||
      !Array.isArray(issue.suiteIds) ||
      issue.suiteIds.length === 0 ||
      new Set(issue.suiteIds).size !== issue.suiteIds.length
    )
      errors.push('incompatibility needs a reason and unique failed required suiteIds')
    else
      for (const id of issue.suiteIds) {
        if (!text(id)) {
          errors.push('incompatibility suiteIds must be nonempty strings')
          continue
        }
        if (
          !REQUIRED_COMPATIBILITY_SUITES.some(required => required === id) ||
          !Array.isArray(suites) ||
          !suites.some(suite => record(suite) && suite.id === id && suite.status === 'fail')
        )
          errors.push(`incompatibility must reference a failed required suite: ${String(id)}`)
      }
  }
  return errors
}

export function requiredSuiteFailures(evidence: CompatibilityEvidence): string[] {
  // Optional extra checks cannot be silently discarded if they failed or were skipped.
  return [...new Set<string>([...REQUIRED_COMPATIBILITY_SUITES, ...evidence.suites.map(suite => suite.id)])].filter(
    id => {
      const suite = evidence.suites.find(item => item.id === id)
      return (
        suite === undefined ||
        suite.status !== 'pass' ||
        suite.cases.length === 0 ||
        suite.cases.some(item => item.status !== 'pass')
      )
    },
  )
}

/** Match every field exactly. Known incompatibility wins conservatively, independent of list ordering. */
export function resolveCliCompatibility(
  scope?: Partial<CompatibilityScope>,
  evidence: readonly CompatibilityEvidence[] = CLI_COMPATIBILITY_EVIDENCE,
): CompatibilityAssessment {
  if (!hasCompleteCompatibilityScope(scope)) return { state: 'unknown', reason: 'missing-scope', evidenceIds: [] }
  const matches = evidence.filter(
    item =>
      validateCompatibilityEvidence(item).length === 0 &&
      COMPATIBILITY_SCOPE_FIELDS.every(field => item.scope[field] === scope[field]),
  )
  const incompatible = matches.filter(item => item.incompatibility !== undefined)
  if (incompatible.length)
    return {
      state: 'known-incompatible',
      reason: 'explicit-incompatibility',
      evidenceIds: incompatible.map(item => item.id),
    }
  const passed = matches.filter(item => requiredSuiteFailures(item).length === 0)
  if (passed.length)
    return { state: 'tested', reason: 'all-required-checks-passed', evidenceIds: passed.map(item => item.id) }
  return {
    state: 'untested',
    reason: matches.length ? 'incomplete-evidence' : 'no-exact-evidence',
    evidenceIds: matches.map(item => item.id),
  }
}

export interface EvidenceComparison {
  passed: boolean
  errors: string[]
  baseline?: CompatibilityAssessment
  candidate?: CompatibilityAssessment
}

/** Compare two version runs without upgrading missing, skipped or failed checks to success. */
export function compareCliEvidence(
  baseline: unknown,
  candidate: unknown,
  expected: { baselineVersion: string; candidateVersion: string },
): EvidenceComparison {
  const errors = [
    ...validateCompatibilityEvidence(baseline).map(error => `baseline: ${error}`),
    ...validateCompatibilityEvidence(candidate).map(error => `candidate: ${error}`),
  ]
  if (!text(expected.baselineVersion) || !text(expected.candidateVersion))
    errors.push('both expected exact CLI versions are required')
  if (errors.length) return { passed: false, errors }
  const oldRun = baseline as CompatibilityEvidence
  const newRun = candidate as CompatibilityEvidence
  if (oldRun.scope.cliVersion !== expected.baselineVersion) errors.push('baseline: wrong expected CLI version')
  if (newRun.scope.cliVersion !== expected.candidateVersion) errors.push('candidate: wrong expected CLI version')
  if (oldRun.scope.cliVersion === newRun.scope.cliVersion)
    errors.push('old/new comparison requires distinct CLI versions')
  for (const field of COMPATIBILITY_SCOPE_FIELDS) {
    if (field !== 'cliVersion' && oldRun.scope[field] !== newRun.scope[field]) errors.push(`scope mismatch: ${field}`)
  }
  for (const [label, run] of [
    ['baseline', oldRun],
    ['candidate', newRun],
  ] as const) {
    for (const id of requiredSuiteFailures(run)) errors.push(`${label}: required suite not passing: ${id}`)
    if (run.incompatibility) errors.push(`${label}: explicitly known-incompatible`)
  }
  return {
    passed: errors.length === 0,
    errors,
    baseline: resolveCliCompatibility(oldRun.scope, [oldRun]),
    candidate: resolveCliCompatibility(newRun.scope, [newRun]),
  }
}
