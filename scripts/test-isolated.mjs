/** Keep all unit-test plugin startup/housekeeping away from the operator's HOME and credentials. */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { isolateCheckEnvironment } from './check-environment.mjs'

const require = createRequire(import.meta.url)
const cli = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const environment = isolateCheckEnvironment()
try {
  const result = spawnSync(process.execPath, [cli, 'run', ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  environment.dispose()
}
