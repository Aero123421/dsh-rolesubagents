/** Real Pi RPC against a localhost fake, with disposable native config and no real credentials. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { piAdapter } from '../../src/host/cli/pi/index.ts'
import { join } from 'node:path'
import { createOwnedEnvironmentScanner } from '../../tests/support/process-ownership.mjs'

export async function cases(h) {
  async function withPi(
    body,
    { extension = '', patch = {}, sandboxMode = 'danger-full-access', missingKey = false, faultInjection = false } = {},
  ) {
    const ws = h.workspace({ 'README.md': 'native fixture' })
    const home = h.workspace()
    const scratch = h.workspace()
    const log = join(scratch, 'requests.jsonl')
    writeFileSync(log, '')
    const fake = await h.server('tests/support/fake-models/pi.mjs', ['--log', log])
    const agent = h.workspace({
      'models.json': JSON.stringify({
        providers: {
          fake: {
            baseUrl: `${fake.url}/v1`,
            api: 'openai-completions',
            ...(missingKey ? {} : { apiKey: 'dummy-native-test' }),
            models: [
              {
                id: 'fake-model',
                name: 'Fake',
                reasoning: true,
                input: ['text'],
                contextWindow: 128000,
                maxTokens: 8192,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
      'settings.json': JSON.stringify({
        defaultProvider: 'fake',
        defaultModel: 'fake-model',
        retry: { enabled: false },
        compaction: { enabled: false },
      }),
      ...(extension ? { 'extensions/fixture.ts': extension } : {}),
    })
    const requests = () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    let injected = 0
    const observedAdapter = {
      ...piAdapter,
      createSession(...args) {
        const session = piAdapter.createSession(...args)
        return {
          start: io => session.start(io),
          cancel: () => session.cancel?.(),
          finish: exit => session.finish(exit),
          line(text) {
            if (faultInjection) {
              session.line('{malformed fixture')
              session.line(JSON.stringify({ type: '__synthetic_unknown__', data: 'INJECTED_NOT_AN_ANSWER' }))
              injected++
            }
            session.line(text)
          },
        }
      },
    }
    const w = await h.world({
      cwd: ws,
      adapters: id => (id === 'pi' ? observedAdapter : undefined),
      sandboxMode,
      roles: [
        h.role('native-pi', {
          instructions: 'NATIVE_PI_INSTRUCTIONS ✓',
          runner: { cli: 'pi', permission: 'native', model: 'fake/fake-model', ...patch },
        }),
      ],
      env: {
        HOME: home,
        PI_CODING_AGENT_DIR: agent,
        PI_OFFLINE: '1',
        PI_SKIP_VERSION_CHECK: '1',
        NO_PROXY: '127.0.0.1,localhost',
      },
      clis: {
        pi: {
          executable: h.executable,
          envPassthrough: ['PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'NO_PROXY'],
        },
      },
    })
    try {
      const scan = createOwnedEnvironmentScanner()
      await body({ w, ws, requests, injected: () => injected, pids: () => scan(`PI_CODING_AGENT_DIR=${agent}`) })
    } finally {
      await w.close()
      fake.stop()
    }
  }
  h.case('native Pi returns final text and preserves instructions and configured provider', async () => {
    await withPi(async ({ w, requests }) => {
      const { childId } = await w.delegate({ role: 'native-pi', prompt: 'PI_TASK_MARKER say hello' })
      const notice = await w.notice(childId, 60000)
      h.assert.ok(notice.includes('PI_FAKE_FINAL ✓'), notice)
      const req = requests().find(entry => entry.url === '/v1/chat/completions')
      h.assert.ok(req, 'local backend received request')
      h.assert.equal(req.authorization, 'Bearer dummy-native-test')
      h.assert.equal(req.body.model, 'fake-model')
      h.assert.ok(JSON.stringify(req.body.messages).includes('NATIVE_PI_INSTRUCTIONS'))
      h.assert.ok(JSON.stringify(req.body.messages).includes('PI_TASK_MARKER'))
    })
  })
  h.case('native Pi real stream tolerates synthetic unknown and malformed line injection', async () => {
    await withPi(
      async ({ w, requests, injected }) => {
        const { childId } = await w.delegate({ role: 'native-pi', prompt: 'fault injection' })
        const notice = await w.notice(childId, 30000)
        h.assert.ok(injected() > 0, 'synthetic faults inserted before real stdout records')
        h.assert.ok(notice.includes('PI_FAKE_FINAL ✓'), notice)
        h.assert.ok(!notice.includes('INJECTED_NOT_AN_ANSWER'), notice)
        h.assert.ok(requests().some(r => r.url === '/v1/chat/completions'))
      },
      { faultInjection: true },
    )
  })
  h.case('native Pi retains extensions and handles prompt disposition handled', async () => {
    await withPi(
      async ({ w, requests }) => {
        const { childId } = await w.delegate({ role: 'native-pi', prompt: 'intercept-me' })
        const notice = await w.notice(childId, 30000)
        h.assert.match(notice, /prompt-handled/)
        h.assert.equal(requests().filter(entry => entry.url === '/v1/chat/completions').length, 0)
      },
      { extension: 'export default function(pi) { pi.on("input", async () => ({ action: "handled" })); }' },
    )
  })
  h.case('native Pi tool loop keeps only final answer', async () => {
    await withPi(async ({ w, requests }) => {
      const { childId } = await w.delegate({ role: 'native-pi', prompt: '[[tool:read {"path":"README.md"}]]' })
      const notice = await w.notice(childId, 60000)
      h.assert.ok(notice.includes('PI_FAKE_FINAL ✓ after tool'), notice)
      h.assert.ok(!notice.includes('Intermediate commentary.'), notice)
      h.assert.equal(requests().filter(entry => entry.url === '/v1/chat/completions').length, 2)
    })
  })
  h.case('native Pi max token limit is not success', async () => {
    await withPi(async ({ w }) => {
      const { childId } = await w.delegate({ role: 'native-pi', prompt: '[[length]]' })
      h.assert.match(await w.notice(childId, 30000), /max.tokens/i)
    })
  })
  h.case('native Pi extension dialogs are denied without approving', async () => {
    await withPi(
      async ({ w }) => {
        const { childId } = await w.delegate({ role: 'native-pi', prompt: 'dialog-test' })
        h.assert.match(await w.notice(childId, 30000), /permission|interactive-request/)
      },
      {
        extension:
          'export default function(pi) { pi.on("before_agent_start", async (_event, ctx) => { const yes = await ctx.ui.confirm("Fixture", "Approve?"); if (yes) throw new Error("must not approve"); }); }',
      },
    )
  })
  h.case('native Pi parallel runs settle independently', async () => {
    await withPi(async ({ w }) => {
      const children = await Promise.all([
        w.delegate({ role: 'native-pi', prompt: 'first' }),
        w.delegate({ role: 'native-pi', prompt: 'second' }),
      ])
      h.assert.notEqual(children[0].childId, children[1].childId)
      for (const child of children) h.assert.ok((await w.notice(child.childId, 30000)).includes('PI_FAKE_FINAL ✓'))
    })
  })
  h.case('native Pi reports provider errors without leaking raw output', async () => {
    await withPi(async ({ w }) => {
      const { childId } = await w.delegate({ role: 'native-pi', prompt: '[[http:401]]' })
      const notice = await w.notice(childId, 60000)
      h.assert.match(notice, /auth/)
      h.assert.ok(!notice.includes('dummy-native-test'))
    })
  })
  h.case('native Pi wall-clock timeout terminates streaming process and owned descendants', async () => {
    await withPi(async ({ w, ws, requests, pids }) => {
      const run = await h.engine.startExternalRun(
        {
          adapter: piAdapter,
          input: {
            runner: { cli: 'pi', permission: 'native', model: 'fake/fake-model' },
            preset: 'native',
            access: 'full-access',
            instructions: '',
            task: '[[slow]]',
            cwd: ws,
          },
          settings: {
            executable: h.executable,
            envPassthrough: ['PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'NO_PROXY'],
          },
          timeoutMs: 2000,
          signal: new AbortController().signal,
        },
        h.engineDeps(w),
      )
      await h.wait(() => pids().length > 0, 1500, 'owned Pi process before timeout')
      const result = await run.result
      h.assert.match(result.diagnostic ?? '', /timeout/)
      await h.wait(() => pids().length === 0, 5000, 'Pi descendants terminated after timeout')
      h.assert.ok(
        requests().some(entry => entry.url === '/v1/chat/completions'),
        'timeout exercised inference stream',
      )
    })
  })
  h.case('restricted parent refuses native Pi before extension startup', async () => {
    await withPi(
      async ({ w, ws, requests }) => {
        await h.assert.rejects(
          () => w.delegate({ role: 'native-pi', prompt: 'must not start' }),
          /native|support|full.access/i,
        )
        h.assert.equal(existsSync(join(ws, 'extension-ran.txt')), false)
        h.assert.equal(requests().length, 0)
      },
      {
        sandboxMode: 'workspace-write',
        extension:
          'import { writeFileSync } from "node:fs"; export default function(){ writeFileSync("extension-ran.txt", "ran"); }',
      },
    )
  })
  h.case('native Pi missing key is diagnosed before inference', async () => {
    await withPi(
      async ({ w, requests }) => {
        const { childId } = await w.delegate({ role: 'native-pi', prompt: 'no key' })
        h.assert.match(await w.notice(childId, 30000), /auth|config/)
        h.assert.equal(requests().length, 0)
      },
      { missingKey: true },
    )
  })
  h.case('native Pi cancellation stops streaming and owned descendants', async () => {
    await withPi(async ({ w, requests, pids }) => {
      const { childId } = await w.delegate({ role: 'native-pi', prompt: '[[slow]]' })
      await h.wait(() => requests().some(entry => entry.url === '/v1/chat/completions'), 30000, 'Pi fake request')
      h.assert.ok(pids().length > 0, 'owned Pi process observed before interrupt')
      await w.interrupt(childId)
      const notice = await w.notice(childId, 15000)
      h.assert.match(notice, /abort|cancel|interrupt|stopped before/i)
      await h.wait(() => pids().length === 0, 5000, 'Pi descendants terminated after cancel')
    })
  })
}
