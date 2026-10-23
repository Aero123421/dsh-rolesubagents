import { mkdtemp, mkdir, readFile, writeFile, rm, stat, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { executePrivateStateBoot, privateStateLaunch } from '../src/host/external/private-state.ts'

const prepare = (kind: 'grok-build' | 'pi', runDir: string, sourceDir: string) =>
  executePrivateStateBoot({ kind, runDir, sourceDir, argv: [process.execPath, '-e', 'process.exit(0)'], files: {} })

const roots: string[] = []
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rolesubagents-private-state-')))
  roots.push(root)
  const source = join(root, 'source')
  const runDir = join(root, 'run')
  await mkdir(source)
  await mkdir(runDir, { mode: 0o700 })
  return { root, source, runDir }
}
afterEach(async () => {
  for (const root of roots.splice(0)) {
    expect(await realpath(root)).toBe(root)
    await rm(root, { recursive: true, force: true })
  }
})

it('snapshots Pi model/settings and static API keys without OAuth refresh credentials or source mutation', async () => {
  const { source, runDir } = await fixture()
  const auth = JSON.stringify({
    fake: { type: 'api_key', key: 'dummy-static' },
    browser: { type: 'oauth', access: 'must-not-copy', refresh: 'must-not-rotate', expires: 1 },
  })
  await writeFile(join(source, 'auth.json'), auth)
  await writeFile(join(source, 'models.json'), '{"providers":{}}')
  await writeFile(join(source, 'settings.json'), '{"defaultProvider":"fake"}')
  await prepare('pi', runDir, source)
  const snapshot = await readFile(join(runDir, 'pi', 'auth.json'), 'utf8')
  expect(JSON.parse(snapshot)).toEqual({ fake: { type: 'api_key', key: 'dummy-static' } })
  expect(snapshot).not.toContain('must-not')
  expect(await readFile(join(source, 'auth.json'), 'utf8')).toBe(auth)
  expect((await stat(join(runDir, 'pi', 'auth.json'))).mode & 0o777).toBe(0o600)
  expect((await stat(join(runDir, 'pi'))).mode & 0o777).toBe(0o700)
})
it('retains Grok managed config but does not copy browser or MCP credential stores', async () => {
  const { source, runDir } = await fixture()
  await writeFile(join(source, 'config.toml'), '[features]\ntelemetry=false')
  await writeFile(join(source, 'requirements.toml'), '[sandbox]\nprofile="off"')
  await writeFile(join(source, 'auth.json'), '{"refresh_token":"must-not-copy"}')
  await prepare('grok-build', runDir, source)
  expect(await readFile(join(runDir, 'grok', 'requirements.toml'), 'utf8')).toContain('profile="off"')
  await expect(readFile(join(runDir, 'grok', 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(source, 'auth.json'), 'utf8')).toContain('must-not-copy')
})
it('does not import resource trees and accepts missing optional configuration', async () => {
  const { source, runDir } = await fixture()
  await mkdir(join(source, 'extensions'))
  await prepare('pi', runDir, source)
  await expect(stat(join(runDir, 'pi', 'extensions'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('rejects oversized configuration before launching any CLI', async () => {
  const { source, runDir } = await fixture()
  await writeFile(join(source, 'models.json'), 'x'.repeat(4 * 1024 * 1024 + 1))
  await expect(prepare('pi', runDir, source)).rejects.toThrow('bounded regular file')
})
it('keeps task/config data in a private envelope, never in bootstrap argv', async () => {
  const { root, source, runDir } = await fixture()
  const launch = privateStateLaunch(
    'pi',
    runDir,
    ['/bin/true'],
    { [join(runDir, 'task')]: 'PRIVATE_TASK_MARKER' },
    { HOME: root, PI_CODING_AGENT_DIR: source },
    root,
  )
  expect(launch.argv.join(' ')).not.toContain('PRIVATE_TASK_MARKER')
  expect(JSON.parse(launch.payload).files[join(runDir, 'task')]).toBe('PRIVATE_TASK_MARKER')
})
