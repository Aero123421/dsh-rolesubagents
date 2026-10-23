import { describe, expect, it } from 'vitest'
import {
  CLI_COMPATIBILITY_EVIDENCE,
  COMPATIBILITY_SCOPE_FIELDS,
  HISTORICAL_CLI_BASELINES,
  REQUIRED_COMPATIBILITY_SUITES,
  compareCliEvidence,
  hasCompleteCompatibilityScope,
  resolveCliCompatibility,
  validateCompatibilityEvidence,
  type CompatibilityEvidence,
  type CompatibilityScope,
} from '../src/shared/cli-compatibility.ts'

const scope: CompatibilityScope = {
  cli: 'codex',
  cliVersion: '0.163.0',
  dshVersion: '0.2.1-rc.2',
  platform: 'linux',
  arch: 'x64',
  preset: 'workspace-write',
  protocol: 'exec-json',
}
/** Synthetic test data only; never included in the shipped evidence manifest. */
function report(version = scope.cliVersion): CompatibilityEvidence {
  return {
    schemaVersion: 1,
    id: `synthetic-${version}`,
    scope: { ...scope, cliVersion: version },
    recordedAt: '2026-01-01T00:00:00Z',
    source: { kind: 'real-cli-local-fake-model', command: 'synthetic test fixture' },
    suites: REQUIRED_COMPATIBILITY_SUITES.map(id => ({
      id,
      status: 'pass',
      cases: [{ id: `${id}-case`, status: 'pass' }],
    })),
  }
}
const expected = { baselineVersion: '0.163.0', candidateVersion: '0.164.0' }

describe('exact-scope compatibility assessment', () => {
  it('does not manufacture complete historical evidence or dates', () => {
    expect(CLI_COMPATIBILITY_EVIDENCE.map(item => [item.scope.cli, item.scope.cliVersion])).toEqual([
      ['grok-build', '1.0.62'],
      ['pi', '1.3.0'],
    ])
    for (const record of CLI_COMPATIBILITY_EVIDENCE) expect(validateCompatibilityEvidence(record)).toEqual([])
    expect(HISTORICAL_CLI_BASELINES.map(item => [item.cli, item.cliVersion])).toEqual([
      ['codex', '0.163.0'],
      ['claude-code', '2.1.303'],
      ['agy', '1.4.2'],
      ['opencode', '1.19.3'],
    ])
    for (const baseline of HISTORICAL_CLI_BASELINES) {
      expect(baseline.testedAt).toBeNull()
      expect(baseline.dshVersion).toBeNull()
      expect(hasCompleteCompatibilityScope(baseline)).toBe(false)
    }
    expect(resolveCliCompatibility(scope).state).toBe('untested')
  })
  it('version detection alone is unknown, never tested', () => {
    expect(resolveCliCompatibility({ cli: 'codex', cliVersion: '0.163.0' }, [report()]).state).toBe('unknown')
  })
  it.each(COMPATIBILITY_SCOPE_FIELDS)('requires %s, even with a matching version', field => {
    const partial = { ...scope }
    delete (partial as Partial<CompatibilityScope>)[field]
    expect(resolveCliCompatibility(partial, [report()]).state).toBe('unknown')
  })
  it.each(COMPATIBILITY_SCOPE_FIELDS)('does not extrapolate evidence across %s', field => {
    expect(resolveCliCompatibility({ ...scope, [field]: `${scope[field]}-different` }, [report()]).state).toBe(
      'untested',
    )
  })
  it('marks only an exact scope with all required cases passing as tested', () => {
    expect(resolveCliCompatibility(scope, [report()])).toEqual({
      state: 'tested',
      reason: 'all-required-checks-passed',
      evidenceIds: ['synthetic-0.163.0'],
    })
  })
  it('does not mark an ordinary failing run known-incompatible without explicit classification', () => {
    const failure = report()
    failure.suites[0]!.status = 'fail'
    failure.suites[0]!.cases[0]!.status = 'fail'
    expect(resolveCliCompatibility(scope, [failure]).state).toBe('untested')
    failure.incompatibility = { reason: 'Verified regression in the scoped test', suiteIds: ['startup-completion'] }
    expect(resolveCliCompatibility(scope, [failure, report()]).state).toBe('known-incompatible')
    expect(resolveCliCompatibility(scope, [report(), failure]).state).toBe('known-incompatible')
  })
  it('ignores malformed evidence rather than producing green', () => {
    const invalid = report()
    invalid.suites[0]!.cases = []
    expect(resolveCliCompatibility(scope, [invalid]).state).toBe('untested')
  })
})

describe('evidence validation and comparison', () => {
  it('accepts two exact version runs only within otherwise identical scopes', () => {
    expect(compareCliEvidence(report(), report('0.164.0'), expected)).toMatchObject({
      passed: true,
      baseline: { state: 'tested' },
      candidate: { state: 'tested' },
    })
  })
  it.each(COMPATIBILITY_SCOPE_FIELDS.filter(field => field !== 'cliVersion'))(
    'rejects cross-scope comparisons: %s',
    field => {
      const candidate = report('0.164.0')
      candidate.scope[field] += '-different'
      expect(compareCliEvidence(report(), candidate, expected)).toMatchObject({
        passed: false,
        errors: [`scope mismatch: ${field}`],
      })
    },
  )
  it('rejects a different executable version than the expected version', () => {
    const result = compareCliEvidence(report('0.162.0'), report('0.165.0'), expected)
    expect(result.passed).toBe(false)
    expect(result.errors).toContain('baseline: wrong expected CLI version')
    expect(result.errors).toContain('candidate: wrong expected CLI version')
  })
  it.each(['fail', 'skip'] as const)('does not upgrade %s to passing', status => {
    const candidate = report('0.164.0')
    candidate.suites[0]!.status = status
    candidate.suites[0]!.cases[0]!.status = status
    expect(validateCompatibilityEvidence(candidate)).toEqual([])
    expect(compareCliEvidence(report(), candidate, expected).passed).toBe(false)
  })
  it.each(REQUIRED_COMPATIBILITY_SUITES)('requires suite %s on both sides', id => {
    const incomplete = report()
    incomplete.suites = incomplete.suites.filter(item => item.id !== id)
    expect(compareCliEvidence(incomplete, report('0.164.0'), expected).passed).toBe(false)
    incomplete.scope.cliVersion = '0.164.0'
    expect(compareCliEvidence(report(), incomplete, expected).passed).toBe(false)
  })
  it('rejects optimistic summary with a skipped case', () => {
    const candidate = report('0.164.0')
    candidate.suites[0]!.cases.push({ id: 'not-run', status: 'skip' })
    expect(validateCompatibilityEvidence(candidate)).toContain('suite summary disagrees with cases: startup-completion')
    expect(compareCliEvidence(report(), candidate, expected).passed).toBe(false)
  })
  it('does not ignore failed additional checks just because required groups passed', () => {
    const candidate = report('0.164.0')
    candidate.suites.push({ id: 'extra-regression', status: 'fail', cases: [{ id: 'extra-case', status: 'fail' }] })
    expect(resolveCliCompatibility(candidate.scope, [candidate]).state).toBe('untested')
    expect(compareCliEvidence(report(), candidate, expected).passed).toBe(false)
  })
  it('rejects duplicate suites and case ids', () => {
    const duplicate = report()
    duplicate.suites.push(duplicate.suites[0]!)
    duplicate.suites[1]!.cases.push(duplicate.suites[1]!.cases[0]!)
    expect(validateCompatibilityEvidence(duplicate)).toContain('duplicate suite: startup-completion')
    expect(validateCompatibilityEvidence(duplicate)).toContain('duplicate case in cancel: cancel-case')
  })
  it('rejects comparing the same version and evidence as an old/new regression', () => {
    const same = report()
    const comparison = compareCliEvidence(same, same, {
      baselineVersion: same.scope.cliVersion,
      candidateVersion: same.scope.cliVersion,
    })
    expect(comparison.passed).toBe(false)
    expect(comparison.errors).toContain('old/new comparison requires distinct CLI versions')
  })
  it('does not accept a --version observation as real test evidence', () => {
    const observed = { ...report(), source: { kind: 'version-observation', command: 'codex --version' } }
    expect(compareCliEvidence(observed, report('0.164.0'), expected).passed).toBe(false)
  })
  it.each([
    undefined,
    null,
    [],
    {},
    { schemaVersion: 2 },
    { ...report(), recordedAt: 'yesterday' },
    { ...report(), recordedAt: '2026-01-01T00:00:00' },
    { ...report(), scope: { ...scope, preset: '*' } },
  ])('rejects malformed input %#', input => {
    expect(validateCompatibilityEvidence(input).length).toBeGreaterThan(0)
  })
  it('rejects normalized invalid calendar dates and unsafe coercions', () => {
    expect(validateCompatibilityEvidence({ ...report(), recordedAt: '2026-02-30T00:00:00Z' })).toContain(
      'recordedAt must be an ISO date-time with timezone',
    )
    const malformed = { ...report(), incompatibility: { reason: 'bad input', suiteIds: [{ toString: null }] } }
    expect(validateCompatibilityEvidence(malformed)).toContain('incompatibility suiteIds must be nonempty strings')
  })
  it('requires explicit incompatibility to reference a failed required suite', () => {
    const claimed = report()
    claimed.incompatibility = { reason: 'Not demonstrated', suiteIds: ['cancel'] }
    expect(validateCompatibilityEvidence(claimed)).toContain(
      'incompatibility must reference a failed required suite: cancel',
    )
  })
})
