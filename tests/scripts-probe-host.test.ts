import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const checkout = resolve(process.env.DSH_CHECKOUT ?? '/usr/lib/node_modules/@deepseek-ai/dsh')
const available = existsSync(resolve(checkout, 'node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js'))

it('keeps optional wire endpoints behind disposable identity and loopback-only HTTP', () => {
  const source = readFileSync(resolve('scripts/check-probe-host.mjs'), 'utf8')
  const isolation = source.indexOf('const isolated = isolateCheckEnvironment()')
  expect(isolation).toBeGreaterThanOrEqual(0)
  for (const specifier of [
    '@deepseek-ai/cordis',
    '../src/host/management/remote.ts',
    '../src/host/management/settings.ts',
    '../src/client/role-display.ts',
    '../src/client/external-runs.ts',
    '../src/host/external/observability.ts',
  ])
    expect(source.indexOf(`await import('${specifier}')`)).toBeGreaterThan(isolation)
  expect(source).toContain("readFile(new URL('../lib/index.js', import.meta.url), 'utf8')")
  expect(source).toContain('await import(pathToFileURL(fixtureBundle).href)')
  expect(source).toContain("server.listen(0, '127.0.0.1', resolve)")
  expect(source).toContain("'rolesubagentsManagement/writeSafety'")
  expect(source).toMatch(/safetyEndpoint,\s*\{\s*args:\s*\{\s*request\s*\}/)
  expect(source).not.toMatch(/console\.\w+\([^)]*(?:authenticatedUrl|set-cookie|\bcookie\b)/i)
})

// Optional on machines without DSH; never substitutes a direct method call for Gateway/HTTP.
it.skipIf(!available)(
  'runs installed DSH Connection/Gateway/probe and role safety over isolated loopback HTTP',
  () => {
    const result = spawnSync(process.execPath, ['scripts/check-probe-host.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, DSH_CHECKOUT: checkout },
      encoding: 'utf8',
      timeout: 20000,
    })
    expect(result.error).toBeUndefined()
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.stdout).toContain('PASS real client Connection → HTTP → Gateway → decorated probe')
    expect(result.stdout).toContain('PASS real Connection authentication and Host/Origin fence (401/403)')
    expect(result.stdout).toContain('PASS real Gateway validates argument names')
    expect(result.stdout).toMatch(/FIXTURE loopback HTTP: http:\/\/127\.0\.0\.1:\d+/)
    expect(result.stdout).toContain('writeSafety uses args.request and returns canonical revision with AI gate OFF')
    expect(result.stdout).toContain(
      'writeSafety wire refuses stale revision, opaque expressions and caller namespace fields',
    )
    expect(result.stdout).toContain('writeSafety actual HTTP authentication/Origin fence')
    expect(result.stdout).toContain(
      'missing, unavailable and unloaded writeSafety service cannot produce a positive attestation',
    )
    expect(result.stdout).not.toMatch(/[?&](?:auth|token)=|set-cookie:|cookie:/i)
    expect(result.stdout).not.toContain('SYNTHETIC_WIRE_MARKER')
    expect(result.stdout).not.toContain('SYNTHETIC_PRIVATE')
    expect(result.stdout).toContain('role-display actual client caller → HTTP → Gateway → Remote')
    expect(result.stdout).toContain('role-display disposal refuses captured calls')
    expect(result.stdout).toContain('external-runs actual client caller → HTTP → Gateway owner invocation')
    expect(result.stdout).toContain(
      'shipping lib/index.js bundled query/externalRuns preserve literal signal and execute via actual Gateway',
    )
    expect(result.stdout).toContain('PASS missing Gateway and missing Remote both produce ambiguous HTTP 404')
    expect(result.stdout).toContain('isolated HOME/profile, no real CLI/model calls')
  },
  25000,
)
