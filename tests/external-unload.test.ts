import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/host/index.ts'
import type { SubagentRunPort } from '../src/host/ports.ts'
import { fakeSubprocess, line, testAdapter } from './external-fakes.ts'
import { execContext, fakeWorld, registeredTool, role } from './host-fakes.ts'

vi.mock('@deepseek-ai/dsh-tools', () => import('./host-fakes.ts').then(module => module.toolsModule()))
vi.mock('@deepseek-ai/dsh-storage-domain', () => import('./host-fakes.ts').then(m => m.storageDomainModule()))

const CODER = role('coder', { runner: { cli: 'codex', permission: 'danger-full-access' } })

async function boot(cancellable = false) {
  const root = mkdtempSync(join(tmpdir(), 'rolesubagents-unload-'))
  const world = fakeWorld()
  const subprocess = fakeSubprocess({ ignoreTerminate: true, onRun: () => {} })
  world.services.subprocess = subprocess
  world.services.sandboxPolicy = { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: root }) }
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal engine placeholder
  const runFile = '${RUN_DIR}/task.txt'
  const adapter = testAdapter({
    cancellable,
    plan: () => ({ argv: [runFile], files: { [runFile]: 'fixture task' } }),
  })
  const closes: string[] = []
  const storage = world.services.storageDomain!
  world.services.storageDomain = {
    async open(spec) {
      const domain = await storage.open(spec)
      return {
        ...domain,
        close: async () => {
          closes.push((spec as { name: string }).name)
          await domain.close()
        },
      }
    },
  }
  const load = async (id: string) => {
    apply(world.ctx, { roles: [CODER] }, { adapters: () => adapter })
    const parent = world.newAgent(id)
    await world.emitCreated(parent)
    return () =>
      registeredTool(parent).execute(
        { role: 'coder', description: 'fixture', prompt: 'fixture task', cwd: root },
        execContext(parent),
      )
  }
  const call = await load('parent')
  const file = (index: number) => subprocess.processes[index]!.spec.argv[1]!
  const cleanup = async () => {
    for (const process of subprocess.processes) process.exit(null, 'SIGTERM')
    await Promise.allSettled(world.externalRuns.map(run => run.dispose()))
    await world.teardown()
    rmSync(root, { recursive: true, force: true })
  }
  return { world, subprocess, adapter, closes, load, call, file, cleanup }
}

describe('plugin unload external-run barrier', () => {
  it.each([false, true])(
    'waits for exit, file cleanup and range exit before reload (graceful: %s)',
    async cancellable => {
      const t = await boot(cancellable)
      let releaseRange!: () => void
      const range = new Promise<void>(resolve => {
        releaseRange = resolve
      })
      const spawn = t.subprocess.spawn.bind(t.subprocess)
      const rangeWait = vi.fn(async () => {
        await range
        return true
      })
      t.subprocess.spawn = spec => ({ ...spawn(spec), waitForExit: rangeWait })
      let unloading: Promise<void> | undefined
      try {
        await t.call()
        const run = t.world.externalRuns[0]!
        const process = t.subprocess.processes[0]!
        const oldFile = t.file(0)
        expect(existsSync(oldFile)).toBe(true)
        let unloaded = false
        unloading = t.world.teardown().then(() => {
          unloaded = true
        })
        if (cancellable) expect(t.adapter.sessions[0]?.cancelled).toBe(1)
        await vi.waitFor(() => expect(process.terminated).toBeGreaterThan(0))
        await t.world.settle()
        expect(process.exited).toBe(false)
        expect(unloaded).toBe(false)
        expect(existsSync(oldFile)).toBe(true)
        process.exit(null, 'SIGTERM')
        expect((await run.result).stopReason).toBe('aborted')
        await vi.waitFor(() => expect(rangeWait).toHaveBeenCalledTimes(1))
        expect(existsSync(dirname(oldFile))).toBe(false)
        expect(unloaded).toBe(false)
        releaseRange()
        await unloading
        expect(unloaded).toBe(true)
        expect(t.closes).toContain('rolesubagents')
        await expect(t.call()).rejects.toThrow(/calling agent changed/)

        // A caller awaiting unload starts the next lifetime only after the old range is empty.
        const next = await t.load('reloaded')
        await next()
        expect(t.file(1)).not.toBe(oldFile)
        expect(existsSync(t.file(1))).toBe(true)
        const nextProcess = t.subprocess.processes[1]!
        nextProcess.stdout(line({ type: 'text', text: 'new lifetime' }))
        nextProcess.stdout(line({ type: 'done' }))
        nextProcess.exit(0)
        expect(await t.world.externalRuns[1]!.result).toEqual({
          stopReason: 'completed',
          output: [{ type: 'text', text: 'new lifetime' }],
        })
      } finally {
        releaseRange()
        await t.cleanup()
        await unloading
      }
    },
  )

  it.each(['reject', 'throw'])(
    'isolates a disposal %s while waiting for other runs and closing storage',
    async failure => {
      const t = await boot()
      let unloading: Promise<void> | undefined
      try {
        await t.call()
        await t.call()
        const first = t.world.externalRuns[0]!
        const dispose = first.dispose.bind(first)
        const broken = vi.spyOn(first, 'dispose').mockImplementationOnce(() => {
          if (failure === 'throw') throw new Error('fixture disposal failed')
          return Promise.reject(new Error('fixture disposal failed'))
        })
        let unloaded = false
        unloading = t.world.teardown().then(() => {
          unloaded = true
        })
        // Handle an old implementation's synchronous cleanup failure without an unhandled rejection.
        void unloading.catch(() => {})
        await t.world.settle()
        expect(t.subprocess.processes[1]!.terminated).toBeGreaterThan(0)
        expect(unloaded).toBe(false)
        expect(t.world.logger.warn).toHaveBeenCalledWith(
          expect.stringContaining(`could not stop external run ${first.id}`),
        )
        t.subprocess.processes[1]!.exit(null, 'SIGTERM')
        await unloading
        expect(t.closes).toContain('rolesubagents')
        expect(existsSync(dirname(t.file(1)))).toBe(false)
        // The injected failing disposer leaves its fixture for the test owner to recover.
        broken.mockRestore()
        t.subprocess.processes[0]!.exit(null, 'SIGTERM')
        await dispose()
      } finally {
        vi.restoreAllMocks()
        await t.cleanup()
        await unloading?.catch(() => {})
      }
    },
  )

  it('preserves success, failure, cancellation and an explicit retry before unload', async () => {
    const t = await boot()
    try {
      const finish = async (status: 'completed' | 'error') => {
        await t.call()
        const index = t.world.externalRuns.length - 1
        const process = t.subprocess.processes[index]!
        if (status === 'completed') {
          process.stdout(line({ type: 'text', text: 'answer' }))
          process.stdout(line({ type: 'done' }))
        } else process.stdout(line({ type: 'error', category: 'auth' }))
        process.exit(status === 'completed' ? 0 : 1)
        const run = t.world.externalRuns[index] as SubagentRunPort
        expect((await run.result).stopReason).toBe(status)
        await run.dispose()
        expect(existsSync(dirname(t.file(index)))).toBe(false)
      }
      await finish('completed')
      await finish('error')
      await finish('completed') // User-initiated retry, with a fresh run and private files.
      await t.call()
      const cancelled = t.world.externalRuns[3]!
      const disposing = cancelled.dispose()
      let unloaded = false
      const unloading = t.world.teardown().then(() => {
        unloaded = true
      })
      await t.world.settle()
      expect(unloaded).toBe(false)
      t.subprocess.processes[3]!.exit(null, 'SIGTERM')
      await Promise.all([disposing, unloading])
      expect((await cancelled.result).stopReason).toBe('aborted')
      expect(existsSync(dirname(t.file(3)))).toBe(false)
      expect(new Set(t.subprocess.processes.map((_, i) => t.file(i))).size).toBe(4)
    } finally {
      await t.cleanup()
    }
  })
})
