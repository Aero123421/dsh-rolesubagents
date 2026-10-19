#!/usr/bin/env node
/**
 * Opt-in integration check for external CLI roles against a REAL DSH runtime
 * (not run in CI). Usage:
 *
 *   pnpm check:cli               # self-check + every CLI that has a case module
 *   pnpm check:cli self codex    # only the named suites
 *
 * Environment:
 * - DSH_CHECKOUT  DSH installation whose @deepseek-ai/* packages are used (default /opt/dsh).
 * - CLI_PATH_DIR  extra directory searched for CLI binaries (prepended to PATH). The harness also
 *                 searches /opt/cli-tools/node_modules/.bin and /opt/cli-tools/bin.
 *
 * What is real: Cordis, SessionStore, AgentRegistry, SystemPrompt, ToolRuntime, the storage stack
 * (Storage + JSON backend in a temp dir + DomainFacility), LocalSubprocessRuntime and
 * SubagentRuntime from DSH, and this plugin's own `apply` (loaded from src/ with Node's type
 * stripping). What is stubbed: the parent Agent (a real Session with a recording inbox, as DSH's
 * own tests do), `workingDirectory` and `sandboxPolicy` (fixed per world). No model is called.
 *
 * ── Case-module contract (Phase B) ─────────────────────────────────────────────────────────────
 * `scripts/check-cli/<cli-id>.mjs` (e.g. `codex.mjs`) is loaded when present:
 *
 *   export async function cases(h) {
 *     h.case('answers through the parent notice', async () => {
 *       const fake = await h.server('tests/support/fake-models/codex.mjs')   // optional fake model server
 *       const ws = h.workspace({ 'README.md': 'hello' })
 *       const w = await h.world({ roles: [h.role('coder', { runner: { cli: 'codex', permission: 'workspace-write' } })],
 *                                 clis: { codex: { envPassthrough: ['CODEX_API_KEY'] } }, env: { CODEX_API_KEY: 'fake' }, cwd: ws })
 *       const { childId } = await w.delegate({ role: 'coder', prompt: 'say hi' })
 *       const notice = await w.notice(childId)
 *       h.assert.match(notice, /finished/)
 *       await w.close()
 *     })
 *   }
 *
 * The module is skipped (SKIP) when the CLI's executable is not found. Cases run sequentially;
 * a throw fails that case only. `h` (see `makeHelpers`) provides:
 * - `h.cli`, `h.executable`             the suite's CLI id and its resolved binary (undefined for `self`).
 * - `h.assert`                          `node:assert/strict`.
 * - `h.case(name, fn)` / `h.skip(name, reason)`   register a case / report a skipped one.
 * - `h.workspace(files?)`               a fresh temp directory (optionally with files); removed at exit.
 * - `h.role(id, patch)`                 a role definition with sensible defaults.
 * - `h.server(path, args?)`             spawn a Node script that prints `{"port":<n>}` (or a bare port)
 *                                       as its first stdout line; returns `{ port, url, stop() }`.
 * - `h.world(options)`                  a real DSH runtime with this plugin mounted (see `createWorld`):
 *   options `{ roles, clis?, adapters?, env?, cwd?, sandboxMode?, workspaceRoot?, maxDepth? }`; returns
 *   `{ ctx, parent, delegate(args), notice(childId, ms?), notices, interrupt(childId), unload(), close() }`.
 *   `env` entries are set on process.env for the world's lifetime (credentials for fake servers).
 * - `h.engine`                          the engine module (`startExternalRun`, `createProbeRunner`…) for
 *                                       direct runs without DSH, with `h.engineDeps(world)` for its deps.
 * - `h.wait(predicate, ms?)`            poll until a predicate is truthy.
 * - `h.alive(pid)`                      whether a process id still exists.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkout = resolve(process.env.DSH_CHECKOUT || '/opt/dsh')
const hostRequire = createRequire(resolve(checkout, 'package.json'))
// Resolve every @deepseek-ai/* import (DSH's and this plugin's) from one installation, as DSH does for plugins.
const resolutionHook = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/')) {
      return { url: pathToFileURL(hostRequire.resolve(specifier)).href, shortCircuit: true }
    }
    return next(specifier, context)
  },
})

// CLI lookup: CLI_PATH_DIR first, then the sandbox's tool dirs, then the existing PATH.
const extraDirs = [process.env.CLI_PATH_DIR, '/opt/cli-tools/node_modules/.bin', '/opt/cli-tools/bin'].filter(
  dir => typeof dir === 'string' && dir !== '' && existsSync(dir),
)
process.env.PATH = [...extraDirs, process.env.PATH ?? ''].join(delimiter)

const { Context } = await import('@deepseek-ai/cordis')
const { default: SessionStore, SessionId } = await import('@deepseek-ai/dsh-session')
const { default: AgentRegistry } = await import('@deepseek-ai/dsh-agent')
const { default: SubagentRuntime } = await import('@deepseek-ai/dsh-subagent')
const { default: LocalSubprocessRuntime } = await import('@deepseek-ai/dsh-subprocess-local')
const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
const { default: ToolRuntime } = await import('@deepseek-ai/dsh-tools')
const { createScope } = await import('@deepseek-ai/dsh-scope')
const { default: Storage } = await import('@deepseek-ai/dsh-storage')
const JsonStorage = await import('@deepseek-ai/dsh-storage-json')
const StorageDomain = await import('@deepseek-ai/dsh-storage-domain')
const plugin = await import('../src/host/index.ts')
const engine = await import('../src/host/external/engine.ts')
const { CLI_DESCRIPTORS } = await import('../src/shared/cli/index.ts')
const { CODEX } = await import('../src/shared/cli/codex.ts')

const cleanup = []
const sleep = ms => new Promise(r => setTimeout(r, ms))

async function wait(predicate, ms = 10_000, what = 'condition') {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(20)
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function workspace(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rolesubagents-check-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

function role(id, patch = {}) {
  return { id, enabled: true, description: `${id} role`, instructions: '', context: 'spawn', readOnly: false, ...patch }
}

async function server(path, args = []) {
  const child = spawn(process.execPath, [resolve(repo, path), ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
  const stop = () => child.kill('SIGKILL')
  cleanup.push(stop)
  const first = await new Promise((resolveLine, reject) => {
    createInterface({ input: child.stdout }).once('line', resolveLine)
    child.once('exit', code => reject(new Error(`${path} exited with ${code} before printing its port`)))
  })
  let port
  try {
    port = JSON.parse(first).port ?? Number(first)
  } catch {
    port = Number(first)
  }
  if (!Number.isInteger(port)) throw new Error(`${path} printed no port: ${first}`)
  return { port, url: `http://127.0.0.1:${port}`, stop }
}

/** A parent Agent over a real Session with a recording inbox (the pattern DSH's own tests use). */
function parentAgent(ctx, cwd) {
  const session = ctx.sessions.create(SessionId(randomUUID()), { meta: { cwd } })
  const queues = { 'next-turn': [], 'next-step': [] }
  const delivered = []
  const inbox = {
    get nextTurn() {
      return queues['next-turn']
    },
    get nextStep() {
      return queues['next-step']
    },
    clear() {
      queues['next-turn'].splice(0)
      queues['next-step'].splice(0)
    },
    append(type, message) {
      queues[type].push(message)
    },
    prepend(type, message) {
      queues[type].unshift(message)
    },
    replace: () => false,
    remove: () => false,
    splice: (type, start, count, items) => queues[type].splice(start, count, ...items),
  }
  const record = (message, type) => {
    delivered.push(message)
    inbox.append(type, message)
  }
  const agent = {
    id: session.id,
    session,
    options: {},
    status: 'idle',
    inbox,
    send: (message, type) => record(message, type),
    followup: message => record(message, 'next-turn'),
    steer: message => record(message, 'next-step'),
    inject: message => record(message, 'next-step'),
    cancel: (_cause, options) => {
      if (!options?.keepInbox) inbox.clear()
    },
    whenIdle: () => Promise.resolve(),
    runMaintenance: task => task(new AbortController().signal),
  }
  return { agent, delivered }
}

const textOf = message =>
  (message?.content ?? [])
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')

/**
 * A real DSH runtime with this plugin mounted as a child plugin fiber.
 * @param options - roles, clis, adapter override, env, parent cwd, sandbox mode/root, max depth.
 */
async function createWorld(options = {}) {
  const cwd = options.cwd ?? workspace()
  const stateDir = workspace()
  const savedEnv = {}
  for (const [name, value] of Object.entries(options.env ?? {})) {
    savedEnv[name] = process.env[name]
    process.env[name] = value
  }
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  // Constructed on the root (as scripts/check-workflow-host.mjs does) so scoped Agent contexts can reach it.
  new ToolRuntime(ctx, { mode: 'native' })
  await ctx.plugin(Storage)
  await ctx.plugin(JsonStorage, { root: stateDir })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  ctx.provide('workingDirectory', { ensure: async agent => agent.session.header.cwd ?? cwd })
  ctx.provide('sandboxPolicy', {
    resolve: () => ({ mode: options.sandboxMode ?? 'workspace-write', workspaceRoot: options.workspaceRoot ?? cwd }),
  })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(SubagentRuntime, { maxDepth: options.maxDepth ?? 1, maxActiveSubagents: 8 })
  await sleep(30)

  const config = {
    roles: options.roles ?? [],
    ...(options.clis === undefined ? {} : { clis: options.clis }),
  }
  const fiber = ctx.plugin(
    {
      name: 'dsh-rolesubagents-check',
      inject: plugin.inject,
      apply: (pluginCtx, cfg) =>
        plugin.apply(pluginCtx, cfg, options.adapters === undefined ? {} : { adapters: options.adapters }),
    },
    config,
  )
  await fiber
  await sleep(30)

  const { agent: parent, delivered } = parentAgent(ctx, cwd)
  // The parent's tool scope: a real dsh-scope layer over the root context, so the plugin's
  // per-Agent tool registration goes through DSH's scoped tool registry.
  const scope = createScope(ctx, parent)
  parent.ctx = scope.ctx
  ctx.agents.register(parent)
  await ctx.serial?.('agent/created', { agent: parent, source: 'startup' })
  await sleep(30)

  const world = {
    ctx,
    parent,
    notices: delivered,
    async delegate(args) {
      const tool = parent.ctx.tools.get('delegate', parent)
      assert(tool, 'the delegate tool is registered for the parent')
      const value = await tool.execute(
        {
          description: args.description ?? 'integration check',
          prompt: args.prompt,
          role: args.role,
          ...(args.cwd ? { cwd: args.cwd } : {}),
        },
        { agent: parent, signal: args.signal ?? new AbortController().signal },
      )
      return { childId: value.subagentId, value, tool }
    },
    async notice(childId, ms = 30_000) {
      const message = await wait(
        () => delivered.find(entry => textOf(entry).includes(childId)),
        ms,
        `the parent notice for ${childId}`,
      )
      return textOf(message)
    },
    interrupt(childId) {
      return ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: parent })
    },
    async unload() {
      await fiber.dispose?.()
    },
    async close() {
      for (const [name, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await fiber.dispose?.()
      await scope.dispose?.()
      await ctx.fiber?.dispose?.()
    },
  }
  return world
}

// ---------------------------------------------------------------------------------------------------------------

function makeHelpers(cli, executable) {
  const registered = []
  return {
    registered,
    helpers: {
      cli,
      executable,
      assert,
      case: (name, fn) => registered.push({ name, fn }),
      skip: (name, reason) => registered.push({ name, skip: reason }),
      workspace,
      role,
      server,
      world: createWorld,
      engine,
      engineDeps: world => ({
        subprocess: () => world.ctx.get('subprocess'),
        logger: { info: () => {}, warn: message => console.log(`    log: ${message.split('\n')[0]}`) },
        runs: new Set(),
      }),
      wait,
      alive,
    },
  }
}

const SECRET_PLACEHOLDER = '$' + '{SECRET}'

/** Test-only adapter for the fake CLI (protocol: tests/support/fake-cli/fake-cli.mjs). */
function fakeCliAdapter(pids) {
  return {
    descriptor: CODEX,
    plan: input => ({
      argv: ['--preset', input.preset],
      env: { FAKE_CLI_SECRET: SECRET_PLACEHOLDER },
      cancelGraceMs: 200,
    }),
    createSession(input) {
      let answer = ''
      let done = false
      let failure
      let io
      return {
        start(stdio) {
          io = stdio
          stdio.write(input.task)
          stdio.end()
        },
        line(text) {
          let event
          try {
            event = JSON.parse(text)
          } catch {
            return
          }
          if (event.type === 'pid') pids.push(event.pid)
          else if (event.type === 'text') answer += event.text
          else if (event.type === 'done') done = true
          else if (event.type === 'error') failure = event.category
        },
        cancel() {
          io?.end()
        },
        finish: exit =>
          failure !== undefined
            ? { status: 'failed', category: failure, answer }
            : done
              ? { status: 'completed', answer }
              : { status: 'failed', category: 'cli-crashed', answer, facts: { 'exit code': exit.code ?? -1 } },
      }
    },
  }
}

async function selfCheck(h) {
  const fakeCli = join(repo, 'tests/support/fake-cli/fake-cli.mjs')
  const pids = []
  const runner = { cli: 'codex', permission: 'workspace-write' }
  const options = ws => ({
    cwd: ws,
    roles: [h.role('fake', { description: 'Fake CLI role.', runner })],
    clis: { codex: { executable: fakeCli } },
    adapters: () => fakeCliAdapter(pids),
  })

  h.case('answer reaches the parent notice through the real SubagentRuntime', async () => {
    const ws = h.workspace()
    const w = await h.world(options(ws))
    try {
      const { childId, tool, value } = await w.delegate({ role: 'fake', prompt: 'hello ✓ CWD' })
      const rendered = tool.output.render({ role: 'fake' }, value)
      h.assert.equal(rendered[0].text, `started Codex subagent ${childId}`)
      const notice = await w.notice(childId)
      h.assert.match(notice, new RegExp(`Background subagent ${childId} finished`))
      h.assert.ok(notice.includes(ws), `notice carries the answer (cwd): ${notice}`)
      h.assert.equal(
        w.ctx.subagents.list().some(p => p.name.startsWith('rolesubagents:')),
        false,
      )
    } finally {
      await w.close()
    }
  })

  h.case('a failing CLI yields a safe diagnostic', async () => {
    const w = await h.world(options(h.workspace()))
    try {
      const { childId } = await w.delegate({ role: 'fake', prompt: 'FAIL' })
      const notice = await w.notice(childId)
      h.assert.match(notice, /failed before it finished/)
      h.assert.match(notice, /Subagent failure \(CLI: Codex; category: cli-crashed; exit code: 3\)/)
      h.assert.equal(notice.includes('sk-test-123'), false, 'stderr never reaches the parent')
    } finally {
      await w.close()
    }
  })

  h.case('interrupt_agent stops the CLI process', async () => {
    const w = await h.world(options(h.workspace()))
    try {
      const before = pids.length
      const { childId } = await w.delegate({ role: 'fake', prompt: 'SLOW' })
      await h.wait(() => pids.length > before, 10_000, 'the fake CLI pid')
      const pid = pids.at(-1)
      w.interrupt(childId)
      const notice = await w.notice(childId)
      h.assert.match(notice, /was stopped before it finished/)
      await h.wait(() => !h.alive(pid), 10_000, 'the fake CLI to exit')
    } finally {
      await w.close()
    }
  })

  h.case('plugin unload disposes a running CLI', async () => {
    const w = await h.world(options(h.workspace()))
    try {
      const before = pids.length
      const { childId } = await w.delegate({ role: 'fake', prompt: 'SLOW' })
      await h.wait(() => pids.length > before, 10_000, 'the fake CLI pid')
      const pid = pids.at(-1)
      await w.unload()
      const notice = await w.notice(childId)
      h.assert.match(notice, /was stopped before it finished/)
      await h.wait(() => !h.alive(pid), 10_000, 'the fake CLI to exit')
    } finally {
      await w.close()
    }
  })

  h.case('depth limit and workspace containment refuse before spawning', async () => {
    const ws = h.workspace()
    const outside = h.workspace()
    const w = await h.world({ ...options(ws), maxDepth: 0 })
    try {
      await h.assert.rejects(w.delegate({ role: 'fake', prompt: 'x' }), /delegation depth limit reached/)
    } finally {
      await w.close()
    }
    const v = await h.world(options(ws))
    try {
      await h.assert.rejects(v.delegate({ role: 'fake', prompt: 'x', cwd: outside }), /outside the parent's workspace/)
    } finally {
      await v.close()
    }
  })

  h.case('the CLI connection test is mounted as a Remote service', async () => {
    const w = await h.world(options(h.workspace()))
    try {
      const service = await h.wait(() => w.ctx.get('rolesubagentsCli'), 5_000, 'the rolesubagentsCli service')
      const { remoteMethods } = await import('@deepseek-ai/dsh-typert-protocol')
      h.assert.deepEqual(
        remoteMethods(service).map(m => m.method),
        ['probe'],
      )
      const result = await service.probe({ cli: 'codex' }, new AbortController().signal)
      h.assert.equal(result.cli, 'codex')
      h.assert.equal(result.found, true)
    } finally {
      await w.close()
    }
  })
}

// ---------------------------------------------------------------------------------------------------------------

async function findExecutable(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir !== '' && existsSync(join(dir, name))) return join(dir, name)
  }
  return undefined
}

const requested = process.argv.slice(2)
const wanted = id => requested.length === 0 || requested.includes(id)
let failures = 0
let passes = 0
let skips = 0

async function runSuite(label, registerCases, cli, executable) {
  const { registered, helpers } = makeHelpers(cli, executable)
  await registerCases(helpers)
  for (const entry of registered) {
    if (entry.skip !== undefined) {
      skips++
      console.log(`SKIP ${label}: ${entry.name} (${entry.skip})`)
      continue
    }
    const started = Date.now()
    try {
      await entry.fn()
      passes++
      console.log(`PASS ${label}: ${entry.name} (${Date.now() - started} ms)`)
    } catch (error) {
      failures++
      console.log(`FAIL ${label}: ${entry.name}\n     ${error?.stack ?? error}`)
    }
  }
}

try {
  console.log(`DSH runtime: ${checkout}`)
  if (wanted('self')) await runSuite('self', selfCheck)
  for (const [id, descriptor] of Object.entries(CLI_DESCRIPTORS)) {
    if (!wanted(id)) continue
    const modulePath = join(repo, 'scripts/check-cli', `${id}.mjs`)
    if (!existsSync(modulePath)) {
      if (requested.includes(id)) console.log(`SKIP ${id}: no case module at scripts/check-cli/${id}.mjs`)
      continue
    }
    const executable = await findExecutable(descriptor.executable)
    if (executable === undefined) {
      skips++
      console.log(`SKIP ${id}: \`${descriptor.executable}\` not found (set CLI_PATH_DIR)`)
      continue
    }
    const module = await import(pathToFileURL(modulePath).href)
    await runSuite(id, module.cases, id, executable)
  }
} finally {
  for (const step of cleanup.reverse()) {
    try {
      step()
    } catch {}
  }
  resolutionHook.deregister()
}
console.log(`\n${passes} passed, ${failures} failed, ${skips} skipped`)
process.exit(failures > 0 ? 1 : 0)
