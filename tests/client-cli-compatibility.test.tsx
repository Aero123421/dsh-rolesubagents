// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { CliCompatibility } from '../src/client/CliCompatibility.tsx'
import { REQUIRED_COMPATIBILITY_SUITES, type CompatibilityEvidence } from '../src/shared/cli-compatibility.ts'
import { cleanup, render, screen } from './client-dom.ts'

afterEach(cleanup)
it('shows a detected historical version as unknown scope rather than verified', () => {
  render(<CliCompatibility scope={{ cli: 'codex', cliVersion: '0.163.0' }} />)
  expect(screen.getByRole('status').textContent).toBe('Verification scope unknown')
  expect(screen.getByText(/test date and full scope are not recorded/)).toBeTruthy()
})
it('shows a current version observation in Japanese without claiming it passed', () => {
  render(<CliCompatibility scope={{ cli: 'claude-code', cliVersion: '2.1.306' }} locale="ja-JP" />)
  expect(screen.getByRole('status').textContent).toBe('検証条件が不明')
  expect(screen.getByText('2.1.306')).toBeTruthy()
  expect(screen.getByText(/2.1.303/)).toBeTruthy()
})
it('qualifies a passing result with all seven exact scope fields', () => {
  const evidence: CompatibilityEvidence = {
    schemaVersion: 1,
    id: 'synthetic-test-only',
    recordedAt: '2026-01-01T00:00:00Z',
    scope: {
      cli: 'codex',
      cliVersion: '0.163.0',
      dshVersion: '0.2.1-rc.2',
      platform: 'linux',
      arch: 'x64',
      preset: 'read-only',
      protocol: 'exec-json',
    },
    source: { kind: 'real-cli-local-fake-model', command: 'synthetic test fixture' },
    suites: REQUIRED_COMPATIBILITY_SUITES.map(id => ({ id, status: 'pass', cases: [{ id, status: 'pass' }] })),
  }
  render(<CliCompatibility scope={evidence.scope} evidence={[evidence]} />)
  expect(screen.getByRole('status').textContent).toBe('Tested for this exact scope')
  for (const value of Object.values(evidence.scope)) expect(screen.getByText(value)).toBeTruthy()
  expect(screen.getByText(/Evidence IDs: synthetic-test-only/)).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  cleanup()
  render(<CliCompatibility scope={{ cli: 'codex', cliVersion: '0.163.0' }} evidence={[evidence]} />)
  expect(screen.getByRole('status').textContent).toBe('Verification scope unknown')
  expect(screen.getByText('Recorded runs for this CLI version')).toBeTruthy()
  expect(screen.getByText(/not a verified match to this host/)).toBeTruthy()
  expect(screen.getByText('synthetic-test-only')).toBeTruthy()
})
