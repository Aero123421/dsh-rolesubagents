#!/usr/bin/env node
/** Compare two scoped real-CLI evidence reports. Node >=22.19 strips the imported TypeScript types. */
import { readFile } from 'node:fs/promises'
import { compareCliEvidence } from '../src/shared/cli-compatibility.ts'

const usage =
  'Usage: node scripts/compare-cli-evidence.mjs BASELINE.json CANDIDATE.json --baseline-version EXACT --candidate-version EXACT'
const args = process.argv.slice(2)
try {
  if (args.length !== 6 || args[2] !== '--baseline-version' || args[4] !== '--candidate-version') throw new Error(usage)
  const [baseline, candidate] = await Promise.all(
    args.slice(0, 2).map(async path => {
      const raw = await readFile(path, 'utf8')
      if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('evidence report exceeds 4 MiB')
      return JSON.parse(raw)
    }),
  )
  const result = compareCliEvidence(baseline, candidate, { baselineVersion: args[3], candidateVersion: args[5] })
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.passed ? 0 : 1
} catch (error) {
  console.error(JSON.stringify({ passed: false, errors: [error instanceof Error ? error.message : String(error)] }))
  process.exitCode = 2
}
