/** Harmless functional check of installed DSH confinement, not a new sandbox implementation. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  existsSync,
  rmSync,
  readFileSync,
  mkdirSync,
  linkSync,
} from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isolateCheckEnvironment } from './check-environment.mjs'
import { hostResolveHook } from './host-resolve-hook.mjs'

const checkout = resolve(process.env.DSH_CHECKOUT ?? '/usr/lib/node_modules/@deepseek-ai/dsh')
const check = isolateCheckEnvironment()
const hook = registerHooks(hostResolveHook(createRequire(join(checkout, 'package.json'))))
const { Context } = await import('@deepseek-ai/cordis')
const { default: LocalSandbox } = await import('@deepseek-ai/dsh-sandbox-local')
const ctx = new Context()
mkdirSync(join(process.cwd(), 'artifacts'), { recursive: true })
const root = realpathSync(mkdtempSync(join(process.cwd(), 'artifacts/host-sandbox-')))
const workspace = join(root, 'workspace')
mkdirSync(workspace)
const inside = join(workspace, 'inside.txt')
const outside = join(root, 'outside.txt')
writeFileSync(outside, 'unchanged')
try {
  await ctx.plugin(LocalSandbox)
  const source = `const fs=require('node:fs');fs.writeFileSync(process.argv[1],'inside');try{fs.writeFileSync(process.argv[2],'ESCAPE');process.exit(99)}catch(e){if(e.code!=='EACCES'&&e.code!=='EROFS'&&e.code!=='EPERM')throw e;console.log('OUTSIDE_DENIED',e.code)}`
  const confined = await ctx.sandbox.confine([process.execPath, '-e', source, inside, outside], {
    mode: 'workspace-write',
    workspaceRoot: workspace,
  })
  console.log(
    JSON.stringify({
      argv: confined.argv.slice(0, 5),
      enforcement: confined.enforcement,
      denialSignatures: confined.denialSignatures,
    }),
  )
  assert.ok(
    confined.enforcement === 'full' || confined.enforcement === 'partial',
    'must return actual confinement metadata',
  )
  const result = spawnSync(confined.argv[0], confined.argv.slice(1), {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 10000,
  })
  console.log(result.stdout)
  console.error(result.stderr)
  assert.equal(result.status, 0)
  assert.ok(existsSync(inside))
  assert.equal(readFileSync(outside, 'utf8'), 'unchanged')
  console.log('PASS real DSH sandbox permits inside edit and rejects ordinary outside edit')
  const alias = join(workspace, 'existing-hardlink')
  linkSync(outside, alias)
  const aliasWrap = await ctx.sandbox.confine(
    [process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1],'HOST_ALIAS_WRITE')", alias],
    { mode: 'workspace-write', workspaceRoot: workspace },
  )
  const aliasResult = spawnSync(aliasWrap.argv[0], aliasWrap.argv.slice(1), {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 10000,
  })
  const shared = readFileSync(outside, 'utf8') === 'HOST_ALIAS_WRITE'
  assert.ok(shared || readFileSync(outside, 'utf8') === 'unchanged')
  console.log(
    `OBSERVATION same DSH provider existing-hardlink shared writes=${shared}; exit=${aliasResult.status}; not inode-isolation qualification`,
  )
  writeFileSync(outside, 'unchanged')
  const sourceDir = join(root, 'source')
  mkdirSync(sourceDir)
  const auth = JSON.stringify({
    fake: { type: 'api_key', key: 'dummy-bootstrap-only' },
    browser: { type: 'oauth', refresh: 'must-not-copy' },
  })
  writeFileSync(join(sourceDir, 'auth.json'), auth)
  const bundled = join(root, 'private-state.mjs')
  const { build } = await import('esbuild')
  await build({
    entryPoints: ['src/host/external/private-state.ts'],
    outfile: bundled,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
  })
  for (const [kind, url] of [
    ['source', pathToFileURL(resolve('src/host/external/private-state.ts')).href],
    ['built', pathToFileURL(bundled).href],
  ]) {
    const { privateStateLaunch } = await import(url)
    const runDir = join(check.home, `boot-${kind}`)
    const child = `const fs=require('node:fs'); const p=require('node:path'); if(process.env.DSH_ROLES_CLI_BOOT)throw Error('envelope leaked'); const a=JSON.parse(fs.readFileSync(p.join(process.env.PI_CODING_AGENT_DIR,'auth.json'))); if(Object.keys(a).join(',')!=='fake')throw Error('OAuth copied'); fs.writeFileSync(process.argv[1],'inside'); try{fs.writeFileSync(process.argv[2],'ESCAPE');process.exit(99)}catch(e){if(!['EACCES','EROFS','EPERM'].includes(e.code))throw e;} console.log('BOOT_BOUNDARY_OK')`
    const boot = privateStateLaunch(
      'pi',
      runDir,
      [process.execPath, '-e', child, inside, outside],
      { [join(runDir, 'task.txt')]: 'PRIVATE_TASK' },
      { HOME: root, PI_CODING_AGENT_DIR: sourceDir },
      workspace,
    )
    const wrapped = await ctx.sandbox.confine(boot.argv, { mode: 'workspace-write', workspaceRoot: workspace })
    const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), {
      cwd: workspace,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        HOME: join(runDir, 'home'),
        PI_CODING_AGENT_DIR: join(runDir, 'pi'),
        DSH_ROLES_CLI_BOOT: boot.payload,
      },
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /BOOT_BOUNDARY_OK/)
    assert.equal(readFileSync(outside, 'utf8'), 'unchanged')
    assert.equal(readFileSync(join(sourceDir, 'auth.json'), 'utf8'), auth)
    console.log(
      `PASS ${kind} bootstrap applies DSH boundary before state/CLI, preserves source auth, filters OAuth and hides envelope; enforcement=${wrapped.enforcement}`,
    )
  }
} finally {
  await ctx.fiber?.dispose?.()
  if (realpathSync(root) === root) rmSync(root, { recursive: true, force: true })
  hook.deregister()
  check.dispose()
}
