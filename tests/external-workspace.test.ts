// biome-ignore-all lint/suspicious/noTemplateCurlyInString: run-plan placeholders are literal ${...} strings.
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { type EngineDeps, startExternalRun } from '../src/host/external/engine.ts'
import type { PlanInput } from '../src/host/external/types.ts'
import {
  findEscapingLink,
  findStartupCodeDir,
  gitTopLevelAbove,
  SCAN_MAX_ENTRIES,
} from '../src/host/external/workspace.ts'
import type { SubagentRunPort } from '../src/host/ports.ts'
import { CLAUDE_CODE } from '../src/shared/cli/claude-code.ts'
import { CODEX } from '../src/shared/cli/codex.ts'
import type { CliDescriptor } from '../src/shared/cli/index.ts'
import { OPENCODE } from '../src/shared/cli/opencode.ts'
import { fakeSubprocess, line, testAdapter } from './external-fakes.ts'

function tree(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'rolesubagents-ws-'))
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    if (path.endsWith('/')) mkdirSync(join(root, path), { recursive: true })
    else writeFileSync(join(root, path), content)
  }
  return root
}

const signal = new AbortController().signal

describe('gitTopLevelAbove', () => {
  it('finds a .git directory or file above the directory, not at it', async () => {
    const root = tree({ '.git/HEAD': 'x', 'sub/deep/': '' })
    expect(await gitTopLevelAbove(join(root, 'sub', 'deep'))).toBe(root)
    expect(await gitTopLevelAbove(root)).toBeUndefined()
    const worktree = tree({ 'sub/': '' })
    writeFileSync(join(worktree, '.git'), 'gitdir: /elsewhere\n')
    expect(await gitTopLevelAbove(join(worktree, 'sub'))).toBe(worktree)
    expect(await gitTopLevelAbove(tree({ 'sub/': '' }))).toBeUndefined()
  })
})

describe('findStartupCodeDir', () => {
  it('looks from the directory up to the git top-level, skipping the home directory', async () => {
    const root = tree({ '.git/HEAD': 'x', '.opencode/plugin/x.js': '', 'sub/': '' })
    const names = ['.opencode/plugin', '.opencode/plugins']
    expect(await findStartupCodeDir(join(root, 'sub'), names, undefined)).toBe(join(root, '.opencode/plugin'))
    expect(await findStartupCodeDir(join(root, 'sub'), names, root)).toBeUndefined()
    expect(await findStartupCodeDir(join(root, 'sub'), [], undefined)).toBeUndefined()
    // Above the git top-level is out of scope.
    const outer = tree({ '.opencode/plugins/x.js': '', 'repo/.git/HEAD': 'x' })
    expect(await findStartupCodeDir(join(outer, 'repo'), names, undefined)).toBeUndefined()
  })
})

describe('findEscapingLink', () => {
  it('reports a link that leads outside the root, also a dangling one, and ignores links inside', async () => {
    const outside = tree({ 'secret.txt': 'x' })
    const ws = tree({ 'a/b/file.txt': 'x', '.git/objects/x': '' })
    symlinkSync(join(ws, 'a'), join(ws, 'a', 'b', 'inside-link'))
    expect(await findEscapingLink(ws, ws, signal)).toBeUndefined()
    symlinkSync(outside, join(ws, 'a', 'b', 'out'))
    expect(await findEscapingLink(ws, ws, signal)).toEqual({ kind: 'link', path: join(ws, 'a', 'b', 'out') })
    // Allowed when the root is wider than the directory.
    expect(await findEscapingLink(join(ws, 'a'), '/', signal)).toBeUndefined()
    const dangling = tree()
    symlinkSync(join(outside, 'new-file.txt'), join(dangling, 'will-create'))
    expect(await findEscapingLink(dangling, dangling, signal)).toMatchObject({ kind: 'link' })
    const relative = tree({ 'sub/': '' })
    symlinkSync('../../', join(relative, 'sub', 'up'))
    expect(await findEscapingLink(relative, relative, signal)).toMatchObject({ kind: 'link' })
  })

  it('checks links reached through an internal sibling directory and terminates on cycles', async () => {
    const root = tree({ 'cwd/': '', 'shared/': '' })
    symlinkSync(join(root, 'shared'), join(root, 'cwd', 'shared'))
    symlinkSync(join(root, 'cwd'), join(root, 'shared', 'back'))
    expect(await findEscapingLink(join(root, 'cwd'), root, signal)).toBeUndefined()
    const outside = tree()
    symlinkSync(outside, join(root, 'shared', 'escape'))
    expect(await findEscapingLink(join(root, 'cwd'), root, signal)).toEqual({
      kind: 'link',
      path: join(root, 'shared', 'escape'),
    })
  })

  it('resolves missing target descendants through an existing outside ancestor', async () => {
    const root = tree({ 'cwd/': '', 'shared/': '' })
    const outside = tree()
    symlinkSync(outside, join(root, 'shared', 'redirect'))
    symlinkSync(join(root, 'shared', 'redirect', 'new', 'deep', 'file.txt'), join(root, 'cwd', 'create'))
    expect(await findEscapingLink(join(root, 'cwd'), root, signal)).toEqual({
      kind: 'link',
      path: join(root, 'cwd', 'create'),
    })
  })

  it('checks .git and fails closed over budget', async () => {
    const ws = tree({ 'x.txt': '' })
    mkdirSync(join(ws, '.git'))
    symlinkSync('/', join(ws, '.git', 'root'))
    expect(await findEscapingLink(ws, ws, signal)).toEqual({ kind: 'link', path: join(ws, '.git', 'root') })
    const big = tree(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, ''])))
    expect(await findEscapingLink(big, big, signal, { maxEntries: 10 })).toEqual({ kind: 'budget' })
    let clock = 0
    expect(await findEscapingLink(big, big, signal, { maxMs: 5, now: () => (clock += 10) })).toEqual({
      kind: 'budget',
    })
    const aborted = new AbortController()
    aborted.abort()
    await expect(findEscapingLink(big, big, aborted.signal)).rejects.toThrow()
    expect(SCAN_MAX_ENTRIES).toBe(100_000)
  })
})

// ---------------------------------------------------------------------------------------------------------------

function runSetup(descriptor: CliDescriptor, patch: Partial<PlanInput>, extra: Partial<EngineDeps> = {}) {
  const subprocess = fakeSubprocess({
    onRun: async p => {
      await p.stdinClosed
      p.stdout(line({ type: 'text', text: 'ok' }))
      p.stdout(line({ type: 'done' }))
      p.exit(0)
    },
  })
  const adapter = testAdapter({ descriptor })
  const logger = { info: vi.fn(), warn: vi.fn() }
  const deps: EngineDeps = {
    subprocess: () => subprocess,
    logger,
    runs: new Set<SubagentRunPort>(),
    hostEnv: { HOME: '/nonexistent-home', PATH: '/usr/bin' },
    tmpDir: mkdtempSync(join(tmpdir(), 'rolesubagents-ws-tmp-')),
    ...extra,
  }
  const start = (input: Partial<PlanInput>, workspaceRoot?: string) =>
    startExternalRun(
      {
        adapter,
        input: {
          runner: { cli: descriptor.id, permission: 'x' },
          preset: 'x',
          access: 'workspace-write',
          instructions: '',
          task: 't',
          cwd: '/',
          ...patch,
          ...input,
        },
        settings: {},
        timeoutMs: 60_000,
        signal,
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      },
      deps,
    )
  return { subprocess, logger, start }
}

describe('engine workspace checks', () => {
  it('refuses OpenCode edit-files below a git top-level, not at it, and not read-only', async () => {
    const repo = tree({ '.git/HEAD': 'x', 'sub/a.txt': 'a' })
    const t = runSetup(OPENCODE, { preset: 'edit-files' })
    await expect(t.start({ cwd: join(repo, 'sub') })).rejects.toThrow(
      `OpenCode cannot edit files in ${join(repo, 'sub')}: it is below the top-level of a git repository`,
    )
    expect(t.subprocess.processes).toHaveLength(0)
    const ok = await t.start({ cwd: repo })
    expect((await ok.result).stopReason).toBe('completed')
    const readOnly = await t.start({ cwd: join(repo, 'sub'), preset: 'read-only', access: 'read-only' })
    expect((await readOnly.result).stopReason).toBe('completed')
  })

  it('does not apply the git rule to CLIs whose tools stay in their directory', async () => {
    const repo = tree({ '.git/HEAD': 'x', 'sub/a.txt': 'a' })
    const t = runSetup(CLAUDE_CODE, { preset: 'acceptEdits' })
    expect((await (await t.start({ cwd: join(repo, 'sub') })).result).stopReason).toBe('completed')
  })

  it('refuses a tool-scope workspace-write run whose directory links outside the workspace; logs the link', async () => {
    const outside = tree()
    const ws = tree({ 'src/x.ts': '' })
    symlinkSync(outside, join(ws, 'src', 'escape'))
    const t = runSetup(CLAUDE_CODE, { preset: 'acceptEdits' })
    await expect(t.start({ cwd: ws })).rejects.toThrow(
      `Claude Code cannot edit files in ${ws}: the directory contains a symbolic link that leads outside the workspace`,
    )
    expect(t.logger.warn).toHaveBeenCalledWith(expect.stringContaining(join(ws, 'src', 'escape')))
    // A link to elsewhere inside the parent's workspace root is fine.
    const parent = tree({ 'ws/src/x.ts': '', 'shared/y.ts': '' })
    symlinkSync(join(parent, 'shared'), join(parent, 'ws', 'src', 'shared'))
    expect((await (await t.start({ cwd: join(parent, 'ws') }, parent)).result).stopReason).toBe('completed')
    await expect(t.start({ cwd: join(parent, 'ws') })).rejects.toThrow(/symbolic link/)
    // Not checked for read-only runs, full access, or an OS-sandboxed preset.
    expect((await (await t.start({ cwd: ws, preset: 'read-only', access: 'read-only' })).result).stopReason).toBe(
      'completed',
    )
    const full = await t.start({ cwd: ws, preset: 'bypassPermissions', access: 'full-access' })
    expect((await full.result).stopReason).toBe('completed')
    const codex = runSetup(CODEX, { preset: 'workspace-write' })
    expect((await (await codex.start({ cwd: ws })).result).stopReason).toBe('completed')
  })

  it('refuses OpenCode below full access when the project has plugins it would run at start', async () => {
    const repo = tree({ '.git/HEAD': 'x', '.opencode/plugin/evil.js': '' })
    const t = runSetup(OPENCODE, { preset: 'read-only', access: 'read-only' })
    await expect(t.start({ cwd: repo })).rejects.toThrow(
      `OpenCode cannot run in ${repo}: the project has .opencode/plugin or .opencode/plugins code`,
    )
    const full = await t.start({ cwd: repo, preset: 'full-access', access: 'full-access' })
    expect((await full.result).stopReason).toBe('completed')
  })
})

describe('engine lifetime and structured env', () => {
  it('never spawns when the plugin unloads while the run is starting, and removes its files', async () => {
    const lifetime = new AbortController()
    const tmp = mkdtempSync(join(tmpdir(), 'rolesubagents-life-'))
    const subprocess = fakeSubprocess()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const original = subprocess.resolveExecutable.bind(subprocess)
    subprocess.resolveExecutable = async (command, env, sig) => {
      await gate
      return original(command, env, sig)
    }
    const adapter = testAdapter({ plan: () => ({ files: { '${RUN_DIR}/x': 'x' } }) })
    const started = startExternalRun(
      {
        adapter,
        input: {
          runner: { cli: 'codex', permission: 'workspace-write' },
          preset: 'workspace-write',
          access: 'workspace-write',
          instructions: '',
          task: 't',
          cwd: tmpdir(),
        },
        settings: {},
        timeoutMs: 60_000,
        signal,
      },
      {
        subprocess: () => subprocess,
        logger: { info: vi.fn(), warn: vi.fn() },
        runs: new Set(),
        tmpDir: tmp,
        lifetime: lifetime.signal,
      },
    )
    await new Promise(resolve => setTimeout(resolve, 10))
    lifetime.abort(new Error('unloaded'))
    release()
    await expect(started).rejects.toThrow('unloaded')
    expect(subprocess.processes).toHaveLength(0)
    expect(readdirSync(tmp)).toEqual([])
  })

  it('passes envJson as valid JSON even when the run directory contains a backslash', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'rolesubagents-bs-'))
    const tmp = join(parent, 'a\\b')
    mkdirSync(tmp)
    const subprocess = fakeSubprocess()
    const adapter = testAdapter({
      plan: () => ({
        envJson: { CONFIG: { path: '${RUN_DIR}/x', note: '{env:HOME} $x' } },
        files: { '${RUN_DIR}/x': 'x' },
      }),
    })
    const run = await startExternalRun(
      {
        adapter,
        input: {
          runner: { cli: 'codex', permission: 'workspace-write' },
          preset: 'workspace-write',
          access: 'workspace-write',
          instructions: '',
          task: 't',
          cwd: tmpdir(),
        },
        settings: {},
        timeoutMs: 60_000,
        signal,
      },
      { subprocess: () => subprocess, logger: { info: vi.fn(), warn: vi.fn() }, runs: new Set(), tmpDir: tmp },
    )
    await run.result
    const text = subprocess.processes[0]?.spec.env?.CONFIG as string
    expect(text).not.toContain('{env:')
    const config = JSON.parse(text)
    expect(config.path.startsWith(join(tmp, 'dsh-rolesubagents-'))).toBe(true)
    expect(config.note).toBe('{env:HOME} $x')
  })
})
