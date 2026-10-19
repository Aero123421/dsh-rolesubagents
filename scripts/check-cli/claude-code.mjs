/**
 * Real-CLI integration cases for Claude Code (`pnpm check:cli claude-code`).
 *
 * SAFETY: `claude` can authenticate with credentials it finds on the machine (a
 * signed-in user, or a sandbox's ambient token) even with an isolated HOME. So every
 * case runs with a scrubbed process environment (only PATH and a few locale/shell
 * variables survive; HOME is a fresh temp dir), ANTHROPIC_BASE_URL points at the
 * local fake Messages server (tests/support/fake-models/claude-code.mjs) and a fake
 * ANTHROPIC_API_KEY is forwarded through `clis['claude-code'].envPassthrough`. Each
 * case asserts that the fake actually received the model requests with that key.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FAKE_SERVER = 'tests/support/fake-models/claude-code.mjs'
const FAKE_KEY = 'sk-ant-fake-rolesubagents-check'
const KEEP_ENV = ['PATH', 'LANG', 'LC_ALL', 'TERM', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR']

/**
 * Run `fn` with process.env reduced to {@link KEEP_ENV} plus `env`, restoring it afterwards.
 * The DSH world (and so every spawned `claude`) is created inside, so nothing ambient leaks.
 */
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

export async function cases(h) {
  /**
   * One case: a workspace, a fake server scripted with `steps(ws)`, an isolated env and a world
   * with `roles`. `body({ w, ws, mainRequests, baseUrlEntry })` does the checks.
   */
  async function withClaude({ steps, roles, files = {}, world = {} }, body) {
    const ws = h.workspace(files)
    const home = h.workspace()
    const scratch = h.workspace()
    const script = join(scratch, 'steps.json')
    const log = join(scratch, 'requests.jsonl')
    writeFileSync(script, JSON.stringify(steps(ws)))
    writeFileSync(log, '')
    const fake = await h.server(FAKE_SERVER, ['--script', script, '--log', log])
    const mainRequests = () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
        .filter(request => request.main)
    try {
      await isolatedEnv(
        {
          HOME: home,
          ANTHROPIC_BASE_URL: fake.url,
          ANTHROPIC_API_KEY: FAKE_KEY,
          // Tests only: no retry back-off on scripted errors.
          CLAUDE_CODE_MAX_RETRIES: '0',
        },
        async () => {
          const w = await h.world({
            ...world,
            cwd: ws,
            roles,
            clis: {
              'claude-code': {
                executable: h.executable,
                envPassthrough: ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_MAX_RETRIES'],
              },
            },
          })
          try {
            await body({ w, ws, mainRequests, baseUrlEntry: `ANTHROPIC_BASE_URL=${fake.url}` })
          } finally {
            await w.close()
          }
        },
      )
    } finally {
      fake.stop()
    }
  }

  /** The fake saw at least one model request, all of them with the fake key and no other credential. */
  function assertOnlyFake(mainRequests) {
    const main = mainRequests()
    h.assert.ok(main.length > 0, 'the fake model server received the model requests')
    for (const request of main) {
      h.assert.equal(request.headers['x-api-key'], FAKE_KEY)
      h.assert.equal(request.headers.authorization, undefined, 'no other credential was sent')
    }
  }

  const coder = (runner = {}) =>
    h.role('coder', {
      description: 'Claude Code coder.',
      instructions: 'ROLE_MARKER_CC: follow the house rules.',
      runner: { cli: 'claude-code', permission: 'acceptEdits', ...runner },
    })

  h.case('answer reaches the parent; instructions, model and effort reach the model', async () => {
    const roles = [coder({ model: 'sonnet', effort: 'high' })]
    await withClaude({ steps: () => [{ text: 'CC_ANSWER_OK' }], roles }, async x => {
      const { childId } = await x.w.delegate({ role: 'coder', prompt: 'TASK_MARKER_CC please answer' })
      const notice = await x.w.notice(childId, 60_000)
      h.assert.match(notice, new RegExp(`Background subagent ${childId} finished`))
      h.assert.ok(notice.includes('CC_ANSWER_OK'), notice)
      assertOnlyFake(x.mainRequests)
      const request = x.mainRequests()[0].body
      const system = JSON.stringify(request.system)
      h.assert.ok(system.includes('ROLE_MARKER_CC'), 'instructions are in the system prompt')
      h.assert.ok(system.includes('Your role: coder.'), 'the role id is in the system prompt')
      const messages = JSON.stringify(request.messages)
      h.assert.ok(!messages.includes('ROLE_MARKER_CC'), 'instructions are not in the user message')
      h.assert.ok(messages.includes('TASK_MARKER_CC'), 'the task is the user message')
      h.assert.equal(request.model, 'claude-sonnet-5-5')
      h.assert.equal(request.output_config?.effort, 'high')
    })
  })

  h.case('read-only preset blocks writes (Write tool and shell redirection)', async () => {
    const roles = [
      h.role('reader', {
        description: 'Read-only reviewer.',
        readOnly: true,
        runner: { cli: 'claude-code', permission: 'read-only' },
      }),
    ]
    const steps = ws => [
      { tool_use: { name: 'Write', input: { file_path: join(ws, 'denied-write.txt'), content: 'x\n' } } },
      { tool_use: { name: 'Bash', input: { command: 'echo x > denied-bash.txt' } } },
      { text: 'RO_DONE' },
    ]
    await withClaude({ steps, roles, files: { 'README.md': 'hello\n' } }, async x => {
      const { childId } = await x.w.delegate({ role: 'reader', prompt: 'Please write two files.' })
      const notice = await x.w.notice(childId, 60_000)
      h.assert.ok(notice.includes('RO_DONE'), notice)
      h.assert.equal(existsSync(join(x.ws, 'denied-write.txt')), false)
      h.assert.equal(existsSync(join(x.ws, 'denied-bash.txt')), false)
      assertOnlyFake(x.mainRequests)
      h.assert.equal(x.mainRequests().length, 3, 'the scripted turns all ran')
      const tools = (x.mainRequests()[0].body.tools ?? []).map(t => t.name)
      h.assert.ok(!tools.includes('Write') && !tools.includes('Edit'), `no write tools offered: ${tools.join(',')}`)
    })
  })

  h.case('workspace-write default preset (acceptEdits) writes inside the workspace', async () => {
    const steps = ws => [
      { tool_use: { name: 'Write', input: { file_path: join(ws, 'out.txt'), content: 'written\n' } } },
      { text: 'WROTE_IT' },
    ]
    await withClaude({ steps, roles: [coder()] }, async x => {
      const { childId } = await x.w.delegate({ role: 'coder', prompt: 'Write out.txt' })
      const notice = await x.w.notice(childId, 60_000)
      h.assert.ok(notice.includes('WROTE_IT'), notice)
      h.assert.equal(readFileSync(join(x.ws, 'out.txt'), 'utf8'), 'written\n')
      assertOnlyFake(x.mainRequests)
    })
  })

  h.case('interrupt stops the run as aborted and leaves no process behind', async () => {
    await withClaude({ steps: () => [{ hold: true }], roles: [coder()] }, async x => {
      const { childId } = await x.w.delegate({ role: 'coder', prompt: 'Hang.' })
      await h.wait(() => x.mainRequests().length > 0, 30_000, 'the held model request')
      const pids = pidsWithEnv(x.baseUrlEntry)
      h.assert.ok(pids.length > 0, 'the claude process is running')
      x.w.interrupt(childId)
      const notice = await x.w.notice(childId, 30_000)
      h.assert.match(notice, /was stopped before it finished/)
      await h.wait(() => pidsWithEnv(x.baseUrlEntry).length === 0, 15_000, 'every claude process to exit')
      assertOnlyFake(x.mainRequests)
    })
  })

  h.case('a rejected API key yields a safe auth diagnostic', async () => {
    const steps = () => [
      { status: 401, error: { type: 'authentication_error', message: 'invalid x-api-key LEAK_MARKER_CC' } },
    ]
    await withClaude({ steps, roles: [coder()] }, async x => {
      const { childId } = await x.w.delegate({ role: 'coder', prompt: 'Answer.' })
      const notice = await x.w.notice(childId, 60_000)
      h.assert.match(notice, /failed before it finished/)
      h.assert.match(
        notice,
        /Subagent failure \(CLI: Claude Code; category: auth; exit code: 1;[^)]*http status: 401\)/,
      )
      h.assert.equal(notice.includes('LEAK_MARKER_CC'), false, 'provider text never reaches the parent')
      h.assert.equal(/Invalid API key|127\.0\.0\.1/.test(notice), false, 'CLI text never reaches the parent')
      assertOnlyFake(x.mainRequests)
    })
  })

  h.case('an overloaded upstream yields a service diagnostic', async () => {
    const steps = () => [{ sticky: true, status: 529, error: { type: 'overloaded_error', message: 'Overloaded' } }]
    await withClaude({ steps, roles: [coder()] }, async x => {
      const { childId } = await x.w.delegate({ role: 'coder', prompt: 'Answer.' })
      const notice = await x.w.notice(childId, 60_000)
      h.assert.match(notice, /category: service;[^)]*http status: 529/)
      assertOnlyFake(x.mainRequests)
    })
  })

  h.case('connection test reports the version and the model list', async () => {
    await withClaude({ steps: () => [], roles: [coder()] }, async x => {
      const service = await h.wait(() => x.w.ctx.get('rolesubagentsCli'), 5_000, 'the rolesubagentsCli service')
      const result = await service.probe({ cli: 'claude-code' }, new AbortController().signal)
      h.assert.equal(result.found, true)
      h.assert.match(result.version ?? '', /^\d+\.\d+\.\d+$/)
      h.assert.equal(result.auth, 'unknown')
      h.assert.ok(result.models.some(m => m.id === 'sonnet'))
      h.assert.equal(x.mainRequests().length, 0, 'the probe calls no model')
    })
  })

  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    h.case('bypassPermissions as root (without IS_SANDBOX) is a config failure', async () => {
      const roles = [coder({ permission: 'bypassPermissions' })]
      const world = { sandboxMode: 'danger-full-access' }
      await withClaude({ steps: () => [{ text: 'NEVER' }], roles, world }, async x => {
        const { childId } = await x.w.delegate({ role: 'coder', prompt: 'Answer.' })
        const notice = await x.w.notice(childId, 60_000)
        h.assert.match(notice, /category: config;[^)]*reason: bypass-refused-as-root/)
        h.assert.equal(x.mainRequests().length, 0, 'no model request was made')
      })
    })
  } else {
    h.skip('bypassPermissions as root (without IS_SANDBOX) is a config failure', 'not running as root')
  }
}
