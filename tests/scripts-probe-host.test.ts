import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const checkout = resolve(process.env.DSH_CHECKOUT ?? '/usr/lib/node_modules/@deepseek-ai/dsh')
const available = existsSync(resolve(checkout, 'node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js'))

// Optional on machines without DSH; never substitutes a direct method call for Gateway/HTTP.
it.skipIf(!available)(
  'runs installed DSH Connection/Gateway/probe over isolated loopback HTTP',
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
    expect(result.stdout).toContain('PASS missing Gateway and missing Remote both produce ambiguous HTTP 404')
    expect(result.stdout).toContain('isolated HOME/profile, no real CLI/model calls')
  },
  25000,
)
