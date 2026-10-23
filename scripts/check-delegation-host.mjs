#!/usr/bin/env node
/**
 * Native delegation regression smoke through the installed `dsh headless` launcher.
 * DSH_CHECKOUT points at the installed @deepseek-ai/dsh package. All bundles,
 * settings, sessions and logs live in a disposable HOME, also isolated before
 * child SDK imports. No real model API, credentials, server or CLI runner is
 * used. The write check covers native tools.guard dispatch, not OS confinement.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { openSync, closeSync } from 'node:fs'
import { mkdir, readFile, writeFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { isolateCheckEnvironment } from './check-environment.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkout = resolve(process.env.DSH_CHECKOUT || '/usr/lib/node_modules/@deepseek-ai/dsh')
const environment = isolateCheckEnvironment()
try {
  const runtime = createRequire(join(checkout, 'package.json'))
  // The helper owns and identity-checks this newly created absolute directory before cleanup.
  const root = environment.home
  const home = join(root, 'dsh')
  const bootstrap = join(root, 'bootstrap.mjs')
  await writeFile(
    bootstrap,
    `
  import { isolateCheckEnvironment } from ${JSON.stringify(pathToFileURL(join(repo, 'scripts/check-environment.mjs')).href)};
  isolateCheckEnvironment();
  // Persist only fixture-owned DSH data across these otherwise separate process identities.
  process.env.DSH_HOME = ${JSON.stringify(home)};
  process.env.DSH_TELEMETRY_DISABLED = '1';
  process.env.DSH_TOOLS_MODE = 'native';
`,
  )

  const workspace = join(root, 'workspace')
  await mkdir(workspace, { recursive: true })
  const recordPath = join(root, 'requests.jsonl')
  const deniedPath = join(workspace, 'reviewer-must-not-write.txt')
  await writeFile(recordPath, '')
  const bundleOptions = {
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    plugins: [
      {
        name: 'installed-dsh-peers',
        setup(builder) {
          builder.onResolve({ filter: /^@deepseek-ai\// }, args => ({
            path: runtime.resolve(args.path),
            external: true,
          }))
        },
      },
    ],
  }
  await build({
    ...bundleOptions,
    entryPoints: [join(repo, 'src/host/index.ts')],
    outfile: join(root, 'roles-plugin.mjs'),
  })
  await build({
    ...bundleOptions,
    entryPoints: [join(repo, 'scripts/fixtures/delegation-host.mjs')],
    outfile: join(root, 'fixture.mjs'),
  })

  const roles = ['general', 'reviewer', 'fork', 'task-fork', 'model-default'].map(id => ({
    id,
    enabled: true,
    description: `Native ${id} integration probe.`,
    instructions: `ROLE_E2E:${id}`,
    context: id === 'fork' || id === 'task-fork' ? 'fork' : 'spawn',
    readOnly: id === 'reviewer' || id === 'task-fork',
    ...(id === 'general' || id === 'fork' ? { builtin: id } : {}),
    ...(id === 'fork' ? { forkScope: 'full' } : id === 'task-fork' ? { forkScope: 'task' } : {}),
    ...(id === 'model-default' ? { model: { provider: 'roles-e2e', model: 'fixture-model' } } : {}),
  }))
  const patch = [
    ...[
      'plugin-manager',
      'plugin-package-inventory-deepseek',
      'session-telemetry-otel',
      'llm-deepseek',
      'llm-deepseek-account',
      'llm-pi-ai',
      'session-title-llm',
      'session-log-deepseek',
      'tool-web',
      'web-search-deepseek',
      'web-deepseek-api',
    ].map(id => ({ id, disabled: true })),
    { id: 'agent-default-model', config: { provider: 'roles-e2e', model: 'fixture-model' } },
    { id: 'tools', config: { mode: 'native' } },
    { id: 'session-persistence-jsonl', config: { root: join(home, 'sessions'), compression: 'none' } },
    { id: 'subagent', config: { maxDepth: 2 } },
    {
      insert: [
        { id: 'role-smoke-fixture', name: join(root, 'fixture.mjs'), config: { recordPath, deniedPath } },
        { id: 'rolesubagents', name: join(root, 'roles-plugin.mjs'), config: { roles } },
      ],
    },
  ]
  const patchPath = join(root, 'probe.patch.yml')
  await writeFile(patchPath, JSON.stringify(patch))
  const env = {
    ...process.env,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_TOOLS_MODE: 'native',
    LANG: 'C.UTF-8',
    TMPDIR: root,
  }

  async function run(label, task, expectedFinal, sessionId) {
    const args = [
      '--import',
      bootstrap,
      join(checkout, 'lib/bin.js'),
      'headless',
      '--patch',
      patchPath,
      '--json',
      ...(sessionId === undefined ? [] : ['--session-id', sessionId]),
      task,
    ]
    const stdoutPath = join(root, `${label}.stdout.jsonl`)
    const stderrPath = join(root, `${label}.stderr.txt`)
    const stdoutFd = openSync(stdoutPath, 'w')
    const stderrFd = openSync(stderrPath, 'w')
    const child = spawn(process.execPath, args, { cwd: workspace, env, stdio: ['ignore', stdoutFd, stderrFd] })
    const timer = setTimeout(() => child.kill('SIGTERM'), 45000)
    let code
    try {
      code = await new Promise((resolveExit, reject) => {
        child.on('error', reject)
        child.on('close', resolveExit)
      })
    } finally {
      clearTimeout(timer)
      closeSync(stdoutFd)
      closeSync(stderrFd)
    }
    const stdout = await readFile(stdoutPath, 'utf8')
    const stderr = await readFile(stderrPath, 'utf8')
    assert.equal(code, 0, `${label}: dsh failed\n${stderr}\n${stdout.slice(-6000)}`)
    const events = stdout
      .split('\n')
      .filter(line => line.startsWith('{'))
      .map(line => JSON.parse(line))
    const session = events.find(event => event.type === 'session')?.sessionId
    assert(session, `${label}: missing native headless session event`)
    const trace = (await readFile(recordPath, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line))
    assert.deepEqual(
      trace.filter(entry => entry.kind === 'agent-error'),
      [],
      `${label}: native child failure`,
    )
    assert.equal(
      events.findLast(event => event.type === 'final')?.text,
      expectedFinal,
      `${label}: parent did not finish the expected work`,
    )
    console.log(`PASS ${label}: ${session}`)
    return { session, events }
  }

  console.log(`Installed DSH: ${JSON.parse(await readFile(join(checkout, 'package.json'), 'utf8')).version}`)
  console.log(`Isolated evidence: ${root}`)
  const seed = await run('seed', 'PARENT_COMPLETED_CONTEXT_94', 'Completed parent context recorded.')
  await run(
    'delegate',
    'PARENT_CURRENT_CONTEXT_57: run the delegation integration probes.',
    'ROLE_E2E_NATIVE_OK',
    seed.session,
  )
  // A cold child must restore its assigned role even after the live defaults
  // change. Its original instructions, read-only policy, and inherited high
  // effort must survive the process boundary and real storage reopen.
  const coldPatch = patch.map(row =>
    row.insert === undefined
      ? row
      : {
          insert: row.insert.map(plugin =>
            plugin.id === 'rolesubagents'
              ? {
                  ...plugin,
                  config: {
                    roles: roles.map(role =>
                      role.id === 'reviewer'
                        ? {
                            ...role,
                            instructions: 'ROLE_E2E_CHANGED:reviewer',
                            readOnly: false,
                            model: { provider: 'roles-e2e', model: 'fixture-model' },
                          }
                        : role,
                    ),
                  },
                }
              : plugin,
          ),
        },
  )
  await writeFile(patchPath, JSON.stringify(coldPatch))
  await run('cold-followup', 'ROLE_E2E_COLD_FOLLOWUP', 'ROLE_E2E_COLD_OK', seed.session)

  const trace = (await readFile(recordPath, 'utf8'))
    .trim()
    .split('\n')
    .map(line => JSON.parse(line))
  const requests = trace.filter(entry => entry.kind === 'request')
  const parent = requests.find(entry => entry.sessionId === seed.session)
  assert(parent)
  for (const role of roles) {
    const request = requests.find(entry => entry.role === role.id)
    assert(request, `${role.id}: no native child request`)
    assert.equal(request.hasCompletedParent, role.id === 'fork', `${role.id}: incorrect completed-history inheritance`)
    assert.equal(request.hasCurrentParent, false, `${role.id}: current parent turn leaked into the child`)
    assert.equal(request.systemHash, parent.systemHash, `${role.id}: system prompt changed`)
    assert.equal(request.toolsHash, parent.toolsHash, `${role.id}: tool prefix changed`)
    assert.match(request.roleContext, new RegExp(`ROLE_E2E:${role.id}`))
    console.log(`PASS ${role.id}: native context, instructions, model effort, and identical prompt/tool prefix`)
  }
  assert(trace.some(entry => entry.kind === 'write-refused'))
  await assert.rejects(access(deniedPath), { code: 'ENOENT' })
  assert(trace.some(entry => entry.kind === 'repin'))
  assert(trace.some(entry => entry.kind === 'compacted' && entry.shadowed > 0))
  assert(requests.some(entry => entry.role === 'reviewer' && entry.hasCompaction))
  for (const phase of ['WARM', 'COLD']) {
    const request = requests.find(entry => entry.role === 'reviewer' && entry.phase === phase)
    assert(request?.hasCompaction, `${phase}: the continued reviewer must retain its compacted history`)
    assert.match(request.roleContext, /ROLE_E2E:reviewer/, `${phase}: original assigned role must survive`)
    assert(
      trace.some(entry => entry.kind === 'write-refused' && entry.phase === phase),
      `${phase}: restored tool guard must refuse writes`,
    )
  }
  const reviewerIds = new Set(requests.filter(entry => entry.role === 'reviewer').map(entry => entry.sessionId))
  assert.equal(reviewerIds.size, 1, 'warm and cold follow-up must continue the same child')
  const reviewerInstances = new Set(requests.filter(entry => entry.role === 'reviewer').map(entry => entry.instance))
  assert.equal(reviewerInstances.size, 2, 'the cold follow-up must run in a different DSH process')
  console.log(
    'PASS native read-only refusal and re-pin, compaction, same-child follow-up, and saved role across changed settings',
  )
} finally {
  environment.dispose()
}
