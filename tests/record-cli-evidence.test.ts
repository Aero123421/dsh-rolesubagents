import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- executable .mjs helper has no declaration file.
import { NATIVE_CASE_GROUPS, recordCliEvidence } from '../scripts/record-cli-evidence.mjs'
import {
  CLI_COMPATIBILITY_EVIDENCE,
  resolveCliCompatibility,
  validateCompatibilityEvidence,
  type CompatibilityEvidence,
} from '../src/shared/cli-compatibility.ts'

const options = {
  cli: 'pi',
  expectedVersion: '1.3.0',
  command: 'synthetic converter unit test; not published evidence',
}
function raw(cli = 'pi') {
  const cases = Object.keys(NATIVE_CASE_GROUPS[cli]).map(name => ({ cli, name, status: 'pass', durationMs: 1 }))
  return {
    schemaVersion: 1,
    recordedAt: '2026-10-22T10:00:00.000Z',
    dshVersion: '0.2.1-rc.2',
    platform: 'linux',
    arch: 'x64',
    binaries: { [cli]: { path: '/test/cli', sha256: 'a'.repeat(64), version: '1.3.0', expectedVersion: '1.3.0' } },
    cases,
    totals: { passes: cases.length, failures: 0, skips: 0 },
  }
}
function status(evidence: CompatibilityEvidence) {
  return resolveCliCompatibility(evidence.scope, [evidence]).state
}

describe('native evidence recording', () => {
  it('reproduces each shipped native record from archived real report and verifies its provenance hash', () => {
    const bytes = readFileSync(new URL('../docs/cli-evidence/native-20261022-final.raw.json', import.meta.url))
    const source = JSON.parse(bytes.toString('utf8'))
    for (const evidence of CLI_COMPATIBILITY_EVIDENCE.filter(item => ['grok-build', 'pi'].includes(item.scope.cli))) {
      const reproduced = recordCliEvidence(source, {
        cli: evidence.scope.cli,
        expectedVersion: evidence.scope.cliVersion,
        command: evidence.source.command,
      })
      expect(reproduced).toEqual(evidence)
      expect(validateCompatibilityEvidence(evidence)).toEqual([])
      const provenance = JSON.parse(
        readFileSync(
          new URL(
            `../docs/cli-evidence/${evidence.scope.cli}-${evidence.scope.cliVersion}-native-final.json.provenance.json`,
            import.meta.url,
          ),
          'utf8',
        ),
      )
      expect(provenance.rawReportSha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(provenance.binary).toEqual(source.binaries[evidence.scope.cli])
    }
    expect(CLI_COMPATIBILITY_EVIDENCE.filter(item => ['grok-build', 'pi'].includes(item.scope.cli))).toHaveLength(2)
  })
  it.each(['grok-build', 'pi'])('maps exact reviewed %s cases to all groups, retaining every case', cli => {
    const input = raw(cli)
    const result = recordCliEvidence(input, { ...options, cli }) as CompatibilityEvidence
    expect(validateCompatibilityEvidence(result)).toEqual([])
    expect(status(result)).toBe('tested')
    const recorded = new Set(result.suites.flatMap(suite => suite.cases.map(c => c.id)))
    for (const c of input.cases) expect(recorded.has(c.name)).toBe(true)
    expect(result.suites.filter(suite => suite.status === 'skip')).toHaveLength(0)
    expect(result.scope.preset).toBe('native')
    expect(result.recordedAt).toBe(input.recordedAt)
  })
  it.each(['fail', 'skip'])('retains a %s case without qualifying as tested', state => {
    const input = raw()
    input.cases[0]!.status = state
    input.totals.passes--
    if (state === 'fail') input.totals.failures++
    else input.totals.skips++
    const result = recordCliEvidence(input, options)
    expect(status(result)).toBe('untested')
  })
  it.each(Object.keys(NATIVE_CASE_GROUPS.pi))('does not qualify a missing reviewed case: %s', name => {
    const input = raw()
    input.cases = input.cases.filter(c => c.name !== name)
    input.totals.passes--
    const result = recordCliEvidence(input, options) as CompatibilityEvidence
    expect(status(result)).toBe('untested')
    expect(result.suites.flatMap(s => s.cases).some(c => c.id === name && c.status === 'skip')).toBe(true)
  })
  it('retains unknown passing cases but requires their mapping to be reviewed', () => {
    const input = raw()
    input.cases.push({ cli: 'pi', name: 'new check not yet reviewed', status: 'pass', durationMs: 1 })
    input.totals.passes++
    const result = recordCliEvidence(input, options) as CompatibilityEvidence
    expect(status(result)).toBe('untested')
    expect(result.suites.find(s => s.id === 'unreviewed-cases')?.cases).toContainEqual({
      id: 'new check not yet reviewed',
      status: 'pass',
    })
  })
  it('rejects an unreviewed CLI, even with a fabricated successful report', () => {
    expect(() => recordCliEvidence(raw(), { ...options, cli: 'codex' })).toThrow(/Only reviewed/)
  })
  it('rejects duplicate raw cases and optimistic aggregate totals', () => {
    const input = raw()
    input.cases.push(input.cases[0]!)
    expect(() => recordCliEvidence(input, options)).toThrow(/Duplicate/)
    const optimistic = raw()
    optimistic.totals.failures++
    expect(() => recordCliEvidence(optimistic, options)).toThrow(/totals/)
  })
  it.each(['version', 'expectedVersion'])('requires matching observed and pinned %s', key => {
    const input = raw()
    input.binaries.pi![key as 'version' | 'expectedVersion'] = '1.2.0'
    expect(() => recordCliEvidence(input, options)).toThrow(/versions/)
  })
  it('requires a binary fingerprint, complete exact scope and valid date', () => {
    const input = raw()
    input.binaries.pi!.sha256 = ''
    expect(() => recordCliEvidence(input, options)).toThrow(/SHA256/)
    expect(() => recordCliEvidence({ ...raw(), platform: 'unknown' }, options)).toThrow(/scope/)
    expect(() => recordCliEvidence({ ...raw(), recordedAt: 'tomorrow' }, options)).toThrow(/ISO/)
  })
  it('rejects empty selected suite and malformed individual cases', () => {
    expect(() =>
      recordCliEvidence({ ...raw(), cases: [], totals: { passes: 0, failures: 0, skips: 0 } }, options),
    ).toThrow(/No cases/)
    const input = raw()
    input.cases[0]!.status = 'success'
    expect(() => recordCliEvidence(input, options)).toThrow(/Invalid raw case/)
  })
})
