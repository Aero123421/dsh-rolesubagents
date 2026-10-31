/** Limited-harness bootstrap. All reads, state preparation and CLI code run INSIDE DSH confinement. */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export interface PrivateStateBoot {
  kind: 'grok-build' | 'pi'
  runDir: string
  sourceDir: string
  argv: readonly string[]
  files: Readonly<Record<string, string>>
}

/** Self-contained: its compiled function source is passed to Node, after the sandbox runner. */
export async function executePrivateStateBoot(payload: PrivateStateBoot): Promise<number> {
  const fs = await import('node:fs/promises')
  const { constants } = await import('node:fs')
  const path = await import('node:path')
  const { spawn } = await import('node:child_process')
  const maximum = 4 * 1024 * 1024
  if (!path.isAbsolute(payload.runDir) || payload.runDir === '/' || !path.isAbsolute(payload.sourceDir))
    throw new Error('Invalid boot paths')
  if (!['grok-build', 'pi'].includes(payload.kind) || !payload.argv.length) throw new Error('Invalid boot request')
  const names =
    payload.kind === 'pi'
      ? ['settings.json', 'models.json']
      : ['config.toml', 'requirements.toml', 'managed_config.toml', 'sandbox.toml', 'trusted_folders.toml']
  const destination = path.join(payload.runDir, payload.kind === 'pi' ? 'pi' : 'grok')
  await fs.mkdir(payload.runDir, { recursive: true, mode: 0o700 })
  for (const dir of [destination, path.join(payload.runDir, 'home'), path.join(payload.runDir, 'tmp')])
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  async function readBounded(file: string): Promise<string | undefined> {
    let handle: Awaited<ReturnType<typeof fs.open>>
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > maximum) throw new Error('CLI configuration is not a bounded regular file')
      const buffer = Buffer.alloc(maximum + 1)
      let length = 0
      while (length < buffer.length) {
        const read = await handle.read(buffer, length, buffer.length - length, null)
        if (!read.bytesRead) break
        length += read.bytesRead
      }
      if (length > maximum) throw new Error('CLI configuration exceeds the snapshot limit')
      return buffer.subarray(0, length).toString('utf8')
    } finally {
      await handle.close()
    }
  }
  for (const name of names) {
    const value = await readBounded(path.join(payload.sourceDir, name))
    if (value !== undefined) await fs.writeFile(path.join(destination, name), value, { mode: 0o600, flag: 'wx' })
  }
  if (payload.kind === 'pi') {
    const text = await readBounded(path.join(payload.sourceDir, 'auth.json'))
    if (text !== undefined) {
      const source: unknown = JSON.parse(text)
      if (source === null || typeof source !== 'object' || Array.isArray(source))
        throw new Error('Invalid Pi credential map')
      const entries = Object.entries(source)
        .filter(
          ([, value]) =>
            value !== null &&
            typeof value === 'object' &&
            !Array.isArray(value) &&
            (value as { type?: unknown }).type === 'api_key' &&
            typeof (value as { key?: unknown }).key === 'string',
        )
        .map(([provider, value]) => [provider, { type: 'api_key', key: (value as { key: string }).key }])
      await fs.writeFile(path.join(destination, 'auth.json'), JSON.stringify(Object.fromEntries(entries)), {
        mode: 0o600,
        flag: 'wx',
      })
    }
  }
  for (const [name, value] of Object.entries(payload.files)) {
    const target = path.resolve(name)
    if (!target.startsWith(payload.runDir + path.sep)) throw new Error('Boot file escapes the private directory')
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
    await fs.writeFile(target, value, { mode: 0o600, flag: 'wx' })
  }
  // Never give the CLI a copy of the boot envelope. It inherits only the intended CLI environment.
  delete process.env.DSH_ROLES_CLI_BOOT
  const child = spawn(payload.argv[0]!, payload.argv.slice(1), { stdio: 'inherit', env: process.env })
  return await new Promise<number>((accept, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => accept(code ?? (signal ? 1 : 0)))
  })
}

/** Returns a trusted bootstrap argv plus its private data envelope; never executes user config in the Host. */
export function privateStateLaunch(
  kind: PrivateStateBoot['kind'],
  runDir: string,
  argv: readonly string[],
  files: Readonly<Record<string, string>>,
  hostEnv: Readonly<Record<string, string | undefined>>,
  cwd: string,
): { argv: readonly string[]; payload: string } {
  if (!isAbsolute(runDir) || runDir === '/') throw new Error('Invalid private run directory')
  const home = hostEnv.HOME ?? homedir()
  const override = kind === 'pi' ? hostEnv.PI_CODING_AGENT_DIR : hostEnv.GROK_HOME
  const expanded = override?.replace(/^~(?=$|\/)/, home)
  const sourceDir = expanded ? resolve(cwd, expanded) : join(home, kind === 'pi' ? '.pi/agent' : '.grok')
  const boot = `(${executePrivateStateBoot.toString()})(JSON.parse(process.env.DSH_ROLES_CLI_BOOT || '{}')).then(code => { process.exitCode=code }).catch(() => { console.error('rolesubagents: limited CLI state preparation failed; use API-key authentication or the native preset'); process.exitCode=78 })`
  return {
    argv: [process.execPath, '-e', boot],
    payload: JSON.stringify({ kind, runDir, sourceDir, argv, files } satisfies PrivateStateBoot),
  }
}
