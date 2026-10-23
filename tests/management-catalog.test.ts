import { constants } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLI_IDS, cliDescriptor } from '../src/shared/cli/index.ts'
import {
  createManagementCatalog,
  type CatalogCachedProbe,
  type CatalogDeps,
  type CatalogLlm,
} from '../src/host/management/catalog.ts'

const START = Date.parse('2026-10-23T00:00:00Z')
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    // Delete only the exact canonical disposable directory minted by fixture().
    if ((await realpath(root)) !== root) throw new Error('Unexpected fixture target')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roles-management-catalog-')))
  roots.push(root)
  const home = join(root, 'home')
  const pi = join(home, '.pi', 'agent')
  const grok = join(home, '.grok')
  await mkdir(pi, { recursive: true })
  await mkdir(grok, { recursive: true })
  return { root, home, pi, grok, models: join(pi, 'models.json'), config: join(grok, 'config.toml') }
}
function registry() {
  const listProviders = vi.fn(() => [
    { id: 'one', name: 'Provider One' },
    { id: 'two', name: 'Provider Two' },
  ])
  const listModels = vi.fn(async (_provider: string) => [
    { id: 'alpha', name: 'Alpha' },
    { id: 'beta', name: 'Beta' },
  ])
  const resolveModelInfo = vi.fn(
    async (_provider: string, _model: string): Promise<unknown> => ({
      reasoning: {
        efforts: [
          { id: 'low', name: 'Low' },
          { id: 'high', name: 'High' },
        ],
        defaultEffort: 'high',
      },
      endpoint: 'PRIVATE_ENDPOINT',
      headers: { authorization: 'PRIVATE_HEADER' },
      apiKey: 'PRIVATE_KEY',
    }),
  )
  return { listProviders, listModels, resolveModelInfo }
}
function catalog(overrides: Partial<CatalogDeps> = {}) {
  return createManagementCatalog({ llm: () => undefined, hostEnv: {}, now: () => START, ...overrides })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

describe('management reference catalog', () => {
  it('projects all descriptors without process/service discovery or declaring caller authorization', async () => {
    const llm = vi.fn(() => {
      throw new Error('must not inspect registry')
    })
    const probe = vi.fn(() => {
      throw new Error('must not probe')
    })
    const result = await catalog({ llm, cachedProbe: probe, sandboxAvailable: () => true }).capabilities()
    expect(result.targets.map(item => item.target)).toEqual(['dsh', ...CLI_IDS])
    expect(llm).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
    for (const cli of CLI_IDS) {
      const capability = result.targets.find(item => item.target === cli)!
      const descriptor = cliDescriptor(cli)
      expect(capability.permissionPresets).toEqual(descriptor.permissions)
      expect(capability.defaultPermission).toBe(descriptor.defaultPermission)
      expect(capability.needsProvider).toBe(descriptor.needsProvider)
      expect(capability.readOnlySupported).toBe(descriptor.presetForAccess['read-only'] !== undefined)
      expect(capability.limitations).toContain('sandbox-enforcement-not-probed')
      expect(capability.limitations).toContain('permissions-are-not-caller-authorization')
      expect(capability.hostSandbox).toBe('available')
    }
    expect(result.targets.find(item => item.target === 'dsh')).toMatchObject({
      permissionSource: 'parent-session',
      defaultPermission: null,
      contexts: ['spawn', 'fork'],
    })
  })
  it('does not mutate shared descriptors through returned capability values', async () => {
    const service = catalog()
    const capability = (await service.capabilities('pi')).targets[0]!
    ;(capability.permissionPresets[0] as { id: string }).id = 'mutated'
    ;(capability.efforts as string[]).push('injected')
    const fresh = (await service.capabilities('pi')).targets[0]!
    expect(fresh.defaultPermission).toBe('workspace-write')
    expect(fresh.permissionPresets[0]?.id).toBe('workspace-write')
    expect(fresh.efforts).not.toContain('injected')
    expect(fresh.readOnlySupported).toBe(false)
    expect(fresh.hostSandbox).toBe('unknown')
  })
  it('does not certify enforcement when availability callback fails', async () => {
    const result = await catalog({
      sandboxAvailable: () => {
        throw new Error('PRIVATE_BACKEND')
      },
    }).capabilities('grok-build')
    expect(result.targets[0]?.hostSandbox).toBe('unknown')
    expect(JSON.stringify(result)).not.toContain('PRIVATE_BACKEND')
  })
  it('returns a paged provider roster without fetching every provider model list', async () => {
    const llm = registry()
    const service = catalog({ llm: () => llm })
    const first = await service.models({ target: 'dsh', limit: 1 })
    expect(first).toMatchObject({
      pageKind: 'providers',
      status: 'ready',
      coverage: 'provider-roster',
      total: 2,
      nextOffset: 1,
      authentication: 'not-verified',
    })
    expect(first.providers).toEqual([{ id: 'one', name: 'Provider One' }])
    expect(first.models).toEqual([])
    expect(llm.listModels).not.toHaveBeenCalled()
    expect(llm.resolveModelInfo).not.toHaveBeenCalled()
    const second = await service.models({ target: 'dsh', limit: 1, offset: 1 })
    expect(second.providers[0]?.id).toBe('two')
    expect(llm.listProviders).toHaveBeenCalledOnce()
  })
  it('queries only the requested provider and strips every non-model field', async () => {
    const llm = registry()
    const result = await catalog({ llm: () => llm }).models({ target: 'dsh', provider: 'one', query: 'ALP' })
    expect(llm.listModels).toHaveBeenCalledExactlyOnceWith('one')
    expect(result).toMatchObject({
      pageKind: 'models',
      status: 'ready',
      coverage: 'provider-models',
      total: 1,
      manualIdsAllowed: true,
    })
    expect(result.models[0]).toEqual({
      id: 'alpha',
      name: 'Alpha',
      provider: 'one',
      model: 'alpha',
      efforts: ['low', 'high'],
      effortsKnown: true,
      defaultEffort: 'high',
      source: 'registry',
      fetchedAt: new Date(START).toISOString(),
    })
    const serialized = JSON.stringify(result)
    for (const forbidden of ['PRIVATE_KEY', 'PRIVATE_HEADER', 'PRIVATE_ENDPOINT', 'authorization', 'apiKey'])
      expect(serialized).not.toContain(forbidden)
  })
  it('refuses unlisted provider lookup without leaking the caller input', async () => {
    const llm = registry()
    const result = await catalog({ llm: () => llm }).models({ target: 'dsh', provider: 'PRIVATE_UNKNOWN' })
    expect(result.status).toBe('unknown')
    expect(result.failures).toEqual([{ code: 'unknown-provider' }])
    expect(llm.listModels).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('PRIVATE_UNKNOWN')
  })
  it('isolates model-info failures and preserves the listed model ids', async () => {
    const llm = registry()
    llm.resolveModelInfo.mockImplementation(async (_provider, model) => {
      if (model === 'alpha') throw new Error('PRIVATE_PROVIDER_ERROR')
      return { reasoning: { efforts: [{ id: 'high' }] } }
    })
    const result = await catalog({ llm: () => llm }).models({ target: 'dsh', provider: 'two' })
    expect(result.status).toBe('partial')
    expect(result.models.map(item => item.id)).toEqual(['alpha', 'beta'])
    expect(result.models[0]).toMatchObject({ effortsKnown: false, efforts: [] })
    expect(result.models[1]?.efforts).toEqual(['high'])
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PROVIDER_ERROR')
  })
  it('retains last good provider data with original timestamps after failed refresh', async () => {
    const llm = registry()
    let now = START
    const service = catalog({ llm: () => llm, now: () => now })
    const good = await service.models({ target: 'dsh', provider: 'one' })
    now += 10_000
    llm.listModels.mockRejectedValue(new Error('PRIVATE_PROVIDER_URL_KEY'))
    const failed = await service.models({ target: 'dsh', provider: 'one', refresh: true })
    expect(failed).toMatchObject({
      status: 'error',
      stale: true,
      fetchedAt: good.fetchedAt,
      lastAttemptAt: new Date(now).toISOString(),
    })
    expect(failed.models).toEqual(good.models)
    expect(failed.failures).toEqual([{ code: 'provider-unavailable', provider: 'one' }])
    expect(JSON.stringify(failed)).not.toContain('PRIVATE_PROVIDER_URL_KEY')
    await service.models({ target: 'dsh', provider: 'one' })
    expect(llm.listModels).toHaveBeenCalledTimes(2)
  })
  it('retains known model metadata when only its refresh resolution fails', async () => {
    const llm = registry()
    let now = START
    const service = catalog({ llm: () => llm, now: () => now })
    const good = await service.models({ target: 'dsh', provider: 'one' })
    now += 1000
    llm.resolveModelInfo.mockRejectedValue(new Error('PRIVATE'))
    const latest = await service.models({ target: 'dsh', provider: 'one', refresh: true })
    expect(latest.status).toBe('partial')
    expect(latest.stale).toBe(true)
    expect(latest.models).toEqual(good.models)
  })
  it('expires cache, supports targeted invalidation, and isolates provider cache keys', async () => {
    const llm = registry()
    let now = START
    const service = catalog({ llm: () => llm, now: () => now })
    await service.models({ target: 'dsh', provider: 'one' })
    await service.models({ target: 'dsh', provider: 'one', query: 'beta', limit: 1 })
    await service.models({ target: 'dsh', provider: 'two' })
    expect(llm.listModels).toHaveBeenCalledTimes(2)
    now += 30_000
    await service.models({ target: 'dsh', provider: 'one' })
    expect(llm.listModels).toHaveBeenCalledTimes(3)
    service.invalidate('pi')
    await service.models({ target: 'dsh', provider: 'one' })
    expect(llm.listModels).toHaveBeenCalledTimes(3)
    service.invalidate('dsh')
    await service.models({ target: 'dsh', provider: 'one' })
    expect(llm.listModels).toHaveBeenCalledTimes(4)
  })
  it('bounds pagination and diagnostic projection on malformed registry metadata', async () => {
    const llm = registry()
    llm.listModels.mockResolvedValue(
      Array.from({ length: 250 }, (_, index) => ({ id: `m${index}`, name: `Model ${index}` })),
    )
    llm.resolveModelInfo.mockRejectedValue(new Error('PRIVATE'))
    const service = catalog({ llm: () => llm })
    const result = await service.models({ target: 'dsh', provider: 'one', limit: 500, offset: 1.9 })
    expect(result).toMatchObject({ limit: 100, offset: 1, total: 250, nextOffset: 101, status: 'partial' })
    expect(result.models).toHaveLength(100)
    expect(result.failures).toHaveLength(20)
    expect(result.limitations).toContain('diagnostics-truncated')
    const sanitized = await service.models({ target: 'dsh', provider: 'one', limit: Number.NaN, offset: -50 })
    expect(sanitized).toMatchObject({ limit: 25, offset: 0 })
  })
  it('projects Pi configured IDs without reading auth or evaluating key/resource commands', async () => {
    const f = await fixture()
    const marker = join(f.root, 'MUST_NOT_EXECUTE')
    const original = JSON.stringify({
      providers: {
        custom: {
          baseUrl: 'PRIVATE_ENDPOINT',
          apiKey: `!touch ${marker}`,
          headers: { authorization: 'PRIVATE_HEADER' },
          models: [
            { id: 'alpha', name: 'Configured Alpha', apiKey: 'PRIVATE_MODEL_KEY', extension: `!touch ${marker}` },
          ],
          extensions: [marker],
        },
      },
    })
    await writeFile(f.models, original)
    await writeFile(join(f.pi, 'auth.json'), 'INVALID PRIVATE_AUTH_TOKEN')
    const result = await catalog({ hostEnv: { HOME: f.home } }).models({ target: 'pi' })
    expect(result).toMatchObject({
      status: 'partial',
      coverage: 'cli-candidates',
      authentication: 'not-verified',
      total: 1,
    })
    expect(result.models[0]).toEqual({
      id: 'custom/alpha',
      name: 'Configured Alpha',
      provider: 'custom',
      model: 'alpha',
      efforts: [],
      effortsKnown: false,
      source: 'configured',
      fetchedAt: new Date(START).toISOString(),
    })
    for (const forbidden of [
      'PRIVATE_ENDPOINT',
      'PRIVATE_HEADER',
      'PRIVATE_MODEL_KEY',
      'PRIVATE_AUTH_TOKEN',
      marker,
      'apiKey',
    ])
      expect(JSON.stringify(result)).not.toContain(forbidden)
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(f.models, 'utf8')).toBe(original)
  })
  it('recognizes Grok header aliases but ignores comments, nested headers and multiline secret bodies', async () => {
    const f = await fixture()
    await writeFile(
      f.config,
      `api_key = """\n[model.PRIVATE_SECRET]\n"""\nother = '''\n[model.PRIVATE_LITERAL]\n'''\n# [model.comment]\n[model.alpha]\napi_key = "!touch NEVER_RUN"\n[model."gpt-4.1"] # metadata\n[model.'local:model']\n[model.parent.child]\n`,
    )
    const result = await catalog({ hostEnv: { HOME: f.home } }).models({ target: 'grok-build' })
    expect(result.models.map(item => item.id)).toEqual(['alpha', 'gpt-4.1', 'local:model'])
    expect(result.models.every(item => item.source === 'configured')).toBe(true)
    expect(result.limitations).toContain('grok-model-headers-only')
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|NEVER_RUN|api_key/)
  })
  it('uses only explicit native directory overrides and invalidates when the source path changes', async () => {
    const f = await fixture()
    const override = join(f.root, 'override')
    await mkdir(override)
    await writeFile(
      join(override, 'models.json'),
      JSON.stringify({ providers: { other: { models: [{ id: 'override' }] } } }),
    )
    await writeFile(f.models, JSON.stringify({ providers: { home: { models: [{ id: 'default' }] } } }))
    const env = { HOME: f.home, PI_CODING_AGENT_DIR: override }
    const service = catalog({ hostEnv: env })
    expect((await service.models({ target: 'pi' })).models[0]?.id).toBe('other/override')
    env.PI_CODING_AGENT_DIR = f.pi
    expect((await service.models({ target: 'pi' })).models[0]?.id).toBe('home/default')
    await writeFile(f.config, '[model.home]\n')
    expect(
      (await catalog({ hostEnv: { HOME: f.home, GROK_HOME: '~/.grok' } }).models({ target: 'grok-build' })).models[0]
        ?.id,
    ).toBe('home')
  })
  it('does not fall back to actual HOME when an isolated environment lacks native paths', async () => {
    const result = await catalog({ hostEnv: { PI_CODING_AGENT_DIR: 'relative-path' } }).models({ target: 'pi' })
    expect(result.status).toBe('unknown')
    expect(result.models).toEqual([])
    expect(result.limitations).toContain('configured-model-path-unavailable')
  })
  it('marks static config failure stale without losing the last good configured catalog', async () => {
    const f = await fixture()
    await writeFile(f.models, JSON.stringify({ providers: { fake: { models: [{ id: 'retained' }] } } }))
    let now = START
    const service = catalog({ hostEnv: { HOME: f.home }, now: () => now })
    const good = await service.models({ target: 'pi' })
    await writeFile(f.models, 'INVALID_PRIVATE_CONFIG')
    now += 1000
    const failed = await service.models({ target: 'pi', refresh: true })
    expect(failed.models).toEqual(good.models)
    expect(failed).toMatchObject({ status: 'error', stale: true, fetchedAt: good.fetchedAt })
    expect(failed.failures).toEqual([{ code: 'configuration-invalid' }])
    expect(JSON.stringify(failed)).not.toContain('INVALID_PRIVATE_CONFIG')
  })
  it('does not consume oversized or non-regular configuration files', async () => {
    const f = await fixture()
    await writeFile(f.models, Buffer.alloc(1024 * 1024 + 1, 32))
    const result = await catalog({ hostEnv: { HOME: f.home } }).models({ target: 'pi' })
    expect(result).toMatchObject({
      status: 'error',
      fetchedAt: null,
      models: [],
      failures: [{ code: 'configuration-unavailable' }],
    })
    const directory = join(f.root, 'directory')
    await mkdir(directory)
    await mkdir(join(directory, 'models.json'))
    expect((await catalog({ hostEnv: { PI_CODING_AGENT_DIR: directory } }).models({ target: 'pi' })).failures).toEqual([
      { code: 'configuration-unavailable' },
    ])
  })
  it.skipIf(process.platform === 'win32' || constants.O_NOFOLLOW === undefined)(
    'does not follow config-file symlinks into credential stores',
    async () => {
      const f = await fixture()
      await writeFile(
        join(f.pi, 'auth.json'),
        JSON.stringify({ providers: { PRIVATE_AUTH: { models: [{ id: 'PRIVATE_TOKEN' }] } } }),
      )
      await symlink(join(f.pi, 'auth.json'), f.models)
      const result = await catalog({ hostEnv: { HOME: f.home } }).models({ target: 'pi' })
      expect(result.failures).toEqual([{ code: 'configuration-unavailable' }])
      expect(JSON.stringify(result)).not.toContain('PRIVATE')
    },
  )
  it('uses cached probe metadata without launching anything and retains original observation time', async () => {
    const probe = vi.fn(
      (_cli: unknown): CatalogCachedProbe =>
        ({
          found: true,
          fetchedAt: new Date(START - 60_000).toISOString(),
          models: [{ id: 'custom/alpha', name: 'Observed', efforts: ['low', 'high'] }],
          auth: 'PRIVATE_AUTH',
          endpoint: 'PRIVATE_ENDPOINT',
        }) as CatalogCachedProbe,
    )
    const service = catalog({ cachedProbe: probe })
    const result = await service.models({ target: 'pi' })
    expect(result.models[0]).toMatchObject({
      id: 'custom/alpha',
      provider: 'custom',
      model: 'alpha',
      source: 'observed-cli',
      fetchedAt: new Date(START - 60_000).toISOString(),
      efforts: ['low', 'high'],
      effortsKnown: true,
    })
    expect(result.stale).toBe(true)
    expect(result.authentication).toBe('not-verified')
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    await service.models({ target: 'pi', refresh: true })
    expect(probe).toHaveBeenCalledTimes(2)
  })
  it('provides builtin candidates without pretending they were observed or are complete', async () => {
    const result = await catalog().models({ target: 'codex' })
    expect(result.status).toBe('partial')
    expect(result.models.map(item => item.id)).toEqual(cliDescriptor('codex').modelSuggestions)
    expect(result.models.every(item => item.source === 'built-in' && !item.effortsKnown)).toBe(true)
    expect(result.limitations).toContain('cli-not-executed')
    expect(result.limitations).toContain('candidate-list-not-complete')
  })
  it('reports missing registry and probe failures with fixed vocabulary only', async () => {
    const missing = await catalog({
      llm: () => {
        throw new Error('PRIVATE_REGISTRY')
      },
    }).models({ target: 'dsh' })
    expect(missing.failures).toEqual([{ code: 'registry-unavailable' }])
    const failed = await catalog({
      cachedProbe: () => {
        throw new Error('PRIVATE_PROBE')
      },
    }).models({ target: 'pi' })
    expect(failed.failures).toEqual([{ code: 'cached-probe-unavailable' }])
    expect(JSON.stringify([missing, failed])).not.toContain('PRIVATE')
  })
  it('rejects cancellation before any metadata source is accessed', async () => {
    const llm = vi.fn(() => registry())
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)
    await expect(catalog({ llm }).models({ target: 'dsh' }, controller.signal)).rejects.toBe(reason)
    expect(llm).not.toHaveBeenCalled()
  })
  it('aborts pending registry metadata without caching a late result', async () => {
    const llm = registry()
    const waiting = deferred<{ id: string; name: string }[]>()
    const started = deferred<void>()
    llm.listModels.mockImplementationOnce(() => {
      started.resolve()
      return waiting.promise
    })
    const service = catalog({ llm: () => llm })
    const controller = new AbortController()
    const reason = new Error('cancelled pending registry')
    const pending = service.models({ target: 'dsh', provider: 'one' }, controller.signal)
    await started.promise
    controller.abort(reason)
    await expect(pending).rejects.toBe(reason)
    waiting.resolve([{ id: 'late', name: 'Late' }])
    const fresh = await service.models({ target: 'dsh', provider: 'one' })
    expect(fresh.models.map(item => item.id)).toEqual(['alpha', 'beta'])
    expect(llm.listModels).toHaveBeenCalledTimes(2)
  })
  it('returns detached result arrays and never calls secret-config or inference methods', async () => {
    const llm: CatalogLlm = Object.defineProperties(registry(), {
      generate: {
        get() {
          throw new Error('inference forbidden')
        },
      },
      resolveCallConfig: {
        get() {
          throw new Error('secret resolution forbidden')
        },
      },
    })
    const service = catalog({ llm: () => llm })
    const first = await service.models({ target: 'dsh', provider: 'one' })
    ;(first.models[0]!.efforts as string[]).push('mutated')
    ;(first.providers[0] as { name: string }).name = 'mutated'
    const next = await service.models({ target: 'dsh', provider: 'one' })
    expect(next.models[0]?.efforts).toEqual(['low', 'high'])
    expect(next.providers[0]?.name).toBe('Provider One')
  })
  it('retains failed configured source data even when another source refreshes successfully', async () => {
    const f = await fixture()
    await writeFile(f.models, JSON.stringify({ providers: { custom: { models: [{ id: 'configured' }] } } }))
    let now = START
    const service = catalog({
      hostEnv: { HOME: f.home },
      now: () => now,
      cachedProbe: () => ({ models: [{ id: 'custom/observed' }], fetchedAt: new Date(now).toISOString() }),
    })
    const original = await service.models({ target: 'pi' })
    now += 1000
    await writeFile(f.models, 'invalid')
    const latest = await service.models({ target: 'pi', refresh: true })
    expect(latest).toMatchObject({ status: 'partial', stale: true })
    expect(latest.models.map(model => model.id)).toEqual(['custom/observed', 'custom/configured'])
    expect(latest.models[1]?.fetchedAt).toBe(original.models[1]?.fetchedAt)
    expect(latest.limitations).toContain('stale-source-retained')
  })
  it('marks malformed or excessive effort metadata unknown rather than fully supported', async () => {
    const llm = registry()
    llm.resolveModelInfo.mockResolvedValue({
      reasoning: { efforts: [{ id: 'high' }, 'PRIVATE_UNKNOWN'], defaultEffort: 'high' },
    })
    const result = await catalog({ llm: () => llm }).models({ target: 'dsh', provider: 'one' })
    expect(result.status).toBe('partial')
    expect(result.models[0]).toMatchObject({ efforts: ['high'], effortsKnown: false })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_UNKNOWN')
    const cached = await catalog({
      cachedProbe: () => ({
        models: [{ id: 'model', efforts: ['high', 'unsafe newline\\nvalue'] }],
        fetchedAt: new Date(START).toISOString(),
      }),
    }).models({ target: 'pi' })
    expect(cached.models[0]).toMatchObject({ efforts: ['high'], effortsKnown: false })
    expect(cached.failures).toContainEqual({ code: 'invalid-metadata' })
  })
  it('does not repaint an invalidated cache when an older metadata lookup settles late', async () => {
    const llm = registry()
    const waiting = deferred<{ id: string; name: string }[]>()
    const started = deferred<void>()
    llm.listModels.mockImplementationOnce(() => {
      started.resolve()
      return waiting.promise
    })
    const service = catalog({ llm: () => llm })
    const pending = service.models({ target: 'dsh', provider: 'one' })
    await started.promise
    service.invalidate('dsh')
    waiting.resolve([{ id: 'stale', name: 'Stale metadata' }])
    await expect(pending).rejects.toMatchObject({ code: 'catalog-invalidated' })
    const fresh = await service.models({ target: 'dsh', provider: 'one' })
    expect(fresh.models.map(model => model.id)).toEqual(['alpha', 'beta'])
    expect(llm.listModels).toHaveBeenCalledTimes(2)
  })
})
