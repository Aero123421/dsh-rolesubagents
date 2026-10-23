import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const checkout = process.env.DSH_CHECKOUT ?? '/usr/lib/node_modules/@deepseek-ai/dsh'

it.skipIf(!existsSync(join(checkout, 'package.json')))(
  'rejects an unexecuted requested CLI even when another selected suite passes',
  () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'rolesubagents-check-controls-')))
    try {
      // Version-only fixture: no CLI is launched for inference in this control test.
      const executable = join(root, 'grok-version-only')
      writeFileSync(executable, '#!/usr/bin/env node\nconsole.log("grok 1.0.62")\n', { mode: 0o700 })
      const result = spawnSync(process.execPath, ['scripts/check-cli.mjs', 'self', 'grok-build'], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          DSH_CHECKOUT: checkout,
          CHECK_CLI_CASE: 'mounted as a Remote service',
          CHECK_CLI_REPORT: '',
          CHECK_CLI_EXECUTABLE_GROK_BUILD: executable,
          CHECK_CLI_VERSION_GROK_BUILD: '1.0.62',
        },
      })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('PASS self: the CLI connection test is mounted as a Remote service')
      expect(result.stdout).toContain('FAIL grok-build: no cases selected')
    } finally {
      expect(realpathSync(root), 'fixture identity must match before cleanup').toBe(root)
      rmSync(root, { recursive: true, force: true })
    }
  },
  35_000,
)
