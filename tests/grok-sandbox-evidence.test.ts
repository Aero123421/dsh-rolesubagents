import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { CLI_COMPATIBILITY_EVIDENCE } from '../src/shared/cli-compatibility.ts'

// Checks the published experiment's consistency, not a new execution of the CLI or OS sandbox.
const report = JSON.parse(
  readFileSync(new URL('../docs/cli-evidence/grok-sandbox-20261023.raw.json', import.meta.url), 'utf8'),
) as {
  binary: { version: string; sha256: string }
  dshVersion: null
  limitation: string
  qualification: { readOnly: boolean; workspaceWrite: boolean }
  cases: {
    id: string
    argv: string[]
    code: number
    requestCount: number
    targetContents: string | null
    toolResults: unknown[]
    stderr: string
  }[]
}

it('does not certify failed startup or management-profile override as restricted support', () => {
  expect(report.binary.version).toBe('grok 1.0.62 (1474f9cbdd91)')
  expect(report.binary.sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(report.dshVersion).toBeNull()
  expect(report.limitation).toContain('not DSH integration')
  expect(report.qualification.readOnly).toBe(false)
  expect(report.qualification.workspaceWrite).toBe(false)
  for (const evidence of CLI_COMPATIBILITY_EVIDENCE.filter(item => item.scope.cli === 'grok-build')) {
    expect(evidence.scope.preset).toBe('native')
  }
  const readControl = report.cases.find(item => item.id === 'native-read-control')!
  expect(readControl.code).toBe(0)
  expect(readControl.toolResults.length).toBeGreaterThan(0)
  expect(readControl.requestCount).toBeGreaterThan(0)
  const readOnly = report.cases.find(item => item.id === 'read-only-read')!
  expect(readOnly.code).not.toBe(0)
  expect(readOnly.requestCount).toBe(0)
  expect(readOnly.stderr).toContain('bwrap: setting up uid map: Permission denied')
  const overrides = report.cases.filter(item => /requirements-(off|devbox)$/.test(item.id))
  expect(overrides).toHaveLength(2)
  for (const item of overrides) {
    expect(item.argv).toContain('--sandbox')
    expect(item.argv[item.argv.indexOf('--sandbox') + 1]).toBe('read-only')
    expect(item.argv).not.toContain('--always-approve')
    expect(item.code).toBe(0)
    expect(item.requestCount).toBeGreaterThan(0)
    expect(item.toolResults.length).toBeGreaterThan(0)
    expect(item.targetContents).toBe('SANDBOX_WRITE_MARKER\n')
  }
})
