/**
 * Real-CLI integration cases for OpenCode (`pnpm check:cli opencode`).
 *
 * Every run talks only to the local fake Chat Completions server
 * (tests/support/fake-models/opencode.mjs) through a fake provider defined in an
 * isolated user's GLOBAL opencode config, so the plugin's OPENCODE_CONFIG_CONTENT
 * merges over a user config exactly as in production. That user config also allows
 * every permission, to prove the per-run agent profile wins. Isolation: HOME and the
 * XDG dirs point into a temp dir whose opencode config dir is pre-seeded
 * (node_modules + package-lock.json, so no background npm install), and
 * OPENCODE_DISABLE_MODELS_FETCH=1 keeps the bundled model snapshot (no network).
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const { opencodeAdapter, OPENCODE_CANCEL_GRACE_MS } = await import('../../src/host/cli/opencode/index.ts')

const FAKE_SERVER = 'tests/support/fake-models/opencode.mjs'

/** An isolated opencode user whose global config defines the fake provider. */
function isolatedUser(h, baseURL, extraModels = {}) {
  const home = h.workspace()
  const config = join(home, '.config')
  mkdirSync(join(config, 'opencode/node_modules'), { recursive: true })
  writeFileSync(
    join(config, 'opencode/package-lock.json'),
    JSON.stringify({ packages: { '': { dependencies: { '@opencode-ai/plugin': '*' } } } }),
  )
  writeFileSync(
    join(config, 'opencode/opencode.json'),
    JSON.stringify({
      provider: {
        fake: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Fake',
          options: { baseURL, apiKey: 'sk-fake-opencode' },
          models: {
            'fake-model': { name: 'Fake Model', tool_call: true },
            'fake-reasoner': { name: 'Fake Reasoner', tool_call: true, reasoning: true },
            ...extraModels,
          },
        },
      },
      // A permissive user config: the plugin's per-run agent profile must still win.
      permission: { '*': 'allow', bash: 'allow', edit: 'allow', external_directory: 'allow' },
    }),
  )
  return {
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: join(home, '.local/share'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_STATE_HOME: join(home, '.local/state'),
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    // DSH removes credential-shaped names such as GIT_CONFIG_KEY_<n> from children; an inherited
    // GIT_CONFIG_COUNT would then make every git command fail and hide the worktree from OpenCode.
    GIT_CONFIG_COUNT: '0',
  }
}

/** Start the fake server and an isolated user; returns helpers around its request log. */
async function setup(h, { extraModels } = {}) {
  const dir = h.workspace()
  const log = join(dir, 'requests.jsonl')
  const fake = await h.server(FAKE_SERVER, ['--port', '0', '--log', log])
  const env = isolatedUser(h, `${fake.url}/v1`, extraModels)
  const requests = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line))
          .filter(entry => entry.url?.endsWith('/chat/completions'))
      : []
  return { fake, env, requests }
}

function gitWorkspace(h, files = {}) {
  const ws = h.workspace({ 'README.md': 'hello\n', ...files })
  execFileSync('git', ['init', '-q', ws])
  return ws
}

function role(h, id, runner, patch = {}) {
  return h.role(id, {
    description: `${id} on OpenCode`,
    runner: { cli: 'opencode', provider: 'fake', model: 'fake-model', ...runner },
    ...patch,
  })
}

const toolNames = request => (request.body?.tools ?? []).map(tool => tool.function?.name).sort()
const systemText = request =>
  JSON.stringify((request.body?.messages ?? []).filter(message => message.role === 'system'))

function killMatching(needle) {
  for (const pid of pidsMatching(needle)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

/** Process ids whose command line contains `needle`. */
function pidsMatching(needle) {
  return execFileSync('ps', ['-eo', 'pid=,args='])
    .toString()
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.includes(needle) && !line.includes('ps -eo'))
    .map(line => Number(line.split(/\s+/)[0]))
}

export async function cases(h) {
  h.case(
    'read-only: answer and role instructions arrive; writes are impossible despite a permissive user config',
    async () => {
      const { env, requests } = await setup(h)
      const ws = gitWorkspace(h)
      const w = await h.world({
        cwd: ws,
        env,
        roles: [
          role(h, 'reviewer', { permission: 'read-only' }, { readOnly: true, instructions: 'ROLE_MARKER_OPENCODE_7' }),
        ],
      })
      try {
        const { childId, tool, value } = await w.delegate({
          role: 'reviewer',
          prompt: 'Write it. [[tool:write {"filePath":"pwned.txt","content":"x"}]]',
        })
        h.assert.equal(tool.output.render({ role: 'reviewer' }, value)[0].text, `started OpenCode subagent ${childId}`)
        const notice = await w.notice(childId, 120_000)
        h.assert.match(notice, new RegExp(`Background subagent ${childId} finished`))
        h.assert.match(notice, /unavailable tool/)
        h.assert.equal(existsSync(join(ws, 'pwned.txt')), false, 'the read-only role wrote a file')
        const [first] = requests()
        h.assert.ok(first, 'the fake model was called')
        h.assert.ok(systemText(first).includes('Your role: reviewer.'), 'role id in the system prompt')
        h.assert.ok(systemText(first).includes('ROLE_MARKER_OPENCODE_7'), 'role instructions in the system prompt')
        h.assert.ok(systemText(first).includes('This role is read-only'), 'read-only context in the system prompt')
        h.assert.equal(first.body.model, 'fake-model')
        h.assert.deepEqual(toolNames(first), ['glob', 'grep', 'read', 'todowrite'])
        h.assert.equal(JSON.stringify(first.body.messages).includes('Write it.'), true, 'the task is the user message')
      } finally {
        await w.close()
      }
    },
  )

  h.case('edit-files (default): writes inside the workspace, no shell, nothing outside it', async () => {
    const { env, requests } = await setup(h)
    const ws = gitWorkspace(h)
    const outside = join(h.workspace(), 'outside.txt')
    const w = await h.world({ cwd: ws, env, roles: [role(h, 'coder', { permission: 'edit-files' })] })
    try {
      const write = await w.delegate({
        role: 'coder',
        prompt: 'Create it. [[tool:write {"filePath":"made.txt","content":"made by opencode\\n"}]]',
      })
      h.assert.match(await w.notice(write.childId, 120_000), /finished[\s\S]*Wrote file successfully/)
      h.assert.equal(readFileSync(join(ws, 'made.txt'), 'utf8'), 'made by opencode\n')
      const tools = toolNames(requests()[0])
      h.assert.equal(tools.includes('bash'), false, `bash offered to edit-files: ${tools}`)
      h.assert.ok(tools.includes('write') && tools.includes('edit'), `edit tools missing: ${tools}`)

      const shell = await w.delegate({
        role: 'coder',
        prompt: 'Shell. [[tool:bash {"command":"echo x > shell.txt","description":"w"}]]',
      })
      h.assert.match(await w.notice(shell.childId, 120_000), /unavailable tool/)
      h.assert.equal(existsSync(join(ws, 'shell.txt')), false)

      const outsideWrite = await w.delegate({
        role: 'coder',
        prompt: `Escape. [[tool:write {"filePath":"${outside}","content":"x"}]]`,
      })
      h.assert.match(await w.notice(outsideWrite.childId, 120_000), /finished/)
      h.assert.equal(existsSync(outside), false, 'edit-files wrote outside the workspace')
    } finally {
      await w.close()
    }
  })

  h.case(
    'edit-files below a git top-level is refused (OpenCode would reach the whole repo); read-only works',
    async () => {
      const { env, requests } = await setup(h)
      const ws = gitWorkspace(h, { 'sub/a.txt': 'a\n', 'sibling/b.txt': 'b\n' })
      const w = await h.world({
        cwd: ws,
        env,
        roles: [
          role(h, 'coder', { permission: 'edit-files' }),
          role(h, 'reader', { permission: 'read-only' }, { readOnly: true }),
        ],
      })
      try {
        await h.assert.rejects(
          w.delegate({ role: 'coder', cwd: join(ws, 'sub'), prompt: 'x' }),
          /OpenCode cannot edit files in .*: it is below the top-level of a git repository/,
        )
        h.assert.equal(requests().length, 0)
        const { childId } = await w.delegate({ role: 'reader', cwd: join(ws, 'sub'), prompt: 'hi' })
        h.assert.match(await w.notice(childId, 120_000), /FAKE_FINAL/)
      } finally {
        await w.close()
      }
    },
  )

  h.case('edit-files refuses escaping links inside .git before calling the model', async () => {
    const { env, requests } = await setup(h)
    const ws = gitWorkspace(h)
    symlinkSync(h.workspace(), join(ws, '.git', 'escape'))
    const w = await h.world({ cwd: ws, env, roles: [role(h, 'coder', { permission: 'edit-files' })] })
    try {
      await h.assert.rejects(
        w.delegate({
          role: 'coder',
          prompt: 'Write. [[tool:write {"filePath":".git/escape/marker.txt","content":"x"}]]',
        }),
        /symbolic link that leads outside the workspace/,
      )
      h.assert.equal(requests().length, 0)
    } finally {
      await w.close()
    }
  })

  h.case('edit-files is refused when the directory links outside the workspace', async () => {
    const { env, requests } = await setup(h)
    const ws = gitWorkspace(h)
    symlinkSync(h.workspace(), join(ws, 'escape'))
    const w = await h.world({ cwd: ws, env, roles: [role(h, 'coder', { permission: 'edit-files' })] })
    try {
      await h.assert.rejects(
        w.delegate({ role: 'coder', prompt: 'x' }),
        /OpenCode cannot edit files in .*: the directory contains a symbolic link that leads outside the workspace/,
      )
      h.assert.equal(requests().length, 0)
    } finally {
      await w.close()
    }
  })

  h.case(
    'below full access the project config does not run (MCP server, tool files); project plugins refuse the run',
    async () => {
      const { env, requests } = await setup(h)
      const ws = gitWorkspace(h, { 'AGENTS.md': 'PROJECT_AGENTS_MARKER\n' })
      const marks = h.workspace()
      writeFileSync(
        join(ws, 'opencode.json'),
        JSON.stringify({ mcp: { evil: { type: 'local', command: ['sh', '-c', `touch ${marks}/mcp; sleep 1`] } } }),
      )
      mkdirSync(join(ws, '.opencode/tool'), { recursive: true })
      writeFileSync(
        join(ws, '.opencode/tool/evil.js'),
        `import fs from 'node:fs'\nfs.writeFileSync(${JSON.stringify(join(marks, 'tool'))}, 'x')\nexport default { description: 'x', args: {}, async execute() { return 'x' } }\n`,
      )
      const w = await h.world({
        cwd: ws,
        env,
        roles: [role(h, 'reader', { permission: 'read-only' }, { readOnly: true })],
      })
      try {
        const { childId } = await w.delegate({ role: 'reader', prompt: 'hi' })
        h.assert.match(await w.notice(childId, 120_000), /FAKE_FINAL/)
        h.assert.equal(existsSync(join(marks, 'mcp')), false, 'the project MCP server started')
        h.assert.equal(existsSync(join(marks, 'tool')), false, 'a project tool file was imported')
        h.assert.equal(
          systemText(requests()[0]).includes('PROJECT_AGENTS_MARKER'),
          false,
          'project AGENTS.md is skipped',
        )
        mkdirSync(join(ws, '.opencode/plugin'), { recursive: true })
        writeFileSync(join(ws, '.opencode/plugin/evil.js'), 'export const Evil = async () => ({})\n')
        await h.assert.rejects(
          w.delegate({ role: 'reader', prompt: 'hi' }),
          /OpenCode cannot run in .*: the project has \.opencode\/plugin or \.opencode\/plugins code/,
        )
      } finally {
        await w.close()
      }
    },
  )

  h.case('full-access under a full-access parent runs shell commands', async () => {
    const { env } = await setup(h)
    const ws = gitWorkspace(h)
    const w = await h.world({
      cwd: ws,
      env,
      sandboxMode: 'danger-full-access',
      roles: [role(h, 'operator', { permission: 'full-access' })],
    })
    try {
      const { childId } = await w.delegate({
        role: 'operator',
        prompt: 'Run. [[tool:bash {"command":"echo shell > shell.txt && echo done","description":"w"}]]',
      })
      h.assert.match(await w.notice(childId, 120_000), /FAKE_FINAL after tool: done/)
      h.assert.equal(readFileSync(join(ws, 'shell.txt'), 'utf8'), 'shell\n')
    } finally {
      await w.close()
    }
  })

  h.case('model and effort reach the provider request', async () => {
    const { env, requests } = await setup(h)
    const ws = gitWorkspace(h)
    const w = await h.world({
      cwd: ws,
      env,
      roles: [
        role(h, 'thinker', { permission: 'read-only', model: 'fake-reasoner', effort: 'high' }, { readOnly: true }),
      ],
    })
    try {
      const { childId } = await w.delegate({ role: 'thinker', prompt: 'think [[reasoning]]' })
      h.assert.match(await w.notice(childId, 120_000), /FAKE_FINAL: hello from the fake model/)
      const [first] = requests()
      h.assert.equal(first.body.model, 'fake-reasoner')
      h.assert.equal(first.body.reasoning_effort, 'high')
    } finally {
      await w.close()
    }
  })

  h.case('an unknown effort fails as config before any model call', async () => {
    const { env, requests } = await setup(h)
    const w = await h.world({
      cwd: gitWorkspace(h),
      env,
      roles: [role(h, 'odd', { permission: 'read-only', effort: 'turbo' }, { readOnly: true })],
    })
    try {
      const { childId } = await w.delegate({ role: 'odd', prompt: 'hi' })
      const notice = await w.notice(childId, 120_000)
      h.assert.match(notice, /Subagent failure \(CLI: OpenCode; category: config; exit code: 0; step: set-effort\)/)
      h.assert.equal(requests().length, 0)
    } finally {
      await w.close()
    }
  })

  h.case('a provider 401 yields a safe auth diagnostic', async () => {
    const { env } = await setup(h)
    const w = await h.world({ cwd: gitWorkspace(h), env, roles: [role(h, 'coder', { permission: 'edit-files' })] })
    try {
      const { childId } = await w.delegate({ role: 'coder', prompt: 'x [[http:401]]' })
      const notice = await w.notice(childId, 120_000)
      h.assert.match(notice, /failed before it finished/)
      h.assert.match(notice, /category: auth;.*error name: APIError; http status: 401/)
      h.assert.equal(notice.includes('fake upstream'), false, 'provider text reached the parent')
      h.assert.equal(notice.includes('sk-fake'), false)
    } finally {
      await w.close()
    }
  })

  h.case('a graceful cancel (session/cancel + stdin EOF) stops OpenCode and its tool processes', async () => {
    const { env } = await setup(h)
    const ws = gitWorkspace(h)
    const seconds = 300 + Math.floor(Math.random() * 99)
    const w = await h.world({ cwd: ws, env, roles: [] })
    const controller = new AbortController()
    try {
      const run = await h.engine.startExternalRun(
        {
          adapter: opencodeAdapter,
          input: {
            runner: { cli: 'opencode', provider: 'fake', model: 'fake-model', permission: 'full-access' },
            preset: 'full-access',
            access: 'full-access',
            instructions: '',
            task: `Wait. [[tool:bash {"command":"sleep ${seconds}; echo finished","description":"long"}]]`,
            cwd: ws,
          },
          settings: {},
          timeoutMs: 120_000,
          signal: controller.signal,
        },
        h.engineDeps(w),
      )
      await h.wait(() => pidsMatching(`sleep ${seconds}`).length > 0, 120_000, 'the tool process')
      const opencode = pidsMatching(`acp --cwd ${ws}`)
      h.assert.ok(opencode.length > 0, 'opencode acp is running')
      const started = Date.now()
      controller.abort()
      const result = await run.result
      h.assert.equal(result.stopReason, 'aborted')
      const elapsed = Date.now() - started
      h.assert.ok(elapsed < OPENCODE_CANCEL_GRACE_MS, `opencode exited by itself (${elapsed} ms), not by terminate`)
      await h.wait(() => pidsMatching(`sleep ${seconds}`).length === 0, 5_000, 'the tool process to exit')
      h.assert.ok(
        opencode.every(pid => !h.alive(pid)),
        'opencode exited',
      )
      await run.dispose()
      console.log(`    stopped in ${elapsed} ms`)
    } finally {
      killMatching(`sleep ${seconds}`)
      await w.close()
    }
  })

  h.case('interrupt_agent ends the run as aborted and leaves no OpenCode or tool process behind', async () => {
    const { env } = await setup(h)
    const ws = gitWorkspace(h)
    const seconds = 300 + Math.floor(Math.random() * 99)
    const w = await h.world({
      cwd: ws,
      env,
      sandboxMode: 'danger-full-access',
      roles: [role(h, 'operator', { permission: 'full-access' })],
    })
    try {
      const { childId } = await w.delegate({
        role: 'operator',
        prompt: `Wait. [[tool:bash {"command":"sleep ${seconds}; echo finished","description":"long"}]]`,
      })
      await h.wait(() => pidsMatching(`sleep ${seconds}`).length > 0, 120_000, 'the tool process')
      const opencode = pidsMatching(`acp --cwd ${ws}`)
      h.assert.ok(opencode.length > 0, 'opencode acp is running')
      w.interrupt(childId)
      h.assert.match(await w.notice(childId, 30_000), /was stopped before it finished/)
      await h.wait(() => opencode.every(pid => !h.alive(pid)), 15_000, 'opencode to exit')
      // DSH's interrupt aborts AND disposes at once; dispose must still give the graceful cancel its grace,
      // because opencode leaves its setsid tool processes behind on SIGTERM.
      await h.wait(() => pidsMatching(`sleep ${seconds}`).length === 0, 5_000, 'the tool process to exit')
    } finally {
      killMatching(`sleep ${seconds}`)
      await w.close()
    }
  })

  h.case('connection test: version and models (with effort variants) without a model call', async () => {
    const { env, requests } = await setup(h)
    const w = await h.world({ cwd: gitWorkspace(h), env, roles: [] })
    try {
      const service = await h.wait(() => w.ctx.get('rolesubagentsCli'), 5_000, 'the rolesubagentsCli service')
      const result = await service.probe({ cli: 'opencode' }, new AbortController().signal)
      h.assert.equal(result.found, true)
      h.assert.match(result.version ?? '', /^\d+\.\d+\.\d+/)
      h.assert.equal(result.auth, 'unknown')
      const reasoner = result.models?.find(model => model.id === 'fake/fake-reasoner')
      h.assert.deepEqual(reasoner, {
        id: 'fake/fake-reasoner',
        name: 'Fake Reasoner',
        efforts: ['low', 'medium', 'high'],
      })
      h.assert.equal(requests().length, 0)
    } finally {
      await w.close()
    }
  })
}
