/**
 * Test doubles for the Host half, built on the structural ports in src/host/ports.ts: in-memory Sessions and
 * Agents, a fake Host context that can fire `agent/created` / `agent/disposed`, and stand-ins for the two DSH
 * modules that cannot be loaded outside a full DSH checkout (`dsh-session` pulls in packages that are not installed
 * here, so tests mock it; `dsh-tools` is loaded for real, see {@link toolsModule}).
 */

import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { type Mock, vi } from 'vitest'
import type {
  AgentPort,
  ExternalProviderPort,
  HostContext,
  LlmPort,
  LoggerPort,
  SandboxPolicyPort,
  SandboxPort,
  SessionPort,
  StorageDomainPort,
  SubagentProviderPort,
  SubagentRunPort,
  SubagentsPort,
  SubprocessPort,
  SystemPromptPort,
  ToolGuardCall,
} from '../src/host/ports.ts'
import { DEFAULT_ROLES, type RoleDefinition, type RoleSettings } from '../src/shared/roles.ts'

// ---------------------------------------------------------------------------------------------------------------
// Roles

/** A custom role with sensible defaults; `patch` overrides any field. */
export function role(id: string, patch: Partial<RoleDefinition> = {}): RoleDefinition {
  return {
    id,
    enabled: true,
    description: `${id} description`,
    instructions: '',
    context: 'spawn',
    readOnly: false,
    ...patch,
  }
}

/** One of the two built-in roles as the defaults ship it; `patch` overrides any field. */
export function builtinRole(which: 'general' | 'fork', patch: Partial<RoleDefinition> = {}): RoleDefinition {
  const found = DEFAULT_ROLES.find(entry => entry.builtin === which)
  if (found === undefined) throw new Error(`no default for built-in role ${which}`)
  return { ...found, ...patch }
}

/** Role settings around a role list. */
export function settingsOf(roles: RoleDefinition[], enabled = true): RoleSettings {
  return { enabled, roles }
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions and plugin records

/** One committed event in a {@link FakeSession} log; plugin records carry `ignorable: true`. */
export interface FakeEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: unknown
  readonly ignorable?: true
}

/** An in-memory Session: an append-only log plus the header the Host reads. */
export interface FakeSession extends SessionPort {
  readonly log: FakeEvent[]
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** Copy through JSON like the real log does, so later edits to the caller's object cannot reach the record. */
function snapshot<T>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T)
}

export function fakeSession(id: string, header: SessionPort['header'] = {}): FakeSession {
  const log: FakeEvent[] = []
  return {
    id,
    header,
    log,
    snapshotEvents: () => [...log],
    append(type, data) {
      const event: FakeEvent = { type, seq: log.length, time: Date.now(), data: snapshot(data) }
      log.push(event)
      return event
    },
  }
}

/** Event types in log order. */
export function typesOf(session: FakeSession): string[] {
  return session.log.map(event => event.type)
}

/** The payloads of every event of one type, in log order. */
export function recordsOf(session: FakeSession, type: string): unknown[] {
  return session.log.filter(event => event.type === type).map(event => event.data)
}

const RECORD_TYPE = /^plugin:[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/

/**
 * Append a legacy Session-log plugin record (grammar-checked, JSON-snapshotted, `ignorable: true`), as the
 * pre-storage version of this plugin wrote them. Used to seed logs that the current legacy fallback reads.
 */
export function appendRecord(session: FakeSession, type: string, data: unknown): void {
  if (!RECORD_TYPE.test(type)) throw new Error(`plugin record type "${type}" is outside the plugin record grammar`)
  const event: FakeEvent = {
    type,
    seq: session.log.length,
    time: Date.now(),
    data: snapshot(data),
    ignorable: true,
  }
  session.log.push(event)
}

// ---------------------------------------------------------------------------------------------------------------
// Storage domain

/** In-memory `storageDomain` facility: opened domains are table maps the test can inspect directly. */
export interface FakeStorage {
  readonly facility: StorageDomainPort
  /** Domain name → table name → key → stored record. */
  readonly data: Map<string, Map<string, Map<string, unknown>>>
}

export function fakeStorage(): FakeStorage {
  const data = new Map<string, Map<string, Map<string, unknown>>>()
  const facility: StorageDomainPort = {
    async open(spec: unknown) {
      const name = (spec as { name: string }).name
      let domain = data.get(name)
      if (domain === undefined) {
        domain = new Map()
        data.set(name, domain)
      }
      const tables = domain
      return {
        table(table: string) {
          let rows = tables.get(table)
          if (rows === undefined) {
            rows = new Map()
            tables.set(table, rows)
          }
          const map = rows
          return {
            get: (key: string) => map.get(key),
            put: async (key: string, value: unknown) => {
              map.set(key, snapshot(value))
            },
            entries: () => [...map.entries()] as [string, unknown][],
          }
        },
        close: async () => {},
      }
    },
  }
  return { facility, data }
}

/** The stored snapshot record for one Session, or undefined. */
export function storedSnapshot(storage: FakeStorage, sessionId: string): unknown {
  return storage.data.get('rolesubagents')?.get('snapshots')?.get(sessionId)
}

/** The stored child-role record for one Session, or undefined. */
export function storedRole(storage: FakeStorage, sessionId: string): unknown {
  return storage.data.get('rolesubagents')?.get('roles')?.get(sessionId)
}

/**
 * `@deepseek-ai/dsh-storage-domain` reduced to its declaration helpers: `defineDomain` and `domainTable` are
 * identity wrappers here (the facility itself is faked per world, see {@link fakeStorage}); the real package
 * also pulls in `@deepseek-ai/dsh-storage`, which tests do not install. Use as
 * `vi.mock('@deepseek-ai/dsh-storage-domain', () => import('./host-fakes.ts').then(m => m.storageDomainModule()))`.
 */
export function storageDomainModule() {
  return {
    defineDomain: (spec: unknown) => spec,
    domainTable: (valueSchema: unknown) => ({ valueSchema }),
  }
}

/**
 * `@deepseek-ai/dsh-tools` reduced to `defineTool`, loaded straight from the installed package's schema module so
 * the real parameter-schema compilation and argument validation run. The package entry point also loads services
 * (scope, sandbox) that tests have no use for and that are not installed here. Use as
 * `vi.mock('@deepseek-ai/dsh-tools', () => import('./host-fakes.ts').then(m => m.toolsModule()))`.
 */
export async function toolsModule() {
  const { defineTool } = await import('../node_modules/@deepseek-ai/dsh-tools/lib/types/schema.js')
  return { defineTool }
}

// ---------------------------------------------------------------------------------------------------------------
// Agents

/** An Agent whose scoped tool registry records what is registered and hands out spy disposers. */
export interface FakeAgent extends AgentPort {
  readonly session: FakeSession
  readonly registered: ToolDefinition[]
  readonly disposers: Mock<() => void>[]
  readonly register: Mock<(definition: ToolDefinition) => () => void>
  /** Guards registered in this Agent's scope, in registration order. */
  readonly guards: ((call: ToolGuardCall) => string | undefined)[]
  readonly guardDisposers: Mock<() => void>[]
}

export function fakeAgent(id: string, session: FakeSession = fakeSession(`session-${id}`)): FakeAgent {
  const registered: ToolDefinition[] = []
  const disposers: Mock<() => void>[] = []
  const guards: ((call: ToolGuardCall) => string | undefined)[] = []
  const guardDisposers: Mock<() => void>[] = []
  const register = vi.fn((definition: ToolDefinition) => {
    registered.push(definition)
    const dispose = vi.fn<() => void>()
    disposers.push(dispose)
    return dispose
  })
  const guard = vi.fn((check: (call: ToolGuardCall) => string | undefined) => {
    guards.push(check)
    const dispose = vi.fn<() => void>(() => {
      const index = guards.indexOf(check)
      if (index >= 0) guards.splice(index, 1)
    })
    guardDisposers.push(dispose)
    return dispose
  })
  return { id, session, registered, disposers, register, guards, guardDisposers, ctx: { tools: { register, guard } } }
}

/** The tool an Agent had registered; fails the test when it has none. */
export function registeredTool(agent: FakeAgent): ToolDefinition {
  const [tool] = agent.registered
  if (tool === undefined) throw new Error(`agent ${agent.id} has no registered tool`)
  return tool
}

/** What the tool registry hands a running tool: the calling Agent and the cancellation signal. */
export function execContext(
  agent: AgentPort | undefined,
  signal: AbortSignal = new AbortController().signal,
): ToolRunContext {
  return { agent, signal } as unknown as ToolRunContext
}

// ---------------------------------------------------------------------------------------------------------------
// Host context

export function fakeProvider(name: string, patch: Partial<SubagentProviderPort> = {}): SubagentProviderPort {
  return {
    name,
    inheritsParentContext: false,
    ...patch,
    capabilities: { agentOptions: true, agentPreset: true, ...patch.capabilities },
  }
}

type RuntimeContext = Parameters<SystemPromptPort['context']>[0]
type CreatedPayload = { agent: AgentPort; source: string }
type DisposedPayload = { agent: AgentPort }
type SessionListener = (session: SessionPort, event: { readonly type: string; readonly data?: unknown }) => void
type SessionsService = { get(id: string): SessionPort | undefined }

export interface FakeWorld {
  readonly ctx: HostContext
  readonly logger: { info: Mock<LoggerPort['info']>; warn: Mock<LoggerPort['warn']> }
  /** Registered subagent providers by name; `spawn` (full capabilities) and `fork` (inherits context) exist. */
  readonly providers: Map<string, SubagentProviderPort>
  readonly subagents: {
    getProvider: Mock<SubagentsPort['getProvider']>
    resolveMaxDepth: Mock<SubagentsPort['resolveMaxDepth']>
    startActivation: Mock<SubagentsPort['startActivation']>
    registerProvider: Mock<NonNullable<SubagentsPort['registerProvider']>>
  }
  /** External providers currently registered through `registerProvider`, by name. */
  readonly externalProviders: Map<string, ExternalProviderPort>
  /** Optional Host services; delete a key to emulate the service being absent. */
  readonly services: {
    llm?: { resolveCallConfig: Mock<LlmPort['resolveCallConfig']> }
    sessions?: SessionsService
    storageDomain?: StorageDomainPort
    subprocess?: SubprocessPort
    sandboxPolicy?: SandboxPolicyPort
    sandbox?: SandboxPort
    settings?: unknown
  }
  /** The fake storage-domain backend every state instance in this world shares. */
  readonly storage: FakeStorage
  /** The stored snapshot record for a Session (as the storage domain holds it), or undefined. */
  storedSnapshot(sessionId: string): unknown
  /** The stored child-role record for a Session (as the storage domain holds it), or undefined. */
  storedRole(sessionId: string): unknown
  /** Flush microtasks so a state write has reached the fake storage domain. */
  settle(): Promise<void>
  /** Sessions the `sessions` service can find, by id. */
  readonly sessions: Map<string, FakeSession>
  /** What `ctx.agents.list()` returns when the plugin is applied. */
  agents: AgentPort[]
  /** Children the default `startActivation` created, in order. */
  readonly children: FakeAgent[]
  /** Runs external providers returned from `start`, in order (the fake does not dispose them). */
  readonly externalRuns: SubagentRunPort[]
  /** Runtime-context providers registered through `ctx.systemPrompt.context`. */
  readonly contexts: RuntimeContext[]
  /** A new Agent with its own Session, registered with the `sessions` service. Nothing is emitted. */
  newAgent(id: string, header?: SessionPort['header']): FakeAgent
  emitCreated(agent: AgentPort, source?: string): void
  emitDisposed(agent: AgentPort): void
  emitToolsChange(): void
  emitVolatileUpdate(): void
  emitModelCatalogUpdate(): void
  /** Append a sandbox mode and publish it on `session/event`, as a live Session does. */
  emitSandbox(session: FakeSession, mode: string): void
  /** The text the plugin's runtime-context provider contributes for an Agent (or for none). */
  runtimeContext(agent?: AgentPort): string
  /** Run the plugin's `ctx.effect` cleanups, as the Host does when the plugin is unloaded. */
  teardown(): Promise<void>
}

/**
 * A fake Host context. By default `startActivation` behaves like the real service: it creates a child Agent
 * (depth one deeper than the parent) and fires `agent/created` with source `startup` before it resolves.
 */
export function fakeWorld(sharedStorage?: FakeStorage): FakeWorld {
  const created: ((payload: CreatedPayload) => void)[] = []
  const disposed: ((payload: DisposedPayload) => void)[] = []
  const sessionEvents: SessionListener[] = []
  const toolsChanged: (() => void)[] = []
  const volatileChanged: (() => void)[] = []
  const catalogChanged: (() => void)[] = []
  const cleanups: (() => void | Promise<void>)[] = []
  const providers = new Map<string, SubagentProviderPort>([
    ['spawn', fakeProvider('spawn')],
    [
      'fork',
      fakeProvider('fork', { inheritsParentContext: true, capabilities: { agentOptions: false, agentPreset: false } }),
    ],
  ])
  const sessions = new Map<string, FakeSession>()
  const externalProviders = new Map<string, ExternalProviderPort>()
  const logger = { info: vi.fn<LoggerPort['info']>(), warn: vi.fn<LoggerPort['warn']>() }
  const storage = sharedStorage ?? fakeStorage()
  const services: FakeWorld['services'] = {
    llm: { resolveCallConfig: vi.fn<LlmPort['resolveCallConfig']>(async () => ({})) },
    sessions: { get: id => sessions.get(id) },
    storageDomain: storage.facility,
  }
  const contexts: RuntimeContext[] = []

  const world: Omit<FakeWorld, 'ctx'> = {
    logger,
    providers,
    services,
    storage,
    storedSnapshot: (sessionId: string) => storedSnapshot(storage, sessionId),
    storedRole: (sessionId: string) => storedRole(storage, sessionId),
    settle: async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    },
    sessions,
    agents: [],
    children: [],
    externalRuns: [],
    contexts,
    externalProviders,
    subagents: {
      getProvider: vi.fn<SubagentsPort['getProvider']>(name => providers.get(name) ?? externalProviders.get(name)),
      registerProvider: vi.fn<NonNullable<SubagentsPort['registerProvider']>>(provider => {
        if (providers.has(provider.name) || externalProviders.has(provider.name)) {
          throw new Error(`duplicate provider ${provider.name}`)
        }
        externalProviders.set(provider.name, provider)
        return () => {
          externalProviders.delete(provider.name)
        }
      }),
      resolveMaxDepth: vi.fn<SubagentsPort['resolveMaxDepth']>(() => undefined),
      startActivation: vi.fn<SubagentsPort['startActivation']>(async spec => {
        const external = externalProviders.get(spec.provider)
        if (external !== undefined) {
          // Like DSH's startExternal: the provider starts the run; the run id is the child id.
          const run = await external.start({
            cwd: spec.request.cwd ?? process.cwd(),
            label: spec.label,
            prompt: spec.request.prompt,
            parent: spec.request.parent,
            signal: spec.signal,
          })
          world.externalRuns.push(run)
          return { childId: run.id }
        }
        const parent = spec.request.parent
        const childId = spec.childId ?? `child-${world.children.length + 1}`
        const child = world.newAgent(childId, {
          origin: 'subagent',
          parentSession: parent.session.id,
          delegationDepth: (parent.session.header.delegationDepth ?? 0) + 1,
        })
        world.children.push(child)
        world.emitCreated(child, 'startup')
        return { childId }
      }),
    },
    newAgent(id, header = {}) {
      const agent = fakeAgent(id, fakeSession(`session-${id}`, header))
      sessions.set(agent.session.id, agent.session)
      return agent
    },
    emitCreated(agent, source = 'startup') {
      for (const listener of created) listener({ agent, source })
    },
    emitDisposed(agent) {
      for (const listener of disposed) listener({ agent })
    },
    emitToolsChange() {
      for (const listener of [...toolsChanged]) listener()
    },
    emitVolatileUpdate() {
      for (const listener of [...volatileChanged]) listener()
    },
    emitModelCatalogUpdate() {
      for (const listener of [...catalogChanged]) listener()
    },
    emitSandbox(session, mode) {
      session.append('sandbox/mode', { mode })
      const event = { type: 'sandbox/mode', data: { mode } }
      for (const listener of sessionEvents) listener(session, event)
    },
    runtimeContext(agent) {
      const context = contexts.find(entry => entry.name === 'rolesubagents:role')
      if (context === undefined) throw new Error('the plugin registered no runtime context')
      return context.text(agent === undefined ? {} : { agent })
    },
    async teardown() {
      await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
    },
  }

  function get(name: 'llm'): LlmPort | undefined
  function get(name: 'sessions'): SessionsService | undefined
  function get(name: 'storageDomain'): StorageDomainPort | undefined
  function get(name: 'subprocess'): SubprocessPort | undefined
  function get(name: 'sandboxPolicy'): SandboxPolicyPort | undefined
  function get(name: 'sandbox'): SandboxPort | undefined
  function get(name: string): unknown
  function get(name: string): unknown {
    if (name === 'llm') return services.llm
    if (name === 'sessions') return services.sessions
    if (name === 'storageDomain') return services.storageDomain
    if (name === 'subprocess') return services.subprocess
    if (name === 'sandboxPolicy') return services.sandboxPolicy
    if (name === 'sandbox') return services.sandbox
    if (name === 'settings') return services.settings
    return undefined
  }

  function on(event: 'agent/created', listener: (payload: CreatedPayload) => void): unknown
  function on(event: 'agent/disposed', listener: (payload: DisposedPayload) => void): unknown
  function on(event: 'session/event', listener: SessionListener): unknown
  function on(event: 'tools/change', listener: () => void): unknown
  function on(event: string, listener: (...args: never[]) => void): unknown {
    if (event === 'agent/created') created.push(listener as (payload: CreatedPayload) => void)
    else if (event === 'agent/disposed') disposed.push(listener as (payload: DisposedPayload) => void)
    else if (event === 'tools/change') {
      const fn = listener as () => void
      toolsChanged.push(fn)
      return () => {
        const index = toolsChanged.indexOf(fn)
        if (index >= 0) toolsChanged.splice(index, 1)
      }
    } else if (event === 'loader/volatile-update' || event === 'llm/adapters-updated') {
      const list = event === 'loader/volatile-update' ? volatileChanged : catalogChanged
      const fn = listener as () => void
      list.push(fn)
      return () => {
        const i = list.indexOf(fn)
        if (i >= 0) list.splice(i, 1)
      }
    } else if (event === 'session/event') {
      const fn = listener as SessionListener
      sessionEvents.push(fn)
      return () => {
        const index = sessionEvents.indexOf(fn)
        if (index >= 0) sessionEvents.splice(index, 1)
      }
    } else throw new Error(`unexpected event ${event}`)
    return () => {}
  }

  const ctx: HostContext = {
    subagents: world.subagents,
    systemPrompt: {
      context(context) {
        contexts.push(context)
        return () => {}
      },
    },
    agents: { list: () => world.agents },
    logger,
    get,
    on,
    effect(execute) {
      cleanups.push(execute())
      return () => {}
    },
  }
  // Same object, so tests that replace `agents` on the returned world are seen by `ctx.agents.list()`.
  return Object.assign(world, { ctx })
}
