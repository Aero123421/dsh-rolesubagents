/** Reviewed native-case mappings. This records checks, not a blanket CLI safety certification. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { REQUIRED_COMPATIBILITY_SUITES, validateCompatibilityEvidence } from '../src/shared/cli-compatibility.ts'

export const NATIVE_CASE_GROUPS = {
  'grok-build': {
    'native Grok returns final text and uses configured local model and role instructions': [
      'startup-completion',
      'configuration-auth',
    ],
    'native Grok tool loop keeps only final response': ['protocol'],
    'native Grok max token limit is not success': ['protocol'],
    'native Grok parallel runs settle independently': ['protocol'],
    'native Grok provider errors cannot be mistaken for success': ['configuration-auth'],
    'native Grok wall-clock timeout terminates streaming process and owned descendants': ['timeout'],
    'native Grok real stream tolerates synthetic unknown and malformed line injection': ['protocol'],
    'native Grok missing key is diagnosed before inference': ['configuration-auth'],
    'restricted parent refuses native Grok before backend startup': ['permission-boundary'],
    'native Grok cancellation stops streaming and owned descendants': ['cancel'],
  },
  pi: {
    'native Pi returns final text and preserves instructions and configured provider': [
      'startup-completion',
      'configuration-auth',
    ],
    'native Pi retains extensions and handles prompt disposition handled': ['protocol', 'configuration-auth'],
    'native Pi tool loop keeps only final answer': ['protocol'],
    'native Pi max token limit is not success': ['protocol'],
    'native Pi extension dialogs are denied without approving': ['permission-boundary', 'protocol'],
    'native Pi parallel runs settle independently': ['protocol'],
    'native Pi reports provider errors without leaking raw output': ['configuration-auth'],
    'native Pi wall-clock timeout terminates streaming process and owned descendants': ['timeout'],
    'native Pi real stream tolerates synthetic unknown and malformed line injection': ['protocol'],
    'native Pi missing key is diagnosed before inference': ['configuration-auth'],
    'restricted parent refuses native Pi before extension startup': ['permission-boundary'],
    'native Pi cancellation stops streaming and owned descendants': ['cancel'],
  },
}
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0
const statuses = ['pass', 'fail', 'skip']
const summarize = cases =>
  cases.some(c => c.status === 'fail')
    ? 'fail'
    : cases.length === 0 || cases.some(c => c.status === 'skip')
      ? 'skip'
      : 'pass'

/** Pure conversion; unknown/missing cases preserve incomplete status, never optimistic green. */
export function recordCliEvidence(raw, { cli, expectedVersion, command }) {
  if (!Object.hasOwn(NATIVE_CASE_GROUPS, cli)) throw new Error('Only reviewed native Grok/Pi mappings are supported')
  if (
    !record(raw) ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.cases) ||
    !record(raw.binaries) ||
    !record(raw.totals)
  )
    throw new Error('Invalid raw report envelope')
  const binary = raw.binaries[cli]
  if (
    !record(binary) ||
    !text(expectedVersion) ||
    binary.version !== expectedVersion ||
    binary.expectedVersion !== expectedVersion
  )
    throw new Error('Exact observed and pinned versions must match expectedVersion')
  if (!text(binary.path) || !/^[0-9a-f]{64}$/.test(binary.sha256 ?? ''))
    throw new Error('Executable path and SHA256 are required')
  const seen = new Set()
  const counts = { passes: 0, failures: 0, skips: 0 }
  for (const item of raw.cases) {
    if (
      !record(item) ||
      !text(item.cli) ||
      !text(item.name) ||
      !statuses.includes(item.status) ||
      !Number.isFinite(item.durationMs) ||
      item.durationMs < 0
    )
      throw new Error('Invalid raw case')
    const key = JSON.stringify([item.cli, item.name])
    if (seen.has(key)) throw new Error('Duplicate raw case')
    seen.add(key)
    counts[{ pass: 'passes', fail: 'failures', skip: 'skips' }[item.status]]++
  }
  if (Object.keys(counts).some(key => counts[key] !== raw.totals[key]))
    throw new Error('Raw totals disagree with recorded cases; do not discard harness failures')
  const selected = raw.cases.filter(item => item.cli === cli)
  if (!selected.length) throw new Error('No cases for selected CLI')
  const mapping = NATIVE_CASE_GROUPS[cli]
  const groups = Object.fromEntries(REQUIRED_COMPATIBILITY_SUITES.map(id => [id, []]))
  for (const [name, suites] of Object.entries(mapping)) {
    const actual = selected.find(item => item.name === name)
    for (const suite of suites) groups[suite].push({ id: name, status: actual?.status ?? 'skip' })
  }
  const unknown = selected.filter(item => !Object.hasOwn(mapping, item.name))
  if (unknown.length)
    groups['unreviewed-cases'] = [
      ...unknown.map(item => ({ id: item.name, status: item.status })),
      { id: 'case mapping has not been reviewed', status: 'skip' },
    ]
  const evidence = {
    schemaVersion: 1,
    id: `${cli}-${expectedVersion}-${binary.sha256.slice(0, 12)}-${raw.recordedAt}`,
    scope: {
      cli,
      cliVersion: expectedVersion,
      dshVersion: raw.dshVersion,
      platform: raw.platform,
      arch: raw.arch,
      preset: 'native',
      protocol: cli === 'pi' ? 'rpc' : 'streaming-json',
    },
    recordedAt: raw.recordedAt,
    source: { kind: 'real-cli-local-fake-model', command },
    suites: Object.entries(groups).map(([id, cases]) => ({ id, status: summarize(cases), cases })),
  }
  const problems = validateCompatibilityEvidence(evidence)
  if (problems.length) throw new Error(problems.join('; '))
  return evidence
}

/** CLI emits new evidence and provenance files exclusively; never overwrites a previous run. */
function main(args) {
  if (args.length !== 5)
    throw new Error(
      'Usage: node scripts/record-cli-evidence.mjs RAW_REPORT CLI EXPECTED_VERSION OUTPUT_JSON EXACT_RUN_COMMAND',
    )
  const [rawPath, cli, expectedVersion, output, command] = args
  const bytes = readFileSync(rawPath)
  const raw = JSON.parse(bytes.toString('utf8'))
  const evidence = recordCliEvidence(raw, { cli, expectedVersion, command })
  const provenance = {
    evidenceId: evidence.id,
    rawReport: rawPath,
    rawReportSha256: createHash('sha256').update(bytes).digest('hex'),
    binary: raw.binaries[cli],
    mappingSource: 'scripts/record-cli-evidence.mjs',
    limitations: [
      'Native preset requires full-access parent; permission-boundary checks refusal under a restricted parent, not OS confinement.',
      'Only these scripted localhost cases are covered, not arbitrary native extensions, every protocol variant, live authentication, or paid providers.',
      'Binary hash identifies the executable entry file; dynamically loaded dependencies and user extensions are not fingerprinted.',
    ],
  }
  writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n', { flag: 'wx' })
  writeFileSync(`${output}.provenance.json`, JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' })
  console.log(`Recorded ${evidence.id}`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
