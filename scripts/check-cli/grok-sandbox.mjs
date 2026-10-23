/** Standalone, experimental installed-Grok sandbox checks. Never changes production adapters/config. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isolateCheckEnvironment } from '../check-environment.mjs'
import { grokBuildAdapter } from '../../src/host/cli/grok-build/index.ts'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const dummy = 'dummy-grok-sandbox-experiment'

async function capture(executable, args, options = {}) {
  const child = spawn(executable, args, { ...options, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  child.stdout.on('data', chunk => {
    stdout += chunk
  })
  child.stderr.on('data', chunk => {
    stderr += chunk
  })
  const timer = setTimeout(() => {
    timedOut = true
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {}
  }, 30_000)
  try {
    return await new Promise((accept, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => accept({ stdout, stderr, code, signal, timedOut }))
    })
  } finally {
    clearTimeout(timer)
  }
}

async function fakeServer(log) {
  const child = spawn(process.execPath, [join(repo, 'tests/support/fake-models/grok-build.mjs'), '--log', log], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', chunk => {
    stderr += chunk
  })
  const closed = new Promise(accept => child.once('close', accept))
  let url
  try {
    url = await new Promise((accept, reject) => {
      const timer = setTimeout(() => reject(new Error(`fake server startup timeout: ${stderr}`)), 5000)
      child.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
      child.once('exit', code => {
        clearTimeout(timer)
        reject(new Error(`fake server exited ${code}: ${stderr}`))
      })
      child.stdout.on('data', chunk => {
        stdout += chunk
        for (const line of stdout.split('\n').filter(Boolean)) {
          try {
            const event = JSON.parse(line)
            if (event.listening) {
              clearTimeout(timer)
              accept(`http://127.0.0.1:${event.port}`)
              return
            }
          } catch {}
        }
      })
    })
  } catch (error) {
    child.kill('SIGKILL')
    await closed
    throw error
  }
  return {
    url,
    async close() {
      if (child.exitCode !== null) return
      child.kill('SIGTERM')
      await closed
    },
  }
}

export async function investigate({ executable = '/usr/local/bin/grok' } = {}) {
  const binary = realpathSync(executable)
  const check = isolateCheckEnvironment()
  mkdirSync(join(repo, 'artifacts'), { recursive: true })
  const artifact = realpathSync(mkdtempSync(join(repo, 'artifacts/grok-sandbox-')))
  const fixtures = realpathSync(mkdtempSync(join(artifact, 'fixtures-')))
  const report = {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    binary: { path: binary, sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'), version: '' },
    artifact,
    cases: [],
    dshVersion: null,
    qualification: {
      readOnly: false,
      workspaceWrite: false,
      reason: 'Investigation only: requested-profile enforcement must be established independently of process exit.',
    },
    limitation: 'Standalone CLI/OS mechanism experiment, not DSH integration or a production preset qualification.',
  }
  try {
    // A checkout under a sandbox-writable temporary root cannot prove ordinary-directory denial.
    for (const candidate of ['/tmp', '/var/tmp', process.env.TMPDIR, process.env.TMP, process.env.TEMP]) {
      if (candidate && existsSync(candidate)) {
        const exception = realpathSync(candidate)
        assert.ok(
          fixtures !== exception && !fixtures.startsWith(`${exception}/`),
          `fixture root is inside sandbox temp exception ${exception}`,
        )
      }
    }
    const version = spawnSync(binary, ['--version'], { env: process.env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(version.status, 0)
    assert.equal(/^grok\s+(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1], '1.0.62')
    report.binary.version = version.stdout.trim()
    writeFileSync(join(artifact, 'version.json'), JSON.stringify(version, null, 2))
    const scenarios = [
      { id: 'native-read-control', profile: null, tool: 'read_file', action: 'read' },
      { id: 'native-inside-write-control', profile: null, tool: 'write', action: 'inside' },
      ...['read-only', 'workspace'].flatMap(profile =>
        ['read', 'inside', 'outside'].map(action => ({
          id: `${profile}-${action}`,
          profile,
          tool: action === 'read' ? 'read_file' : 'write',
          action,
        })),
      ),
      ...['off', 'devbox', 'invalid-experimental-profile'].map(requirement => ({
        id: `read-only-requirements-${requirement}`,
        profile: 'read-only',
        requirement,
        tool: 'write',
        action: 'outside',
      })),
    ]
    for (const scenario of scenarios) {
      const root = join(fixtures, scenario.id)
      const cwd = join(root, 'project')
      const outside = join(root, 'outside')
      const home = join(root, 'home')
      const grokHome = join(root, 'grok-home')
      for (const path of [cwd, outside, home, grokHome]) mkdirSync(path, { recursive: true })
      writeFileSync(join(cwd, 'README.md'), 'SANDBOX_READ_MARKER\n')
      const log = join(artifact, `${scenario.id}.requests.jsonl`)
      writeFileSync(log, '')
      const fake = await fakeServer(log)
      try {
        writeFileSync(
          join(grokHome, 'config.toml'),
          [
            '[features]',
            'telemetry = false',
            'remote_fetch = false',
            'managed_config = false',
            'codebase_indexing = false',
            '[permission]',
            'allow = ["Read", "Write", "read_file", "write_file"]',
            '[model.fake]',
            'model = "fake-model"',
            `base_url = "${fake.url}/v1"`,
            `api_key = "${dummy}"`,
            'api_backend = "chat_completions"',
            'context_window = 128000',
          ].join('\n'),
        )
        if (scenario.requirement)
          writeFileSync(join(grokHome, 'requirements.toml'), `[sandbox]\nprofile = "${scenario.requirement}"\n`)
        const venv = spawnSync('python3', ['-m', 'venv', '--without-pip', join(cwd, '.venv')], {
          env: process.env,
          encoding: 'utf8',
        })
        assert.equal(venv.status, 0, venv.stderr)
        const target =
          scenario.action === 'read'
            ? join(cwd, 'README.md')
            : join(scenario.action === 'inside' ? cwd : outside, 'written.txt')
        const input =
          scenario.action === 'read'
            ? { target_file: target }
            : { file_path: target, content: 'SANDBOX_WRITE_MARKER\n' }
        const task = `[[tool:${scenario.tool} ${JSON.stringify(input)}]]`
        const plan = grokBuildAdapter.plan({
          runner: { cli: 'grok-build', permission: 'native', model: 'fake' },
          preset: 'native',
          access: 'full-access',
          instructions: 'Use the requested tool, report result.',
          task,
          cwd,
        })
        const prompt = join(root, 'task.txt')
        writeFileSync(prompt, task, { mode: 0o600 })
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Substitute adapter-owned file placeholder.
        const argv = plan.argv.map(arg => arg.replace('${RUN_DIR}/grok-task.txt', prompt))
        argv.push('--permission-mode', 'dontAsk')
        if (scenario.profile) argv.push('--sandbox', scenario.profile)
        const env = {
          ...process.env,
          HOME: home,
          GROK_HOME: grokHome,
          GROK_MODELS_BASE_URL: `${fake.url}/v1`,
          XAI_API_KEY: dummy,
          GROK_DISABLE_AUTOUPDATER: '1',
          GROK_TELEMETRY_ENABLED: 'false',
          DISABLE_TELEMETRY: '1',
          DISABLE_ERROR_REPORTING: '1',
          NO_PROXY: '127.0.0.1,localhost',
        }
        const result = await capture(binary, argv, { cwd, env })
        writeFileSync(join(artifact, `${scenario.id}.stdout.txt`), result.stdout)
        writeFileSync(join(artifact, `${scenario.id}.stderr.txt`), result.stderr)
        const requests = readFileSync(log, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map(line => JSON.parse(line))
        const calls = requests.filter(request => request.url === '/v1/chat/completions')
        for (const request of calls) assert.equal(request.authorization, `Bearer ${dummy}`)
        const toolResults = calls
          .flatMap(request => request.body?.messages ?? [])
          .filter(message => message.role === 'tool')
        const entry = {
          ...scenario,
          argv,
          code: result.code,
          signal: result.signal,
          timedOut: result.timedOut,
          requestCount: calls.length,
          toolResults,
          targetExists: existsSync(target),
          targetContents: existsSync(target) ? readFileSync(target, 'utf8') : null,
          stderr: result.stderr,
          stdout: result.stdout,
        }
        entry.observation =
          calls.length === 0 && result.code !== 0
            ? 'startup-failed-boundary-unverified'
            : scenario.profile !== null &&
                scenario.action !== 'read' &&
                entry.targetExists &&
                (scenario.profile === 'read-only' || scenario.action === 'outside')
              ? 'requested-restriction-not-effective'
              : scenario.profile === null
                ? 'native-control'
                : 'operation-observed-not-qualified'
        report.cases.push(entry)
        // Persist evidence even if a control or the reviewed policy-override assertion fails.
        writeFileSync(join(artifact, 'report.json'), JSON.stringify(report, null, 2) + '\n')
        if (scenario.requirement === 'off' || scenario.requirement === 'devbox') {
          assert.equal(result.code, 0, 'reviewed policy override case must actually start')
          assert.equal(
            entry.targetContents,
            'SANDBOX_WRITE_MARKER\n',
            'reviewed override must prove real outside write, not infer it from flags',
          )
          assert.ok(result.stdout.includes('"status":"completed"'), 'real tool completed')
        }
        if (scenario.profile === null) {
          assert.equal(result.code, 0, result.stderr)
          if (scenario.action === 'read')
            assert.ok(
              JSON.stringify(toolResults).includes('SANDBOX_READ_MARKER'),
              'control must actually read, not merely finish',
            )
          else assert.equal(entry.targetContents, 'SANDBOX_WRITE_MARKER\n', 'control must actually write')
        }
        assert.ok(existsSync(join(cwd, '.venv', 'bin', 'python')), 'venv remains intact')
        console.log(`${scenario.id}: exit=${result.code}, requests=${calls.length}, target=${entry.targetExists}`)
        writeFileSync(join(artifact, 'report.json'), JSON.stringify(report, null, 2) + '\n')
      } finally {
        await fake.close()
      }
    }
    return report
  } finally {
    // Fixtures are always minted below this experiment; raw evidence remains available.
    if (realpathSync(fixtures) === fixtures && dirname(fixtures) === artifact)
      rmSync(fixtures, { recursive: true, force: true })
    check.dispose()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  investigate({ executable: process.env.GROK_SANDBOX_EXECUTABLE ?? '/usr/local/bin/grok' })
    .then(report => {
      console.log(`REPORT ${join(report.artifact, 'report.json')}`)
      console.log('INVESTIGATION COMPLETE — not sandbox qualification; readOnly=false workspaceWrite=false')
    })
    .catch(error => {
      console.error(error)
      process.exitCode = 1
    })
}
