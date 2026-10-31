/**
 * Real-CLI integration cases for the Codex adapter (`pnpm check:cli codex`).
 *
 * Every run uses an isolated HOME and CODEX_HOME whose config.toml selects a
 * custom `fake` model provider pointing at tests/support/fake-models/codex.mjs;
 * the fake key travels through the CLI's `envPassthrough` (the provider's
 * `env_key`), so Codex never contacts api.openai.com and no sandbox credential
 * is used. Retries are off so failures are immediate.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FAKE_KEY = 'sk-fake-codex-check-0000'
const SERVER = 'tests/support/fake-models/codex.mjs'
// Test-only selection: never changes production settings or disables a sandbox.
const SANDBOX_BACKEND = process.env.CHECK_CODEX_SANDBOX_BACKEND ?? 'default'
if (!['default', 'legacy-landlock'].includes(SANDBOX_BACKEND)) throw new Error('unknown CHECK_CODEX_SANDBOX_BACKEND')

/**
 * Start a fake Responses server for `script` and an isolated Codex home configured for it.
 * @returns the server, its request log reader and the env/clis options for `h.world`.
 */
async function fakeCodex(h, script, { forwardKey = true, extraConfig = [] } = {}) {
  const dir = h.workspace()
  const scriptPath = join(dir, 'script.json')
  const logPath = join(dir, 'requests.jsonl')
  writeFileSync(scriptPath, JSON.stringify(script))
  writeFileSync(logPath, '')
  const server = await h.server(SERVER, ['--script', scriptPath, '--log', logPath])
  const home = h.workspace()
  const codexHome = h.workspace({
    'config.toml': [
      'model = "fake-model"',
      'model_provider = "fake"',
      'check_for_update_on_startup = false',
      '',
      '[model_providers.fake]',
      'name = "Fake Responses"',
      `base_url = "${server.url}/v1"`,
      'env_key = "FAKE_CODEX_KEY"',
      'wire_api = "responses"',
      'request_max_retries = 0',
      'stream_max_retries = 0',
      '',
      '[analytics]',
      'enabled = false',
      '',
      ...(SANDBOX_BACKEND === 'legacy-landlock' ? ['[features]', 'use_legacy_landlock = true', ''] : []),
      ...extraConfig,
    ].join('\n'),
  })
  const passthrough = ['CODEX_HOME', 'NO_PROXY', 'no_proxy', ...(forwardKey ? ['FAKE_CODEX_KEY'] : [])]
  return {
    server,
    codexHome,
    requests: () =>
      readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line)),
    env: {
      HOME: home,
      CODEX_HOME: codexHome,
      FAKE_CODEX_KEY: FAKE_KEY,
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
    },
    clis: { codex: { executable: h.executable, envPassthrough: passthrough } },
  }
}

/** Every process whose command line mentions `marker` (the run's unique workspace path). */
function processesMentioning(marker) {
  const pids = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, 'utf8').includes(marker)) pids.push(Number(entry))
    } catch {}
  }
  return pids
}

function textOfInput(body, role) {
  return (body.input ?? [])
    .filter(item => item.role === role)
    .flatMap(item => item.content ?? [])
    .map(part => part.text ?? '')
}

function functionOutputs(body) {
  return (body.input ?? []).filter(item => item.type === 'function_call_output').map(item => String(item.output))
}

const coder = (h, runner, patch = {}) =>
  h.role('coder', { description: 'Codex coder.', runner: { cli: 'codex', ...runner }, ...patch })

export async function cases(h) {
  h.case('answer reaches the parent; instructions, model and effort reach the model', async () => {
    const fake = await fakeCodex(h, [{ kind: 'complete', text: 'CODEX_FAKE_ANSWER ✓' }])
    const ws = h.workspace({ 'README.md': 'hello' })
    const instructions = 'Be terse.\nQuote: "x" \\ ✓ and = signs'
    const w = await h.world({
      cwd: ws,
      roles: [coder(h, { permission: 'workspace-write', model: 'gpt-5.5', effort: 'high' }, { instructions })],
      clis: fake.clis,
      env: fake.env,
    })
    try {
      const { childId } = await w.delegate({ role: 'coder', prompt: 'TASK_MARKER say hi' })
      const notice = await w.notice(childId, 60_000)
      h.assert.match(notice, new RegExp(`Background subagent ${childId} finished`))
      h.assert.ok(notice.includes('CODEX_FAKE_ANSWER ✓'), notice)
      const [request] = fake.requests()
      h.assert.equal(request.headers.authorization, `Bearer ${FAKE_KEY}`)
      h.assert.equal(request.body.model, 'gpt-5.5')
      h.assert.equal(request.body.reasoning?.effort, 'high')
      const developer = textOfInput(request.body, 'developer')
      const role = developer.find(text => text.startsWith('Your role: coder.'))
      h.assert.ok(role !== undefined, `role instructions in a developer message: ${JSON.stringify(developer)}`)
      h.assert.ok(role.includes(instructions), 'instructions arrive byte-exact')
      h.assert.ok(textOfInput(request.body, 'user').some(text => text.includes('TASK_MARKER say hi')))
    } finally {
      await w.close()
    }
  })

  h.case('read-only role: a write attempted by the model is blocked', async () => {
    const fake = await fakeCodex(h, [
      { kind: 'tool', name: 'exec_command', arguments: { cmd: 'printf pwned > created.txt; echo rc=$?' } },
      { kind: 'complete', text: 'RO_DONE' },
    ])
    const ws = h.workspace({ 'README.md': 'hello' })
    const w = await h.world({
      cwd: ws,
      roles: [coder(h, { permission: 'read-only' }, { readOnly: true })],
      clis: fake.clis,
      env: fake.env,
    })
    try {
      const { childId } = await w.delegate({ role: 'coder', prompt: 'Create created.txt' })
      const notice = await w.notice(childId, 60_000)
      h.assert.ok(notice.includes('RO_DONE'), notice)
      h.assert.equal(existsSync(join(ws, 'created.txt')), false, 'the read-only sandbox blocked the write')
      const outputs = functionOutputs(fake.requests()[1]?.body ?? {})
      h.assert.ok(
        outputs.some(output => /Read-only file system/.test(output)),
        `tool output: ${outputs}`,
      )
    } finally {
      await w.close()
    }
  })

  h.case('workspace-write role (default preset) can write inside the workspace', async () => {
    const fake = await fakeCodex(h, [
      { kind: 'tool', name: 'exec_command', arguments: { cmd: 'printf hello > created.txt' } },
      { kind: 'complete', text: 'WRITE_DONE' },
    ])
    const ws = h.workspace()
    const w = await h.world({
      cwd: ws,
      roles: [coder(h, { permission: 'workspace-write' })],
      clis: fake.clis,
      env: fake.env,
    })
    try {
      const { childId } = await w.delegate({ role: 'coder', prompt: 'Create created.txt' })
      const notice = await w.notice(childId, 60_000)
      h.assert.ok(notice.includes('WRITE_DONE'), notice)
      h.assert.equal(readFileSync(join(ws, 'created.txt'), 'utf8'), 'hello')
    } finally {
      await w.close()
    }
  })

  h.case('workspace-write from a subdirectory of a git repository cannot write a sibling directory', async () => {
    const fake = await fakeCodex(h, [
      { kind: 'tool', name: 'exec_command', arguments: { cmd: 'printf x > ../sibling/from-sub.txt; echo rc=$?' } },
      { kind: 'complete', text: 'SIBLING_DONE' },
    ])
    const ws = h.workspace({ 'sub/a.txt': 'a\n', 'sibling/b.txt': 'b\n' }, { outsideTmp: true })
    const git = (...args) =>
      execFileSync('git', ['-C', ws, '-c', 'user.email=a@b', '-c', 'user.name=a', ...args], {
        env: { PATH: process.env.PATH, HOME: fake.env.HOME },
      })
    git('init', '-q')
    git('add', '.')
    git('commit', '-q', '-m', 'init')
    const w = await h.world({
      cwd: ws,
      roles: [coder(h, { permission: 'workspace-write' })],
      clis: fake.clis,
      env: fake.env,
    })
    try {
      const { childId } = await w.delegate({ role: 'coder', cwd: join(ws, 'sub'), prompt: 'Write the sibling' })
      const notice = await w.notice(childId, 60_000)
      h.assert.ok(notice.includes('SIBLING_DONE'), notice)
      const outputs = functionOutputs(fake.requests()[1]?.body ?? {})
      h.assert.ok(
        outputs.some(output => /Read-only file system|Permission denied|rc=[1-9]/.test(output)),
        `tool output: ${outputs}`,
      )
      h.assert.equal(
        existsSync(join(ws, 'sibling', 'from-sub.txt')),
        false,
        'workspace-write wrote a sibling directory',
      )
    } finally {
      await w.close()
    }
  })

  h.case(
    "workspace-write ignores a config's extra writable roots (control run without the override writes)",
    async () => {
      const outside = h.workspace({}, { outsideTmp: true })
      const command = { cmd: `printf x > ${outside}/extra.txt; echo rc=$?` }
      const fake = await fakeCodex(
        h,
        [
          { kind: 'tool', name: 'exec_command', arguments: command },
          { kind: 'complete', text: 'ROOTS_DONE' },
          { kind: 'tool', name: 'exec_command', arguments: command },
          { kind: 'complete', text: 'CONTROL_DONE' },
        ],
        { extraConfig: ['[sandbox_workspace_write]', `writable_roots = [${JSON.stringify(outside)}]`, ''] },
      )
      const ws = h.workspace({ 'README.md': 'x\n' }, { outsideTmp: true })
      const w = await h.world({
        cwd: ws,
        roles: [coder(h, { permission: 'workspace-write' })],
        clis: fake.clis,
        env: fake.env,
      })
      try {
        const { childId } = await w.delegate({ role: 'coder', prompt: 'Write the extra root' })
        h.assert.ok((await w.notice(childId, 60_000)).includes('ROOTS_DONE'))
        h.assert.equal(existsSync(join(outside, 'extra.txt')), false, 'a configured writable root stayed writable')
        // Control: the same run without `sandbox_workspace_write.writable_roots=[]` can write there.
        const { codexAdapter } = await import('../../src/host/cli/codex/index.ts')
        const adapter = {
          ...codexAdapter,
          plan(input, nonce) {
            const plan = codexAdapter.plan(input, nonce)
            const at = plan.argv.indexOf('sandbox_workspace_write.writable_roots=[]')
            return { ...plan, argv: plan.argv.filter((_, i) => i !== at && i !== at - 1) }
          },
        }
        const run = await h.engine.startExternalRun(
          {
            adapter,
            input: {
              runner: { cli: 'codex', permission: 'workspace-write' },
              preset: 'workspace-write',
              access: 'workspace-write',
              instructions: '',
              task: 'Write the extra root',
              cwd: ws,
            },
            settings: fake.clis.codex,
            timeoutMs: 60_000,
            signal: new AbortController().signal,
          },
          h.engineDeps(w),
        )
        h.assert.equal((await run.result).stopReason, 'completed')
        await run.dispose()
        h.assert.equal(existsSync(join(outside, 'extra.txt')), true, 'control: the configured root is writable')
      } finally {
        await w.close()
      }
    },
  )

  h.case('a read-only parent sandbox lowers a workspace-write role to read-only', async () => {
    const fake = await fakeCodex(h, [
      { kind: 'tool', name: 'exec_command', arguments: { cmd: 'printf x > created.txt' } },
      { kind: 'complete', text: 'CEILING_DONE' },
    ])
    const ws = h.workspace()
    const w = await h.world({
      cwd: ws,
      sandboxMode: 'read-only',
      roles: [coder(h, { permission: 'workspace-write' })],
      clis: fake.clis,
      env: fake.env,
    })
    try {
      const { childId } = await w.delegate({ role: 'coder', prompt: 'Create created.txt' })
      h.assert.ok((await w.notice(childId, 60_000)).includes('CEILING_DONE'))
      h.assert.equal(existsSync(join(ws, 'created.txt')), false)
      const outputs = functionOutputs(fake.requests()[1]?.body ?? {})
      h.assert.ok(
        outputs.some(output => /Read-only file system/.test(output)),
        `tool output: ${outputs}`,
      )
    } finally {
      await w.close()
    }
  })

  h.case('interrupt_agent aborts the run and leaves no Codex process behind', async () => {
    const fake = await fakeCodex(h, [{ kind: 'hold' }])
    const ws = h.workspace()
    const w = await h.world({
      cwd: ws,
      roles: [coder(h, { permission: 'workspace-write' })],
      clis: fake.clis,
      env: fake.env,
    })
    try {
      const { childId } = await w.delegate({ role: 'coder', prompt: 'wait forever' })
      await h.wait(() => fake.requests().length > 0, 30_000, 'the model request')
      const pids = processesMentioning(ws)
      h.assert.ok(pids.length > 0, 'the Codex processes are visible')
      w.interrupt(childId)
      const notice = await w.notice(childId, 30_000)
      h.assert.match(notice, /was stopped before it finished/)
      await h.wait(() => pids.every(pid => !h.alive(pid)), 10_000, 'every Codex process to exit')
      h.assert.deepEqual(processesMentioning(ws), [])
    } finally {
      await w.close()
    }
  })

  h.case('wall-clock timeout terminates the real streaming Codex process', async () => {
    const fake = await fakeCodex(h, [{ kind: 'hold' }])
    const ws = h.workspace()
    const w = await h.world({ cwd: ws, roles: [], clis: fake.clis, env: fake.env })
    let run
    try {
      const { codexAdapter } = await import('../../src/host/cli/codex/index.ts')
      run = await h.engine.startExternalRun(
        {
          adapter: codexAdapter,
          input: {
            runner: { cli: 'codex', permission: 'workspace-write' },
            preset: 'workspace-write',
            access: 'workspace-write',
            instructions: '',
            task: 'wait forever',
            cwd: ws,
          },
          settings: fake.clis.codex,
          timeoutMs: 2000,
          signal: new AbortController().signal,
        },
        h.engineDeps(w),
      )
      const result = await run.result
      h.assert.match(result.diagnostic ?? '', /timeout/)
      h.assert.ok(fake.requests().length > 0, 'real CLI reached the local streaming backend')
      h.assert.ok(
        fake.requests().every(r => r.headers.authorization === `Bearer ${FAKE_KEY}`),
        'only dummy auth reached backend',
      )
      await h.wait(() => processesMentioning(ws).length === 0, 10_000, 'timed-out Codex process to exit')
    } finally {
      await run?.dispose()
      await w.close()
    }
  })

  h.case('a rejected API key yields a safe auth diagnostic', async () => {
    const fake = await fakeCodex(h, [
      {
        kind: 'error',
        status: 401,
        body: { error: { message: `Incorrect API key provided: ${FAKE_KEY}`, type: 'invalid_request_error' } },
      },
    ])
    const w = await h.world({
      cwd: h.workspace(),
      roles: [coder(h, { permission: 'workspace-write' })],
      clis: fake.clis,
      env: fake.env,
    })
    try {
      const { childId } = await w.delegate({ role: 'coder', prompt: 'hi' })
      const notice = await w.notice(childId, 60_000)
      h.assert.match(notice, /failed before it finished/)
      h.assert.match(notice, /Subagent failure \(CLI: Codex; category: auth; exit code: 1; http status: 401\)/)
      for (const leak of ['127.0.0.1', 'sk-fake', 'Incorrect API key', '/v1/responses']) {
        h.assert.equal(notice.includes(leak), false, `notice leaks ${leak}: ${notice}`)
      }
    } finally {
      await w.close()
    }
  })

  h.case('an unforwarded provider key and an upstream 500 map to auth and service', async () => {
    const missing = await fakeCodex(h, [], { forwardKey: false })
    const w = await h.world({
      cwd: h.workspace(),
      roles: [coder(h, { permission: 'workspace-write' })],
      clis: missing.clis,
      env: missing.env,
    })
    try {
      const { childId } = await w.delegate({ role: 'coder', prompt: 'hi' })
      const notice = await w.notice(childId, 60_000)
      h.assert.match(notice, /category: auth; exit code: 1; reason: missing-api-key\)/)
      h.assert.equal(missing.requests().length, 0)
    } finally {
      await w.close()
    }
    const upstream = await fakeCodex(h, [
      { kind: 'error', status: 500, body: { error: { message: 'boom at http://internal', type: 'server_error' } } },
    ])
    const v = await h.world({
      cwd: h.workspace(),
      roles: [coder(h, { permission: 'workspace-write' })],
      clis: upstream.clis,
      env: upstream.env,
    })
    try {
      const { childId } = await v.delegate({ role: 'coder', prompt: 'hi' })
      const notice = await v.notice(childId, 60_000)
      h.assert.match(notice, /category: service/)
      h.assert.equal(notice.includes('internal'), false, notice)
    } finally {
      await v.close()
    }
  })

  h.case('probe: version, sign-in state and model list without a model call', async () => {
    const fake = await fakeCodex(h, [])
    const w = await h.world({ cwd: h.workspace(), roles: [], clis: fake.clis, env: fake.env })
    try {
      const service = await h.wait(() => w.ctx.get('rolesubagentsCli'), 5_000, 'the rolesubagentsCli service')
      const result = await service.probe({ cli: 'codex' }, new AbortController().signal)
      h.assert.equal(result.found, true)
      h.assert.match(result.version ?? '', /^\d+\.\d+\.\d+/)
      // Not signed in to OpenAI, but a custom provider's key is forwarded, which `login status` cannot judge.
      h.assert.equal(result.auth, 'unknown', 'a forwarded custom-provider key makes the sign-in state unknown')
      h.assert.ok((result.models ?? []).length > 0, 'models are listed')
      h.assert.ok(
        result.models.every(model => !(model.efforts ?? []).includes('ultra')),
        'ultra is never offered',
      )
      h.assert.equal(fake.requests().length, 0, 'no model request')
    } finally {
      await w.close()
    }
  })
}
