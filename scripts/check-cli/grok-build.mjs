/** Real Grok headless stream with isolated native config and a localhost fake model. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { grokBuildAdapter } from '../../src/host/cli/grok-build/index.ts'
import { cases as hostConfinedCases } from './host-confined.mjs'
import { createOwnedEnvironmentScanner } from '../../tests/support/process-ownership.mjs'

export async function cases(h) {
  await hostConfinedCases(h)
  async function withGrok(body, sandboxMode = 'danger-full-access', missingKey = false, faultInjection = false) {
    const ws = h.workspace({ 'README.md': 'native fixture' })
    const home = h.workspace()
    const scratch = h.workspace()
    const log = join(scratch, 'requests.jsonl')
    writeFileSync(log, '')
    const fake = await h.server('tests/support/fake-models/grok-build.mjs', ['--log', log])
    const grokHome = h.workspace({
      'config.toml': [
        '[features]',
        'telemetry = false',
        'remote_fetch = false',
        'managed_config = false',
        'codebase_indexing = false',
        '[model.fake]',
        'model = "fake-model"',
        `base_url = "${fake.url}/v1"`,
        ...(missingKey ? [] : ['api_key = "dummy-native-test"']),
        'api_backend = "chat_completions"',
        'context_window = 128000',
      ].join('\n'),
    })
    const requests = () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    const events = []
    let injected = 0
    const observedAdapter = {
      ...grokBuildAdapter,
      createSession(...args) {
        const session = grokBuildAdapter.createSession(...args)
        return {
          ...session,
          line(text) {
            if (faultInjection) {
              session.line('{malformed fixture')
              session.line(JSON.stringify({ type: '__synthetic_unknown__', data: 'INJECTED_NOT_AN_ANSWER' }))
              injected++
            }
            events.push(text)
            session.line(text)
          },
        }
      },
    }
    const w = await h.world({
      cwd: ws,
      sandboxMode,
      adapters: id => (id === 'grok-build' ? observedAdapter : undefined),
      roles: [
        h.role('native-grok', {
          instructions: 'NATIVE_GROK_INSTRUCTIONS ✓',
          runner: { cli: 'grok-build', permission: 'native', model: 'fake' },
        }),
      ],
      env: {
        HOME: home,
        GROK_HOME: grokHome,
        GROK_MODELS_BASE_URL: `${fake.url}/v1`,
        XAI_API_KEY: missingKey ? '' : 'dummy-native-test',
        GROK_DISABLE_AUTOUPDATER: '1',
        GROK_TELEMETRY_ENABLED: 'false',
        DISABLE_TELEMETRY: '1',
        DISABLE_ERROR_REPORTING: '1',
        NO_PROXY: '127.0.0.1,localhost',
      },
      clis: {
        'grok-build': {
          executable: h.executable,
          envPassthrough: [
            'GROK_HOME',
            'GROK_MODELS_BASE_URL',
            'XAI_API_KEY',
            'GROK_DISABLE_AUTOUPDATER',
            'GROK_TELEMETRY_ENABLED',
            'DISABLE_TELEMETRY',
            'DISABLE_ERROR_REPORTING',
            'NO_PROXY',
          ],
        },
      },
    })
    try {
      const scan = createOwnedEnvironmentScanner()
      await body({ w, ws, requests, events, injected: () => injected, pids: () => scan(`GROK_HOME=${grokHome}`) })
    } finally {
      await w.close()
      fake.stop()
    }
  }
  h.case('native Grok returns final text and uses configured local model and role instructions', async () => {
    await withGrok(async ({ w, requests }) => {
      const { childId } = await w.delegate({ role: 'native-grok', prompt: 'GROK_TASK_MARKER say hello' })
      const notice = await w.notice(childId, 60000)
      h.assert.ok(notice.includes('GROK_FAKE_FINAL ✓'), notice)
      const req = requests().find(entry => entry.url === '/v1/chat/completions')
      h.assert.ok(req, 'local backend received request')
      h.assert.equal(req.authorization, 'Bearer dummy-native-test')
      h.assert.equal(req.body.model, 'fake-model')
      h.assert.ok(JSON.stringify(req.body.messages).includes('NATIVE_GROK_INSTRUCTIONS'))
      h.assert.ok(JSON.stringify(req.body.messages).includes('GROK_TASK_MARKER'))
    })
  })
  h.case('native Grok real stream tolerates synthetic unknown and malformed line injection', async () => {
    await withGrok(
      async ({ w, requests, injected }) => {
        const { childId } = await w.delegate({ role: 'native-grok', prompt: 'fault injection' })
        const notice = await w.notice(childId, 30000)
        h.assert.ok(injected() > 0, 'synthetic faults inserted before real stdout records')
        h.assert.ok(notice.includes('GROK_FAKE_FINAL ✓'), notice)
        h.assert.ok(!notice.includes('INJECTED_NOT_AN_ANSWER'), notice)
        h.assert.ok(requests().some(r => r.url === '/v1/chat/completions'))
      },
      'danger-full-access',
      false,
      true,
    )
  })
  h.case('native Grok tool loop keeps only final response', async () => {
    await withGrok(async ({ w, requests }) => {
      const { childId } = await w.delegate({ role: 'native-grok', prompt: '[[tool:read_file {"path":"README.md"}]]' })
      const notice = await w.notice(childId, 60000)
      h.assert.ok(notice.includes('GROK_FAKE_FINAL ✓ after tool'), notice)
      h.assert.ok(!notice.includes('Intermediate commentary.'), notice)
      const calls = requests().filter(entry => entry.url === '/v1/chat/completions')
      h.assert.ok(calls.length >= 2)
      h.assert.ok(calls.some(entry => entry.body.messages.some(message => message.role === 'tool')))
    })
  })
  h.case('native Grok max token limit is not success', async () => {
    await withGrok(async ({ w, events }) => {
      const { childId } = await w.delegate({ role: 'native-grok', prompt: '[[length]]' })
      h.assert.match(await w.notice(childId, 30000), /max.tokens/i, events.join('\n'))
    })
  })
  h.case('native Grok parallel runs settle independently', async () => {
    await withGrok(async ({ w }) => {
      const children = await Promise.all([
        w.delegate({ role: 'native-grok', prompt: 'first' }),
        w.delegate({ role: 'native-grok', prompt: 'second' }),
      ])
      h.assert.notEqual(children[0].childId, children[1].childId)
      for (const child of children) h.assert.ok((await w.notice(child.childId, 30000)).includes('GROK_FAKE_FINAL ✓'))
    })
  })
  h.case('native Grok provider errors cannot be mistaken for success', async () => {
    await withGrok(async ({ w }) => {
      const { childId } = await w.delegate({ role: 'native-grok', prompt: '[[http:401]]' })
      const notice = await w.notice(childId, 60000)
      h.assert.match(notice, /auth/)
      h.assert.ok(!notice.includes('dummy-native-test'))
    })
  })
  h.case('native Grok wall-clock timeout terminates streaming process and owned descendants', async () => {
    await withGrok(async ({ w, ws, requests, pids }) => {
      const run = await h.engine.startExternalRun(
        {
          adapter: grokBuildAdapter,
          input: {
            runner: { cli: 'grok-build', permission: 'native', model: 'fake' },
            preset: 'native',
            access: 'full-access',
            instructions: '',
            task: '[[slow]]',
            cwd: ws,
          },
          settings: {
            executable: h.executable,
            envPassthrough: [
              'GROK_HOME',
              'GROK_MODELS_BASE_URL',
              'XAI_API_KEY',
              'GROK_DISABLE_AUTOUPDATER',
              'GROK_TELEMETRY_ENABLED',
              'DISABLE_TELEMETRY',
              'DISABLE_ERROR_REPORTING',
              'NO_PROXY',
            ],
          },
          timeoutMs: 2000,
          signal: new AbortController().signal,
        },
        h.engineDeps(w),
      )
      await h.wait(() => pids().length > 0, 1500, 'owned Grok process before timeout')
      const result = await run.result
      h.assert.match(result.diagnostic ?? '', /timeout/)
      await h.wait(() => pids().length === 0, 5000, 'Grok descendants terminated after timeout')
      h.assert.ok(
        requests().some(entry => entry.url === '/v1/chat/completions'),
        'timeout exercised inference stream',
      )
    })
  })
  h.case('restricted parent refuses native Grok before backend startup', async () => {
    await withGrok(async ({ w, requests }) => {
      await h.assert.rejects(
        () => w.delegate({ role: 'native-grok', prompt: 'must not start' }),
        /native|support|full.access/i,
      )
      h.assert.equal(requests().length, 0)
    }, 'workspace-write')
  })
  h.case('native Grok missing key is diagnosed before inference', async () => {
    await withGrok(
      async ({ w, requests }) => {
        const { childId } = await w.delegate({ role: 'native-grok', prompt: 'no key' })
        h.assert.match(await w.notice(childId, 30000), /auth|config/)
        h.assert.equal(requests().length, 0)
      },
      'danger-full-access',
      true,
    )
  })
  h.case('native Grok cancellation stops streaming and owned descendants', async () => {
    await withGrok(async ({ w, requests, pids }) => {
      const { childId } = await w.delegate({ role: 'native-grok', prompt: '[[slow]]' })
      await h.wait(() => requests().some(entry => entry.url === '/v1/chat/completions'), 30000, 'Grok fake request')
      h.assert.ok(pids().length > 0, 'owned Grok process observed before interrupt')
      await w.interrupt(childId)
      const notice = await w.notice(childId, 15000)
      h.assert.match(notice, /abort|cancel|interrupt|stopped before/i)
      await h.wait(() => pids().length === 0, 5000, 'Grok descendants terminated after cancel')
    })
  })
}
