/**
 * Real-CLI integration cases for the Antigravity adapter (`pnpm check:cli agy`).
 *
 * SAFETY: every case runs with a scrubbed process environment (only PATH and a few locale/shell
 * variables survive) and a fresh HOME whose `.gemini/antigravity-cli/settings.json` selects the
 * Gemini API-key provider. GOOGLE_GEMINI_BASE_URL points at the local fake Gemini server
 * (tests/support/fake-models/agy.mjs), GEMINI_API_KEY is a fake value forwarded through
 * `clis.agy.envPassthrough`, and HTTPS_PROXY points at the same fake, which refuses every proxied
 * host at once — so agy's telemetry / feature-flag / updater traffic never leaves the machine and no
 * OAuth login or sandbox credential is ever used. AGY_CLI_MODEL_API_MAX_RETRIES=1 (tests only) makes
 * scripted 5xx errors fail at once.
 */

import { existsSync, readdirSync, readFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'

const FAKE_SERVER = 'tests/support/fake-models/agy.mjs'
const FAKE_KEY = 'fake-gemini-key-rolesubagents-check'
const KEEP_ENV = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR']
const PASSTHROUGH = ['GEMINI_API_KEY', 'GOOGLE_GEMINI_BASE_URL', 'HTTPS_PROXY', 'AGY_CLI_MODEL_API_MAX_RETRIES']
const AGENTS_DIR = '.gemini/config/agents'
const INSTRUCTIONS = 'ROLE_MARKER_AGY: follow the house rules.'

/** Run `fn` with process.env reduced to {@link KEEP_ENV} plus `env`, restoring it afterwards. */
async function isolatedEnv(env, fn) {
  const saved = { ...process.env }
  for (const name of Object.keys(process.env)) if (!KEEP_ENV.includes(name)) delete process.env[name]
  Object.assign(process.env, env)
  try {
    return await fn()
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name]
    Object.assign(process.env, saved)
  }
}

/** Pids of live processes whose environment carries `entry` (e.g. this case's fake base URL). */
function pidsWithEnv(entry) {
  const pids = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue
    try {
      if (readFileSync(`/proc/${name}/environ`, 'latin1').split('\0').includes(entry)) pids.push(Number(name))
    } catch {}
  }
  return pids
}

/** Generated agent files left in an isolated HOME. */
function generatedAgents(home) {
  const dir = join(home, AGENTS_DIR)
  return existsSync(dir) ? readdirSync(dir).filter(name => name.startsWith('dsh-rolesubagents-')) : []
}

export async function cases(h) {
  /**
   * One case: a workspace, the fake server, an isolated HOME + env and a world with `roles`.
   * `body({ w, ws, home, requests, main, baseUrlEntry })` does the checks.
   */
  async function withAgy({ roles, files = {}, forwardKey = true, homeFiles = {}, beforeWorld, world = {} }, body) {
    const ws = h.workspace({ 'README.md': '# test\nhello test\n', ...files })
    const home = h.workspace({
      '.gemini/antigravity-cli/settings.json': '{"modelProvider":"gemini"}\n',
      ...homeFiles,
    })
    beforeWorld?.(home)
    const fake = await h.server(FAKE_SERVER)
    const requests = async () => (await fetch(`${fake.url}/__requests`)).json()
    const main = async () => (await requests()).filter(request => !request.title)
    try {
      await isolatedEnv(
        {
          HOME: home,
          GEMINI_API_KEY: FAKE_KEY,
          GOOGLE_GEMINI_BASE_URL: fake.url,
          HTTPS_PROXY: fake.url,
          AGY_CLI_MODEL_API_MAX_RETRIES: '1',
        },
        async () => {
          const w = await h.world({
            ...world,
            cwd: ws,
            roles,
            clis: {
              agy: {
                executable: h.executable,
                envPassthrough: forwardKey ? PASSTHROUGH : PASSTHROUGH.filter(name => name !== 'GEMINI_API_KEY'),
              },
            },
          })
          try {
            await body({ w, ws, home, requests, main, baseUrlEntry: `GOOGLE_GEMINI_BASE_URL=${fake.url}` })
          } finally {
            await w.close()
          }
        },
      )
    } finally {
      fake.stop()
    }
  }

  const role = (id, runner = {}, patch = {}) =>
    h.role(id, {
      description: `Antigravity ${id}.`,
      instructions: INSTRUCTIONS,
      runner: { cli: 'agy', permission: 'edit-files', ...runner },
      ...patch,
    })

  /** Delegate and wait for the parent notice. */
  async function run(w, roleId, prompt) {
    const { childId } = await w.delegate({ role: roleId, prompt })
    return { childId, notice: await w.notice(childId, 90_000) }
  }

  h.case('answer reaches the parent; instructions reach the system prompt of a generated agent', async () => {
    await withAgy({ roles: [role('worker')] }, async x => {
      const { childId, notice } = await run(x.w, 'worker', 'TASK_MARKER_AGY please answer')
      h.assert.match(notice, new RegExp(`Background subagent ${childId} finished`))
      h.assert.match(notice, /FAKE_ANSWER: ok/)
      const [request] = await x.main()
      h.assert.ok(request, 'the fake received the model request')
      h.assert.ok(request.system.includes('ROLE_MARKER_AGY'), 'instructions are in the system prompt')
      h.assert.ok(request.system.includes('Your role: worker.'), 'the role id is in the system prompt')
      h.assert.ok(request.system.includes('<Role instructions>'), 'the agent body is a system prompt section')
      h.assert.ok(!request.user.includes('ROLE_MARKER_AGY'), 'instructions are not in the user message')
      h.assert.ok(request.user.includes('TASK_MARKER_AGY'), 'the task is the user message')
      h.assert.deepEqual(
        request.tools.filter(tool => tool !== 'manage_task'),
        ['view_file', 'grep_search', 'list_dir', 'find_by_name', 'write_to_file', 'replace_file_content'],
      )
      h.assert.deepEqual(generatedAgents(x.home), [], 'the generated agent file was removed after the run')
    })
  })

  h.case('edit-files (default) writes and edits inside the workspace without a soft-deny', async () => {
    await withAgy({ roles: [role('worker')] }, async x => {
      const write = await run(x.w, 'worker', 'write [[scenario:write]]')
      h.assert.match(write.notice, /finished/)
      h.assert.match(write.notice, /FAKE_DONE tool=write_to_file/)
      h.assert.doesNotMatch(write.notice, /category: permission/)
      h.assert.equal(readFileSync(join(x.ws, 'fake_written.txt'), 'utf8'), 'written by fake model\n')
      const edit = await run(x.w, 'worker', 'edit [[scenario:replace]]')
      h.assert.match(edit.notice, /FAKE_DONE tool=replace_file_content/)
      h.assert.equal(readFileSync(join(x.ws, 'README.md'), 'utf8'), '# test\nhello replaced\n')
    })
  })

  h.case('edit-files has no command tool and cannot write outside the workspace', async () => {
    await withAgy({ roles: [role('worker')] }, async x => {
      const command = await run(x.w, 'worker', 'run [[scenario:command]]')
      h.assert.match(command.notice, /unknown tool/)
      h.assert.equal(existsSync(join(x.ws, 'fake_cmd.txt')), false)
      // /proc cannot be written even by root, so a wrongly allowed write still leaves nothing behind.
      const outside = await run(
        x.w,
        'worker',
        'write [[scenario:write]] [[target:/proc/dsh-rolesubagents-check/o.txt]]',
      )
      h.assert.match(outside.notice, /failed before it finished/)
      h.assert.match(outside.notice, /category: permission/)
      h.assert.match(outside.notice, /denied actions: 1/)
    })
  })

  h.case('read-only preset blocks writes and commands, reads work', async () => {
    const reader = role('reader', { permission: 'read-only' }, { readOnly: true })
    await withAgy({ roles: [reader] }, async x => {
      const write = await run(x.w, 'reader', 'write [[scenario:write]]')
      h.assert.match(write.notice, /unknown tool/)
      h.assert.equal(existsSync(join(x.ws, 'fake_written.txt')), false)
      const command = await run(x.w, 'reader', 'run [[scenario:command]]')
      h.assert.match(command.notice, /unknown tool/)
      h.assert.equal(existsSync(join(x.ws, 'fake_cmd.txt')), false)
      const read = await run(x.w, 'reader', 'read [[scenario:read]]')
      h.assert.match(read.notice, /FAKE_DONE tool=view_file/)
      h.assert.match(read.notice, /Total Lines: 3/)
      const tools = (await x.main())[0].tools
      h.assert.deepEqual(
        tools.filter(tool => tool !== 'manage_task'),
        ['view_file', 'grep_search', 'list_dir', 'find_by_name'],
      )
    })
  })

  h.case('full-access keeps the default agent: commands run, instructions are a prompt prefix', async () => {
    const admin = role('admin', { permission: 'full-access' })
    await withAgy({ roles: [admin], world: { sandboxMode: 'danger-full-access' } }, async x => {
      const { notice } = await run(x.w, 'admin', 'run [[scenario:command]]')
      h.assert.match(notice, /FAKE_DONE tool=run_command/)
      h.assert.equal(readFileSync(join(x.ws, 'fake_cmd.txt'), 'utf8').trim(), 'FAKE_CMD')
      const [request] = await x.main()
      h.assert.ok(request.system.includes('You are Antigravity'), 'the default identity prompt is kept')
      h.assert.ok(request.tools.includes('run_command') && request.tools.includes('invoke_subagent'))
      h.assert.ok(request.user.includes('ROLE_MARKER_AGY'), 'instructions are prefixed to the user message')
      h.assert.ok(request.user.includes('Your role: admin.'))
      h.assert.deepEqual(generatedAgents(x.home), [], 'no agent file is generated for full access')
    })
  })

  h.case('model and effort reach the model request', async () => {
    const roles = [
      role('low', { model: 'gemini-3.8-flash', effort: 'low' }),
      role('high', { model: 'gemini-3.8-flash', effort: 'high' }),
    ]
    await withAgy({ roles }, async x => {
      await run(x.w, 'low', 'hello')
      await run(x.w, 'high', 'hello')
      const [low, high] = await x.main()
      h.assert.equal(low.model, 'gemini-3.8-flash')
      h.assert.equal(high.model, 'gemini-3.8-flash')
      h.assert.notEqual(
        low.generationConfig.thinkingConfig.thinkingBudget,
        high.generationConfig.thinkingConfig.thinkingBudget,
        'the effort changes the thinking budget',
      )
    })
  })

  h.case('an unknown model or an unsupported effort fails with a safe diagnostic', async () => {
    const roles = [
      role('nomodel', { model: 'no-such-model-dsh' }),
      role('noeffort', { model: 'gemini-3.1-pro', effort: 'xhigh' }),
    ]
    await withAgy({ roles }, async x => {
      const model = await run(x.w, 'nomodel', 'hello')
      h.assert.match(model.notice, /category: model; exit code: 1/)
      h.assert.doesNotMatch(model.notice, /no-such-model-dsh|Available models/)
      const effort = await run(x.w, 'noeffort', 'hello')
      h.assert.match(effort.notice, /category: config; exit code: 1/)
    })
  })

  h.case('interrupt stops the run as aborted and leaves no process or agent file behind', async () => {
    await withAgy({ roles: [role('worker')] }, async x => {
      const { childId } = await x.w.delegate({ role: 'worker', prompt: 'wait [[scenario:slow]]' })
      await h.wait(async () => (await x.main()).length > 0, 60_000, 'the held model request')
      h.assert.ok(pidsWithEnv(x.baseUrlEntry).length > 0, 'agy is running')
      h.assert.equal(generatedAgents(x.home).length, 1, 'the generated agent exists while the run is live')
      x.w.interrupt(childId)
      const notice = await x.w.notice(childId, 30_000)
      h.assert.match(notice, /was stopped before it finished/)
      await h.wait(() => pidsWithEnv(x.baseUrlEntry).length === 0, 15_000, 'every agy process to exit')
      await h.wait(() => generatedAgents(x.home).length === 0, 5_000, 'the agent file to be removed')
    })
  })

  h.case('upstream errors map to safe categories', async () => {
    await withAgy({ roles: [role('worker')] }, async x => {
      const limit = await run(x.w, 'worker', 'go [[scenario:error429]]')
      h.assert.match(limit.notice, /category: limit; exit code: 3; http status: 429/)
      const auth = await run(x.w, 'worker', 'go [[scenario:error401]]')
      h.assert.match(auth.notice, /category: auth; exit code: 3; http status: 401/)
      const service = await run(x.w, 'worker', 'go [[scenario:error503]]')
      h.assert.match(service.notice, /category: service; exit code: 3; http status: 503/)
      for (const { notice } of [limit, auth, service]) {
        h.assert.doesNotMatch(notice, /fake|executor|Message|127\.0\.0\.1/)
      }
    })
  })

  h.case('a missing API key is refused by the pre-flight with a safe auth diagnostic', async () => {
    await withAgy({ roles: [role('worker')], forwardKey: false }, async x => {
      let text
      try {
        const { childId } = await x.w.delegate({ role: 'worker', prompt: 'hello' })
        text = await x.w.notice(childId, 60_000)
      } catch (error) {
        text = String(error?.message ?? error)
      }
      h.assert.match(text, /Subagent failure \(CLI: Antigravity; category: auth\)/)
      h.assert.doesNotMatch(text, /GEMINI_API_KEY|settings\.json/)
      h.assert.equal((await x.main()).length, 0, 'no model request was made')
      h.assert.deepEqual(generatedAgents(x.home), [])
    })
  })

  h.case('plugin start sweeps only stale generated agent files', async () => {
    const stale = 'dsh-rolesubagents-stale00000000.md'
    const homeFiles = {
      [`${AGENTS_DIR}/${stale}`]: 'stale\n',
      [`${AGENTS_DIR}/dsh-rolesubagents-fresh00000000.md`]: 'fresh\n',
      [`${AGENTS_DIR}/my-own-agent.md`]: 'mine\n',
    }
    const beforeWorld = home => {
      const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
      utimesSync(join(home, AGENTS_DIR, stale), old, old)
      utimesSync(join(home, AGENTS_DIR, 'my-own-agent.md'), old, old)
    }
    await withAgy({ roles: [role('worker')], homeFiles, beforeWorld }, async x => {
      const dir = join(x.home, AGENTS_DIR)
      await h.wait(() => !existsSync(join(dir, stale)), 10_000, 'the stale agent file to be removed')
      h.assert.deepEqual(readdirSync(dir).sort(), ['dsh-rolesubagents-fresh00000000.md', 'my-own-agent.md'])
    })
  })

  h.case('the connection test reports version, sign-in state and models', async () => {
    await withAgy({ roles: [role('worker')] }, async x => {
      const service = await h.wait(() => x.w.ctx.get('rolesubagentsCli'), 5_000, 'the probe service')
      const result = await service.probe({ cli: 'agy' }, new AbortController().signal)
      h.assert.equal(result.found, true)
      h.assert.match(result.version ?? '', /^\d+\.\d+\.\d+/)
      h.assert.equal(result.auth, 'ok')
      const flash = result.models?.find(model => model.id === 'gemini-3.8-flash')
      h.assert.ok(flash, JSON.stringify(result.models))
      h.assert.deepEqual(flash.efforts, ['low', 'medium', 'high'])
    })
    await withAgy({ roles: [role('worker')], forwardKey: false }, async x => {
      const service = await h.wait(() => x.w.ctx.get('rolesubagentsCli'), 5_000, 'the probe service')
      const result = await service.probe({ cli: 'agy' }, new AbortController().signal)
      h.assert.equal(result.auth, 'missing')
    })
  })
}
