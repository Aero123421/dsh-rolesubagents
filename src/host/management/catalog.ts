/** Read-only reference data for role management. No CLI, inference, config evaluation or authentication calls. */
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { CLI_IDS, type CliId, type PermissionPreset, cliDescriptor, isCliId } from '../../shared/cli/index.ts'
import { type CliSettingsMap, RUNNER_NAME_PATTERN } from '../../shared/runner.ts'
import type { ProbeModel } from '../external/types.ts'

export type CatalogTarget = 'dsh' | CliId
export type CatalogStatus = 'ready' | 'partial' | 'unknown' | 'error'
export type CatalogModelSource = 'registry' | 'observed-cli' | 'configured' | 'built-in'
export interface CatalogProvider {
  readonly id: string
  readonly name: string
}
export interface CatalogModel {
  readonly id: string
  readonly name: string
  readonly provider?: string
  readonly model?: string
  readonly efforts: readonly string[]
  readonly effortsKnown: boolean
  readonly defaultEffort?: string
  readonly source: CatalogModelSource
  readonly fetchedAt: string | null
}
export interface CatalogLlm {
  listProviders():
    | readonly { readonly id: string; readonly name?: string }[]
    | Promise<readonly { readonly id: string; readonly name?: string }[]>
  listModels(
    provider: string,
  ):
    | readonly { readonly id: string; readonly name?: string }[]
    | Promise<readonly { readonly id: string; readonly name?: string }[]>
  resolveModelInfo(provider: string, model: string): unknown | Promise<unknown>
}
export interface CatalogCachedProbe {
  readonly models?: readonly ProbeModel[]
  readonly found?: boolean
  /** When the previous real probe ran, not when this getter was called. */
  readonly fetchedAt?: string
}
export interface CatalogDeps {
  readonly llm: () => CatalogLlm | undefined
  readonly hostEnv?: Readonly<Record<string, string | undefined>>
  readonly cliSettings?: () => CliSettingsMap | undefined
  /** Memory/data lookup only. Must not start a probe or CLI process. */
  readonly cachedProbe?: (cli: CliId) => CatalogCachedProbe | undefined
  /** Service presence only; neither this callback nor the catalog may probe enforcement. */
  readonly sandboxAvailable?: () => boolean
  readonly now?: () => number
  readonly cacheTtlMs?: number
}
export interface CatalogModelsRequest {
  readonly target: CatalogTarget
  readonly provider?: string
  readonly query?: string
  readonly limit?: number
  readonly offset?: number
  readonly refresh?: boolean
}
export type CatalogFailureCode =
  | 'registry-unavailable'
  | 'providers-unavailable'
  | 'unknown-provider'
  | 'provider-unavailable'
  | 'model-metadata-unavailable'
  | 'invalid-metadata'
  | 'configuration-unavailable'
  | 'configuration-invalid'
  | 'cached-probe-unavailable'
  | 'metadata-limit'
export interface CatalogFailure {
  readonly code: CatalogFailureCode
  readonly provider?: string
  readonly model?: string
}
export interface CatalogModelsResult {
  readonly target: CatalogTarget
  readonly pageKind: 'providers' | 'models'
  readonly status: CatalogStatus
  readonly coverage: 'provider-roster' | 'provider-models' | 'cli-candidates' | 'unknown'
  readonly models: readonly CatalogModel[]
  readonly providers: readonly CatalogProvider[]
  readonly fetchedAt: string | null
  readonly lastAttemptAt: string
  readonly stale: boolean
  readonly authentication: 'not-verified'
  readonly manualIdsAllowed: true
  readonly failures: readonly CatalogFailure[]
  readonly limitations: readonly string[]
  readonly offset: number
  readonly limit: number
  readonly total: number
  readonly nextOffset: number | null
}
export interface CatalogTargetCapabilities {
  readonly target: CatalogTarget
  readonly name: string
  readonly needsProvider: boolean
  readonly modelRequired: boolean
  readonly permissionPresets: readonly PermissionPreset[]
  readonly defaultPermission: string | null
  readonly permissionSource: 'parent-session' | 'cli-presets'
  readonly efforts: readonly string[]
  readonly effortFreeText: boolean
  readonly readOnlySupported: boolean
  readonly contexts: readonly ('spawn' | 'fork')[]
  readonly manualIdsAllowed: true
  readonly hostSandbox: 'available' | 'unavailable' | 'unknown'
  readonly modelDiscovery: 'registry-metadata' | 'static-and-cached-only'
  readonly limitations: readonly string[]
}
export interface CatalogCapabilitiesResult {
  readonly generatedAt: string
  readonly targets: readonly CatalogTargetCapabilities[]
}
export interface ManagementCatalog {
  capabilities(target?: CatalogTarget): Promise<CatalogCapabilitiesResult>
  models(request: CatalogModelsRequest, signal?: AbortSignal): Promise<CatalogModelsResult>
  invalidate(target?: CatalogTarget): void
}

type Snapshot = Omit<CatalogModelsResult, 'offset' | 'limit' | 'total' | 'nextOffset'>
const MAX_FILE_BYTES = 1024 * 1024
const MAX_ITEMS = 1_000
const MAX_CACHE_ENTRIES = 64
const MAX_FAILURES = 20
const DEFAULT_TTL_MS = 30_000
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
function id(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined
}
function cliId(value: unknown): string | undefined {
  const result = id(value)
  return result && RUNNER_NAME_PATTERN.test(result) ? result : undefined
}
function name(value: unknown, fallback: string): string {
  return typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, 256) || fallback
    : fallback
}
function assertTarget(value: unknown): asserts value is CatalogTarget {
  if (value !== 'dsh' && !isCliId(value)) throw new Error('Unknown role catalog target')
}
function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}
async function observe<T>(call: () => T | PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  checkAbort(signal)
  const pending = Promise.resolve().then(() => {
    checkAbort(signal)
    return call()
  })
  if (!signal) return await pending
  let stop: (() => void) | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        stop = () => reject(signal.reason)
        signal.addEventListener('abort', stop, { once: true })
        if (signal.aborted) stop()
      }),
    ])
  } finally {
    if (stop) signal.removeEventListener('abort', stop)
  }
}
function timestamp(value: unknown, now: number): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) && parsed <= now + 60_000 ? new Date(parsed).toISOString() : null
}
function base(target: CatalogTarget, now: number): Snapshot {
  return {
    target,
    pageKind: 'models',
    status: 'unknown',
    coverage: 'unknown',
    models: [],
    providers: [],
    fetchedAt: null,
    lastAttemptAt: new Date(now).toISOString(),
    stale: false,
    authentication: 'not-verified',
    manualIdsAllowed: true,
    failures: [],
    limitations: ['model-listing-does-not-verify-authentication'],
  }
}
function nativeFile(
  target: 'pi' | 'grok-build',
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const override = target === 'pi' ? env.PI_CODING_AGENT_DIR : env.GROK_HOME
  let directory = override || (env.HOME ? join(env.HOME, target === 'pi' ? '.pi/agent' : '.grok') : undefined)
  if (directory?.startsWith('~/') || directory === '~') directory = env.HOME ? env.HOME + directory.slice(1) : undefined
  if (!directory || directory.length > 4096 || directory.includes('\0') || !isAbsolute(directory)) return undefined
  return join(directory, target === 'pi' ? 'models.json' : 'config.toml')
}
/** No following final-component symlinks or opening blocking devices/FIFOs as configuration. */
async function readBounded(path: string, signal?: AbortSignal): Promise<string | undefined> {
  checkAbort(signal)
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    checkAbort(signal)
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    checkAbort(signal)
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid bounded catalog source')
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1)
    let length = 0
    while (length < buffer.length) {
      checkAbort(signal)
      const part = await handle.read(buffer, length, buffer.length - length, null)
      if (!part.bytesRead) break
      length += part.bytesRead
    }
    checkAbort(signal)
    if (length > MAX_FILE_BYTES) throw new Error('Catalog source exceeds bound')
    return buffer.subarray(0, length).toString('utf8')
  } finally {
    await handle.close()
  }
}

/** Header-only TOML recognizer, with string/comment lexing so multiline secret values cannot become headers. */
function grokAliases(text: string): string[] {
  const aliases: string[] = []
  let state: 'normal' | 'basic' | 'literal' | 'multi-basic' | 'multi-literal' = 'normal'
  for (const line of text.split(/\r?\n/)) {
    if (state === 'normal') {
      const match = /^\s*\[\s*model\s*\.\s*([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')\s*\]\s*(?:#.*)?$/.exec(line)
      if (match) {
        const raw = match[1]!
        let alias: unknown = raw
        try {
          alias = raw.startsWith('"') ? JSON.parse(raw) : raw.startsWith("'") ? raw.slice(1, -1) : raw
        } catch {
          alias = undefined
        }
        const safe = cliId(alias)
        if (safe && aliases.length < MAX_ITEMS + 1) aliases.push(safe)
      }
    }
    for (let at = 0; at < line.length; at++) {
      const char = line[at]
      if (state === 'normal') {
        if (char === '#') break
        if (line.startsWith('"""', at)) {
          state = 'multi-basic'
          at += 2
        } else if (line.startsWith("'''", at)) {
          state = 'multi-literal'
          at += 2
        } else if (char === '"') state = 'basic'
        else if (char === "'") state = 'literal'
      } else if (state === 'basic') {
        if (char === '\\') at++
        else if (char === '"') state = 'normal'
      } else if (state === 'literal') {
        if (char === "'") state = 'normal'
      } else if (state === 'multi-basic') {
        if (char === '\\') at++
        else if (line.startsWith('"""', at)) {
          state = 'normal'
          at += 2
          while (line[at + 1] === '"' && at < line.length) at++
        }
      } else if (line.startsWith("'''", at)) {
        state = 'normal'
        at += 2
        while (line[at + 1] === "'" && at < line.length) at++
      }
    }
    if (state === 'basic' || state === 'literal') throw new Error('Malformed single-line TOML string')
  }
  if (state !== 'normal') throw new Error('Unterminated TOML string')
  return aliases
}

function projectedEfforts(info: unknown): { efforts: string[]; effortsKnown: boolean; defaultEffort?: string } {
  if (!record(info)) return { efforts: [], effortsKnown: false }
  if (info.reasoning === undefined) return { efforts: [], effortsKnown: true }
  if (!record(info.reasoning) || !Array.isArray(info.reasoning.efforts)) return { efforts: [], effortsKnown: false }
  const raw: readonly unknown[] = info.reasoning.efforts
  const projected = raw.slice(0, 32).map(value => (record(value) ? id(value.id) : undefined))
  const efforts = [...new Set(projected.filter((value): value is string => value !== undefined))]
  const fallback = id(info.reasoning.defaultEffort)
  const effortsKnown =
    raw.length <= 32 &&
    projected.every(value => value !== undefined) &&
    (info.reasoning.defaultEffort === undefined || (fallback !== undefined && efforts.includes(fallback)))
  return { efforts, effortsKnown, ...(fallback && efforts.includes(fallback) ? { defaultEffort: fallback } : {}) }
}
function row(
  modelId: string,
  modelName: unknown,
  source: CatalogModelSource,
  fetchedAt: string | null,
  provider?: string,
  model?: string,
): CatalogModel {
  return {
    id: modelId,
    name: name(modelName, modelId),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    efforts: [],
    effortsKnown: false,
    source,
    fetchedAt,
  }
}

export function createManagementCatalog(deps: CatalogDeps): ManagementCatalog {
  const clock = deps.now ?? Date.now
  const ttl =
    typeof deps.cacheTtlMs === 'number' && Number.isFinite(deps.cacheTtlMs) && deps.cacheTtlMs >= 0
      ? Math.min(deps.cacheTtlMs, 300_000)
      : DEFAULT_TTL_MS
  const cache = new Map<string, { checkedAt: number; snapshot: Snapshot }>()
  const generations = new Map<CatalogTarget, number>()
  function llm(): CatalogLlm | undefined {
    try {
      return deps.llm()
    } catch {
      return undefined
    }
  }
  function sandbox(): CatalogTargetCapabilities['hostSandbox'] {
    try {
      return deps.sandboxAvailable === undefined ? 'unknown' : deps.sandboxAvailable() ? 'available' : 'unavailable'
    } catch {
      return 'unknown'
    }
  }
  async function registry(
    provider: string | undefined,
    now: number,
    previous: Snapshot | undefined,
    signal?: AbortSignal,
  ): Promise<Snapshot> {
    const result = base('dsh', now)
    const service = llm()
    if (
      !service ||
      typeof service.listProviders !== 'function' ||
      typeof service.listModels !== 'function' ||
      typeof service.resolveModelInfo !== 'function'
    )
      return { ...result, status: 'error', failures: [{ code: 'registry-unavailable' }] }
    let raw: unknown
    try {
      raw = await observe(() => service.listProviders(), signal)
    } catch {
      checkAbort(signal)
      return { ...result, status: 'error', failures: [{ code: 'providers-unavailable' }] }
    }
    if (!Array.isArray(raw)) return { ...result, status: 'error', failures: [{ code: 'invalid-metadata' }] }
    const providers: CatalogProvider[] = []
    const failures: CatalogFailure[] = []
    const seen = new Set<string>()
    for (const value of raw.slice(0, MAX_ITEMS)) {
      const key = record(value) ? id(value.id) : undefined
      if (!key) {
        failures.push({ code: 'invalid-metadata' })
        continue
      }
      if (seen.has(key)) continue
      seen.add(key)
      providers.push({ id: key, name: name(value.name, key) })
    }
    if (raw.length > MAX_ITEMS) failures.push({ code: 'metadata-limit' })
    const fetchedAt = new Date(now).toISOString()
    if (!provider)
      return {
        ...result,
        pageKind: 'providers',
        status: failures.length ? 'partial' : 'ready',
        coverage: 'provider-roster',
        fetchedAt,
        providers,
        failures,
        limitations: [...result.limitations, 'select-provider-to-list-models'],
      }
    const selected = providers.find(item => item.id === provider)
    if (!selected)
      return {
        ...result,
        status: 'unknown',
        failures: [{ code: 'unknown-provider' }],
        limitations: [...result.limitations, 'select-a-listed-provider'],
      }
    let listed: unknown
    try {
      listed = await observe(() => service.listModels(provider), signal)
    } catch {
      checkAbort(signal)
      return { ...result, status: 'error', failures: [{ code: 'provider-unavailable', provider }] }
    }
    if (!Array.isArray(listed))
      return { ...result, status: 'error', failures: [{ code: 'invalid-metadata', provider }] }
    const models: CatalogModel[] = []
    const modelIds = new Set<string>()
    let stale = false
    for (const value of listed.slice(0, MAX_ITEMS)) {
      checkAbort(signal)
      const key = record(value) ? id(value.id) : undefined
      if (!key) {
        failures.push({ code: 'invalid-metadata', provider })
        continue
      }
      if (modelIds.has(key)) continue
      modelIds.add(key)
      let projected = row(key, value.name, 'registry', fetchedAt, provider, key)
      try {
        projected = {
          ...projected,
          ...projectedEfforts(await observe(() => service.resolveModelInfo(provider, key), signal)),
        }
      } catch {
        checkAbort(signal)
        failures.push({ code: 'model-metadata-unavailable', provider, model: key })
        const old = previous?.models.find(item => item.provider === provider && item.id === key)
        if (old) {
          projected = { ...old }
          stale = true
        }
      }
      if (!projected.effortsKnown) failures.push({ code: 'invalid-metadata', provider, model: key })
      models.push(projected)
    }
    if (listed.length > MAX_ITEMS) failures.push({ code: 'metadata-limit', provider })
    return {
      ...result,
      status: failures.length ? 'partial' : 'ready',
      coverage: 'provider-models',
      fetchedAt,
      models,
      providers: [selected],
      failures,
      stale,
    }
  }
  async function cli(target: CliId, now: number, signal?: AbortSignal): Promise<Snapshot> {
    const result = base(target, now)
    const descriptor = cliDescriptor(target)
    const fetchedAt = new Date(now).toISOString()
    const failures: CatalogFailure[] = []
    const candidates: CatalogModel[] = []
    const limitations = [
      ...result.limitations,
      'cli-not-executed',
      'candidate-list-not-complete',
      'manual-model-ids-allowed',
    ]
    let stale = false
    try {
      const observed = deps.cachedProbe?.(target)
      if (observed?.found !== false && Array.isArray(observed?.models)) {
        const observedAt = timestamp(observed.fetchedAt, now)
        stale = observed.models.length > 0 && (observedAt === null || now - Date.parse(observedAt) > ttl)
        for (const model of observed.models.slice(0, MAX_ITEMS)) {
          const key = record(model) ? cliId(model.id) : undefined
          if (!key) {
            failures.push({ code: 'invalid-metadata' })
            continue
          }
          const split = (target === 'pi' || descriptor.needsProvider) && key.includes('/') ? key.indexOf('/') : -1
          const rawEfforts: readonly unknown[] | undefined = Array.isArray(model.efforts) ? model.efforts : undefined
          const projected = rawEfforts?.slice(0, 32).map(cliId) ?? []
          const efforts = [...new Set(projected.filter((value): value is string => value !== undefined))]
          const effortsKnown =
            rawEfforts !== undefined && rawEfforts.length <= 32 && projected.every(value => value !== undefined)
          if (rawEfforts && !effortsKnown) failures.push({ code: 'invalid-metadata' })
          candidates.push({
            ...row(
              key,
              model.name,
              'observed-cli',
              observedAt,
              split > 0 ? key.slice(0, split) : undefined,
              split > 0 ? key.slice(split + 1) : undefined,
            ),
            efforts,
            effortsKnown,
          })
        }
        if (observed.models.length > MAX_ITEMS) failures.push({ code: 'metadata-limit' })
      }
    } catch {
      failures.push({ code: 'cached-probe-unavailable' })
    }
    checkAbort(signal)
    if (target === 'pi' || target === 'grok-build') {
      const path = nativeFile(target, deps.hostEnv ?? process.env)
      if (!path) limitations.push('configured-model-path-unavailable')
      else {
        let text: string | undefined
        try {
          text = await readBounded(path, signal)
        } catch {
          checkAbort(signal)
          failures.push({ code: 'configuration-unavailable' })
        }
        if (text !== undefined) {
          try {
            if (target === 'grok-build') {
              limitations.push('grok-model-headers-only')
              for (const alias of grokAliases(text)) candidates.push(row(alias, alias, 'configured', fetchedAt))
            } else {
              const config: unknown = JSON.parse(text)
              if (!record(config) || !record(config.providers)) throw new Error('Invalid model configuration')
              for (const [provider, info] of Object.entries(config.providers).slice(0, MAX_ITEMS)) {
                if (!cliId(provider) || !record(info) || !Array.isArray(info.models)) continue
                for (const value of info.models.slice(0, MAX_ITEMS)) {
                  const key = record(value) ? cliId(value.id) : undefined
                  const combined = key ? cliId(`${provider}/${key}`) : undefined
                  if (!combined) {
                    failures.push({ code: 'invalid-metadata' })
                    continue
                  }
                  candidates.push(row(combined, value.name, 'configured', fetchedAt, provider, key))
                  if (candidates.length > MAX_ITEMS) break
                }
                if (candidates.length > MAX_ITEMS) break
              }
            }
          } catch {
            failures.push({ code: 'configuration-invalid' })
          }
        }
      }
    }
    for (const model of descriptor.modelSuggestions) {
      const key = cliId(model)
      if (key) candidates.push(row(key, key, 'built-in', fetchedAt))
    }
    const unique = new Map<string, CatalogModel>()
    for (const model of candidates) if (!unique.has(model.id)) unique.set(model.id, model)
    if (unique.size > MAX_ITEMS) failures.push({ code: 'metadata-limit' })
    const models = [...unique.values()].slice(0, MAX_ITEMS)
    return {
      ...result,
      models,
      status: models.length ? 'partial' : failures.length ? 'error' : 'unknown',
      coverage: models.length ? 'cli-candidates' : 'unknown',
      fetchedAt: failures.length && models.length === 0 ? null : fetchedAt,
      failures,
      limitations,
      stale,
    }
  }
  return {
    async capabilities(target) {
      if (target !== undefined) assertTarget(target)
      const targets: CatalogTarget[] = target === undefined ? ['dsh', ...CLI_IDS] : [target]
      const availability = sandbox()
      return {
        generatedAt: new Date(clock()).toISOString(),
        targets: targets.map(key => {
          if (key === 'dsh')
            return {
              target: key,
              name: 'DSH',
              needsProvider: true,
              modelRequired: false,
              permissionPresets: [],
              defaultPermission: null,
              permissionSource: 'parent-session',
              efforts: [],
              effortFreeText: false,
              readOnlySupported: true,
              contexts: ['spawn', 'fork'],
              manualIdsAllowed: true,
              hostSandbox: availability,
              modelDiscovery: 'registry-metadata',
              limitations: [
                'model-listing-does-not-verify-authentication',
                'sandbox-enforcement-not-probed',
                'permissions-are-not-caller-authorization',
              ],
            }
          const descriptor = cliDescriptor(key)
          return {
            target: key,
            name: descriptor.displayName,
            needsProvider: descriptor.needsProvider,
            modelRequired: descriptor.needsProvider,
            permissionPresets: descriptor.permissions.map(preset => ({ ...preset })),
            defaultPermission: descriptor.defaultPermission,
            permissionSource: 'cli-presets',
            efforts: [...descriptor.efforts],
            effortFreeText: descriptor.effortFreeText,
            readOnlySupported: descriptor.presetForAccess['read-only'] !== undefined,
            contexts: ['spawn'],
            manualIdsAllowed: true,
            hostSandbox: availability,
            modelDiscovery: 'static-and-cached-only',
            limitations: [
              'candidate-list-not-complete',
              'model-listing-does-not-verify-authentication',
              'sandbox-enforcement-not-probed',
              'permissions-are-not-caller-authorization',
            ],
          }
        }),
      }
    },
    async models(request, signal) {
      assertTarget(request.target)
      checkAbort(signal)
      const provider = request.provider === undefined || request.provider === '' ? undefined : id(request.provider)
      if (request.provider && provider === undefined) throw new Error('Invalid catalog provider')
      const generation = generations.get(request.target) ?? 0
      const now = clock()
      const environment = deps.hostEnv ?? process.env
      let executable = ''
      if (request.target !== 'dsh') {
        try {
          executable = deps.cliSettings?.()?.[request.target]?.executable ?? ''
        } catch {}
      }
      const key = JSON.stringify([
        request.target,
        provider ?? null,
        request.target === 'dsh'
          ? null
          : [environment.HOME, environment.PI_CODING_AGENT_DIR, environment.GROK_HOME, executable],
      ])
      const previous = cache.get(key)
      let snapshot = previous?.snapshot
      if (!snapshot || request.refresh || now - previous!.checkedAt >= ttl || now < previous!.checkedAt) {
        let discovered =
          request.target === 'dsh'
            ? await registry(provider, now, snapshot, signal)
            : await cli(request.target, now, signal)
        checkAbort(signal)
        if ((generations.get(request.target) ?? 0) !== generation)
          throw Object.assign(new Error('The role reference catalog changed; request fresh metadata.'), {
            code: 'catalog-invalidated',
          })
        if (snapshot && request.target !== 'dsh' && discovered.status !== 'error') {
          const failedSources = new Set<CatalogModelSource>()
          if (
            discovered.failures.some(
              issue => issue.code === 'configuration-unavailable' || issue.code === 'configuration-invalid',
            )
          )
            failedSources.add('configured')
          if (discovered.failures.some(issue => issue.code === 'cached-probe-unavailable'))
            failedSources.add('observed-cli')
          const retained = snapshot.models.filter(model => failedSources.has(model.source))
          if (retained.length) {
            const rank: Record<CatalogModelSource, number> = {
              registry: 0,
              'observed-cli': 1,
              configured: 2,
              'built-in': 3,
            }
            const merged = new Map<string, CatalogModel>()
            for (const model of [...discovered.models, ...retained]) {
              const current = merged.get(model.id)
              if (!current || rank[model.source] < rank[current.source]) merged.set(model.id, model)
            }
            discovered = {
              ...discovered,
              status: 'partial',
              coverage: 'cli-candidates',
              stale: true,
              models: [...merged.values()].slice(0, MAX_ITEMS),
              limitations: [...discovered.limitations, 'stale-source-retained'],
            }
          }
        }
        snapshot =
          discovered.status === 'error' && snapshot && (snapshot.models.length > 0 || snapshot.providers.length > 0)
            ? {
                ...snapshot,
                status: 'error',
                stale: true,
                lastAttemptAt: discovered.lastAttemptAt,
                failures: discovered.failures,
              }
            : discovered
        cache.delete(key)
        if (cache.size >= MAX_CACHE_ENTRIES) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
        cache.set(key, { checkedAt: now, snapshot })
      }
      const query = typeof request.query === 'string' ? request.query.trim().slice(0, 128).toLowerCase() : ''
      const limit =
        typeof request.limit === 'number' && Number.isFinite(request.limit) && request.limit > 0
          ? Math.min(100, Math.max(1, Math.floor(request.limit)))
          : 25
      const offset =
        typeof request.offset === 'number' && Number.isFinite(request.offset) && request.offset >= 0
          ? Math.min(1_000_000, Math.floor(request.offset))
          : 0
      const models = snapshot.models.filter(
        model =>
          (!provider || model.provider === provider || request.target === 'dsh') &&
          (!query || `${model.id} ${model.name} ${model.provider ?? ''}`.toLowerCase().includes(query)),
      )
      const providers = snapshot.providers.filter(
        item => !query || `${item.id} ${item.name}`.toLowerCase().includes(query),
      )
      const total = snapshot.pageKind === 'providers' ? providers.length : models.length
      checkAbort(signal)
      return {
        ...snapshot,
        models: (snapshot.pageKind === 'models' ? models.slice(offset, offset + limit) : []).map(model => ({
          ...model,
          efforts: [...model.efforts],
        })),
        providers: (snapshot.pageKind === 'providers'
          ? providers.slice(offset, offset + limit)
          : snapshot.providers
        ).map(item => ({ ...item })),
        failures: snapshot.failures.slice(0, MAX_FAILURES).map(issue => ({ ...issue })),
        limitations: [
          ...snapshot.limitations,
          ...(snapshot.failures.length > MAX_FAILURES ? ['diagnostics-truncated'] : []),
        ],
        limit,
        offset,
        total,
        nextOffset: offset + limit < total ? offset + limit : null,
      }
    },
    invalidate(target) {
      if (target !== undefined) assertTarget(target)
      for (const key of target === undefined ? (['dsh', ...CLI_IDS] as const) : [target])
        generations.set(key, (generations.get(key) ?? 0) + 1)
      for (const [key, value] of cache) if (target === undefined || value.snapshot.target === target) cache.delete(key)
    },
  }
}
