/** Real CLI + installed DSH confinement checks for ordinary workspace-write parents. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { grokBuildAdapter } from '../../src/host/cli/grok-build/index.ts'
import { piAdapter } from '../../src/host/cli/pi/index.ts'
import { createOwnedEnvironmentScanner } from '../../tests/support/process-ownership.mjs'

const KEY = 'dummy-host-confined-test'
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex')

export async function cases(h) {
  if (h.cli !== 'grok-build' && h.cli !== 'pi') throw new Error('Host-confined cases require Grok or Pi')
  const grok = h.cli === 'grok-build'
  const label = grok ? 'Grok' : 'Pi'
  const adapter = grok ? grokBuildAdapter : piAdapter
  const roleId = 'host-confined-worker'
  const model = grok ? 'fake' : 'fake/fake-model'
  const final = grok ? 'GROK_FAKE_FINAL' : 'PI_FAKE_FINAL'
  const tool = (name, input) => `[[tool:${name} ${JSON.stringify(input)}]]`
  const read = path => tool(grok ? 'read_file' : 'read', grok ? { target_file: path } : { path })
  const write = (path, content) => tool('write', grok ? { file_path: path, content } : { path, content })

  async function withFixture(body, { hostSandbox = true, managedProfile, extension = false } = {}) {
    // /var/tmp is NOT the DSH Landlock workspace-write backend's /tmp exception.
    const ws = h.workspace({ 'README.md': 'HOST_CONFINED_READ_OK\n' }, { outsideTmp: true })
    const outside = h.workspace({ 'sentinel.txt': 'OUTSIDE_UNCHANGED\n' }, { outsideTmp: true })
    const home = h.workspace({}, { outsideTmp: true })
    const scratch = h.workspace()
    const log = join(scratch, 'requests.jsonl')
    writeFileSync(log, '')
    const fake = await h.server(`tests/support/fake-models/${h.cli}.mjs`, ['--log', log])
    const source = h.workspace({}, { outsideTmp: true })
    const settings = {
      defaultProvider: 'fake',
      defaultModel: 'fake-model',
      retry: { enabled: false },
      compaction: { enabled: false },
    }
    if (extension) {
      const extensionFile = join(source, 'fixture-extension.ts')
      writeFileSync(
        extensionFile,
        `import { writeFileSync, readFileSync } from 'node:fs';\nimport { join } from 'node:path';\nexport default function() {\n let denied;\n try { writeFileSync(${JSON.stringify(join(outside, 'extension-outside.txt'))}, 'EXTENSION_ESCAPE'); denied = 'WRITE_SUCCEEDED'; } catch (error) { denied = String(error.code); }\n const auth = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR, 'auth.json'), 'utf8'));\n writeFileSync(${JSON.stringify(join(ws, 'extension-proof.json'))}, JSON.stringify({ executed: true, denied, authProviders: Object.keys(auth), hasOAuth: Object.values(auth).some(value => value.type === 'oauth') }));\n}\n`,
      )
      settings.extensions = [extensionFile]
    }
    if (grok) {
      writeFileSync(
        join(source, 'config.toml'),
        [
          '[features]',
          'telemetry = false',
          'remote_fetch = false',
          'managed_config = false',
          'codebase_indexing = false',
          '[model.fake]',
          'model = "fake-model"',
          `base_url = "${fake.url}/v1"`,
          `api_key = "${KEY}"`,
          'api_backend = "chat_completions"',
          'context_window = 128000',
        ].join('\n'),
      )
      if (managedProfile) writeFileSync(join(source, 'requirements.toml'), `[sandbox]\nprofile = "${managedProfile}"\n`)
    } else {
      writeFileSync(
        join(source, 'models.json'),
        JSON.stringify({
          providers: {
            fake: {
              baseUrl: `${fake.url}/v1`,
              api: 'openai-completions',
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
      )
      writeFileSync(join(source, 'settings.json'), JSON.stringify(settings))
      writeFileSync(
        join(source, 'auth.json'),
        JSON.stringify({
          fake: { type: 'api_key', key: KEY },
          'fake-oauth-not-used': {
            type: 'oauth',
            access: 'dummy-browser-access',
            refresh: 'dummy-browser-refresh',
            expires: 1,
          },
        }),
      )
    }
    const originalFiles = readdirSync(source).sort()
    const originalHashes = Object.fromEntries(originalFiles.map(name => [name, hash(join(source, name))]))
    const requests = () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line))
    const mainRequests = () => requests().filter(entry => entry.url === '/v1/chat/completions')
    const toolResults = () =>
      mainRequests()
        .flatMap(entry => entry.body.messages ?? [])
        .filter(message => message.role === 'tool')
    const marker = `host-confined-${h.cli}-${ws}`
    const env = {
      HOME: home,
      NO_PROXY: '127.0.0.1,localhost',
      ROLE_TEST_ID: marker,
      ...(grok
        ? {
            GROK_HOME: source,
            GROK_MODELS_BASE_URL: `${fake.url}/v1`,
            XAI_API_KEY: KEY,
            GROK_DISABLE_AUTOUPDATER: '1',
            GROK_TELEMETRY_ENABLED: 'false',
            DISABLE_TELEMETRY: '1',
            DISABLE_ERROR_REPORTING: '1',
          }
        : { PI_CODING_AGENT_DIR: source, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1' }),
    }
    const cliSettings = { executable: h.executable, envPassthrough: Object.keys(env).filter(name => name !== 'HOME') }
    const events = []
    const observed = {
      ...adapter,
      createSession(...args) {
        const session = adapter.createSession(...args)
        return {
          start: io => session.start(io),
          cancel: () => session.cancel?.(),
          finish: exit => session.finish(exit),
          line(text) {
            events.push(text)
            session.line(text)
          },
        }
      },
    }
    const w = await h.world({
      cwd: ws,
      hostSandbox,
      adapters: id => (id === h.cli ? observed : undefined),
      roles: [
        h.role(roleId, {
          instructions: 'HOST_CONFINED_ROLE_MARKER',
          runner: { cli: h.cli, permission: 'workspace-write', model },
        }),
      ],
      env,
      clis: { [h.cli]: cliSettings },
    })
    const enforcements = []
    const hostFacts = []
    const sandbox = w.ctx.get('sandbox')
    if (sandbox?.confine) {
      const confine = sandbox.confine.bind(sandbox)
      sandbox.confine = async (...args) => {
        const result = await confine(...args)
        enforcements.push(result.enforcement)
        hostFacts.push({
          mode: args[1].mode,
          workspaceRoot: args[1].workspaceRoot === ws ? '<workspace>' : '<unexpected-root>',
          runner: basename(result.argv[0]),
          enforcement: result.enforcement,
        })
        h.assert.equal(args[1].mode, 'workspace-write', 'actual policy is the ordinary workspace-write mode')
        h.assert.equal(args[1].workspaceRoot, ws, 'actual writable root is this fixture workspace')
        return result
      }
    }
    const scanner = createOwnedEnvironmentScanner()
    const x = {
      w,
      ws,
      outside,
      source,
      mainRequests,
      toolResults,
      requests,
      events,
      settings: cliSettings,
      pids: () => scanner(`ROLE_TEST_ID=${marker}`),
      async run(prompt) {
        const { childId } = await w.delegate({ role: roleId, prompt })
        const notice = await w.notice(childId, 60_000)
        h.assert.ok(notice.includes(final), `${notice}\nCaptured CLI protocol:\n${events.join('\n')}`)
        h.assert.ok(enforcements.length > 0, 'actual Host sandbox was applied')
        if (enforcements.includes('partial'))
          h.assert.match(
            notice,
            /partial|incomplete|older.*ABI/i,
            'partial enforcement must be visible in the parent notice',
          )
        return notice
      },
      assertFake() {
        const calls = mainRequests()
        h.assert.ok(calls.length > 0, 'real CLI reached local fake model')
        for (const request of calls) h.assert.equal(request.authorization, `Bearer ${KEY}`)
      },
      assertDenied() {
        const output = JSON.stringify(toolResults())
        h.assert.match(
          output,
          /EACCES|EPERM|EROFS|permission denied|operation not permitted|read.only file system/i,
          `actual tool response must report denied write, not merely a missing file: ${output}`,
        )
      },
    }
    try {
      await body(x)
      h.assert.deepEqual(
        readdirSync(source).sort(),
        originalFiles,
        'source configuration directory got no lock/cache files',
      )
      for (const [name, digest] of Object.entries(originalHashes))
        h.assert.equal(hash(join(source, name)), digest, `source ${name} unchanged`)
    } finally {
      console.log(`    HOST_CONFINEMENT_METADATA ${JSON.stringify({ cli: h.cli, calls: hostFacts })}`)
      await w.close()
      fake.stop()
    }
  }

  h.case(
    `host-confined ${label} ordinary parent reads and edits inside a venv workspace without source-state writes`,
    async () => {
      await withFixture(async x => {
        execFileSync('python3', ['-m', 'venv', '--without-pip', join(x.ws, '.venv')])
        await x.run(read(join(x.ws, 'README.md')))
        h.assert.ok(
          JSON.stringify(x.toolResults()).includes('HOST_CONFINED_READ_OK'),
          'real read returned fixture contents',
        )
        await x.run(write(join(x.ws, 'inside.txt'), 'HOST_CONFINED_INSIDE_OK\n'))
        h.assert.equal(readFileSync(join(x.ws, 'inside.txt'), 'utf8'), 'HOST_CONFINED_INSIDE_OK\n')
        h.assert.ok(existsSync(join(x.ws, '.venv', 'bin', 'python')), 'ordinary venv remains intact')
        x.assertFake()
      })
    },
  )
  h.case(`host-confined ${label} denies ordinary outside-file edits after genuine model/tool execution`, async () => {
    await withFixture(async x => {
      await x.run(write(join(x.outside, 'sentinel.txt'), 'ESCAPED_OUTSIDE'))
      x.assertDenied()
      h.assert.equal(readFileSync(join(x.outside, 'sentinel.txt'), 'utf8'), 'OUTSIDE_UNCHANGED\n')
      x.assertFake()
    })
  })
  h.case(`host-confined ${label} denies writes through an escaping symlink`, async () => {
    await withFixture(async x => {
      symlinkSync(join(x.outside, 'sentinel.txt'), join(x.ws, 'outside-link.txt'))
      await x.run(write(join(x.ws, 'outside-link.txt'), 'ESCAPED_SYMLINK'))
      x.assertDenied()
      h.assert.equal(readFileSync(join(x.outside, 'sentinel.txt'), 'utf8'), 'OUTSIDE_UNCHANGED\n')
      x.assertFake()
    })
  })
  h.case(`host-confined ${label} observes host hardlink alias semantics without claiming inode isolation`, async () => {
    await withFixture(async x => {
      linkSync(join(x.outside, 'sentinel.txt'), join(x.ws, 'outside-hardlink.txt'))
      const notice = await x.run(write(join(x.ws, 'outside-hardlink.txt'), 'OBSERVED_SHARED_HARDLINK'))
      const contents = readFileSync(join(x.outside, 'sentinel.txt'), 'utf8')
      if (contents === 'OUTSIDE_UNCHANGED\n') {
        const inside = readFileSync(join(x.ws, 'outside-hardlink.txt'), 'utf8')
        if (inside === 'OBSERVED_SHARED_HARDLINK') {
          h.assert.ok(
            x.toolResults().length > 0,
            'native tool replaced its workspace link instead of mutating the shared inode',
          )
          console.log(
            `    HARDLINK OBSERVATION ${label}: native replacement preserved outside bytes; not kernel inode-isolation evidence`,
          )
        } else {
          h.assert.equal(inside, 'OUTSIDE_UNCHANGED\n')
          x.assertDenied()
          console.log(`    HARDLINK OBSERVATION ${label}: denied by this host; not a portable inode-isolation promise`)
        }
      } else {
        h.assert.equal(
          contents,
          'OBSERVED_SHARED_HARDLINK',
          'only the actual requested shared-inode write may be observed',
        )
        h.assert.ok(x.toolResults().length > 0, 'actual tool result confirms alias operation ran')
        h.assert.match(notice, /hard.?link|path.based|inode/i, 'parent must be warned about inherited alias semantics')
        console.log(
          `    HARDLINK OBSERVATION ${label}: existing alias shares outside bytes; no inode-isolation qualification`,
        )
      }
      x.assertFake()
    })
  })
  if (grok)
    h.case('host-confined Grok managed off cannot disable the outer DSH file policy', async () => {
      await withFixture(
        async x => {
          await x.run(write(join(x.outside, 'sentinel.txt'), 'MANAGED_ESCAPE'))
          x.assertDenied()
          h.assert.equal(readFileSync(join(x.outside, 'sentinel.txt'), 'utf8'), 'OUTSIDE_UNCHANGED\n')
          x.assertFake()
        },
        { managedProfile: 'off' },
      )
    })
  else
    h.case('host-confined Pi native extension starts inside the file boundary', async () => {
      await withFixture(
        async x => {
          await x.run('answer after native extension startup')
          const proof = JSON.parse(readFileSync(join(x.ws, 'extension-proof.json'), 'utf8'))
          h.assert.equal(proof.executed, true)
          h.assert.match(proof.denied, /EACCES|EPERM|EROFS/)
          h.assert.deepEqual(proof.authProviders, ['fake'], 'only static API-key auth is snapshotted')
          h.assert.equal(proof.hasOAuth, false, 'browser/OAuth credentials were not copied')
          h.assert.equal(existsSync(join(x.outside, 'extension-outside.txt')), false)
          x.assertFake()
        },
        { extension: true },
      )
    })
  h.case(`host-confined ${label} missing Host sandbox refuses before model or native startup`, async () => {
    await withFixture(
      async x => {
        let outcome
        try {
          const { childId } = await x.w.delegate({ role: roleId, prompt: 'MUST_NOT_INFER' })
          outcome = await x.w.notice(childId, 30_000)
        } catch (error) {
          outcome = String(error)
        }
        h.assert.match(outcome, /sandbox|confin|unavailable/i)
        h.assert.equal(x.requests().length, 0)
        h.assert.equal(
          existsSync(join(x.ws, 'extension-proof.json')),
          false,
          'native extension did not start without confinement',
        )
      },
      { hostSandbox: false, extension: !grok },
    )
  })
  h.case(`host-confined ${label} native shell runs inside the same ordinary file boundary`, async () => {
    await withFixture(async x => {
      await x.run('inspect native shell tool schema before the command fixture')
      const toolName = grok ? 'run_terminal_command' : 'bash'
      const definition = x
        .mainRequests()
        .flatMap(request => request.body.tools ?? [])
        .find(entry => entry.function?.name === toolName)?.function
      h.assert.ok(definition, `native ${toolName} tool is available`)
      h.assert.ok(
        definition.parameters?.properties?.command,
        `native shell schema: ${JSON.stringify(definition.parameters)}`,
      )
      const script = `from pathlib import Path\nPath(${JSON.stringify(join(x.ws, 'shell-inside.txt'))}).write_text('SHELL_INSIDE_OK')\ntry:\n Path(${JSON.stringify(join(x.outside, 'sentinel.txt'))}).write_text('SHELL_ESCAPE')\n raise SystemExit(99)\nexcept PermissionError:\n print('SHELL_OUTSIDE_DENIED')\n`
      const command = `python3 -c '${script.replaceAll("'", "'\\''")}'`
      const input = { command }
      for (const name of definition.parameters?.required ?? []) {
        if (name === 'command') continue
        if (name === 'block_until_ms') input[name] = 5000
        else if (name === 'description' || name === 'command_description')
          input[name] = 'Check the inherited DSH file boundary'
        else h.assert.fail(`unreviewed required native shell argument: ${name}`)
      }
      await x.run(tool(toolName, input))
      h.assert.equal(readFileSync(join(x.ws, 'shell-inside.txt'), 'utf8'), 'SHELL_INSIDE_OK')
      h.assert.equal(readFileSync(join(x.outside, 'sentinel.txt'), 'utf8'), 'OUTSIDE_UNCHANGED\n')
      h.assert.ok(
        JSON.stringify(x.toolResults()).includes('SHELL_OUTSIDE_DENIED'),
        'actual native shell observed permission denial',
      )
      x.assertFake()
    })
  })
  h.case(`host-confined ${label} cancellation stops the actual confined stream and owned processes`, async () => {
    await withFixture(async x => {
      const { childId } = await x.w.delegate({ role: roleId, prompt: '[[slow]]' })
      await h.wait(() => x.mainRequests().length > 0, 30_000, 'real confined stream request')
      h.assert.ok(x.pids().length > 0, 'owned process observed before cancel')
      await x.w.interrupt(childId)
      h.assert.match(await x.w.notice(childId, 15_000), /abort|cancel|interrupt|stopped before/i)
      await h.wait(() => x.pids().length === 0, 5000, 'confined descendants stopped after cancel')
      x.assertFake()
    })
  })
  h.case(`host-confined ${label} real wall timeout stops the confined stream and owned processes`, async () => {
    await withFixture(async x => {
      const run = await h.engine.startExternalRun(
        {
          adapter,
          input: {
            runner: { cli: h.cli, permission: 'workspace-write', model },
            preset: 'workspace-write',
            access: 'workspace-write',
            instructions: '',
            task: '[[slow]]',
            cwd: x.ws,
          },
          settings: x.settings,
          timeoutMs: 2000,
          signal: new AbortController().signal,
        },
        h.engineDeps(x.w),
      )
      await h.wait(() => x.pids().length > 0, 1500, 'owned confined process before timeout')
      const result = await run.result
      h.assert.match(result.diagnostic ?? '', /timeout/)
      await h.wait(() => x.pids().length === 0, 5000, 'confined descendants stopped after timeout')
      await run.dispose()
      x.assertFake()
    })
  })
}
