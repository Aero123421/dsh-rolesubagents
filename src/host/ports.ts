/**
 * Handwritten structural views of the DSH Host services this plugin uses.
 * Only the members called here are described so tests can pass small fakes.
 * Runtime contracts are checked against DSH 0.2.1-rc.2 by the native host
 * probes; these ports do not claim full native Context type assignability.
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Minimal Session surface: header, log reads, and appends. */
export interface SessionPort {
  readonly id: string
  readonly header: {
    readonly origin?: string
    readonly parentSession?: string
    readonly delegationDepth?: number
  }
  /** Committed events in log order (deprecated upstream but the only full read). */
  snapshotEvents(): readonly unknown[]
  append(type: 'sandbox/mode', data: { mode: string }): unknown
}

/** The fields a read-only guard reads off one tool call. */
export interface ToolGuardCall {
  readonly name: string
  readonly arguments: unknown
}

/** One live Agent as `agent/created` and tool execution supply it. */
export interface AgentPort {
  readonly id: string
  readonly session: SessionPort
  /** The Agent's own scoped context: registrations here are visible to this Agent only. */
  readonly ctx: {
    readonly tools: {
      /** Resolve only tools already visible to this Agent; never add workflow to a preset without it. */
      get?(name: string, scope?: AgentPort): ToolDefinition | undefined
      register(definition: ToolDefinition): () => void
      guard(guard: (call: ToolGuardCall) => string | undefined): () => void
    }
  }
}

/** The subset of a registered subagent provider read before starting a child. */
export interface SubagentProviderPort {
  readonly name: string
  readonly inheritsParentContext?: boolean
  readonly capabilities: {
    readonly agentOptions?: boolean
    readonly agentPreset?: boolean
    readonly depthLimit?: boolean
  }
}

/** Child LLM options passed through `request.agentOptions`. */
export interface ChildAgentOptions {
  provider: string
  model: string
  reasoningEffort?: string
}

/** `ctx.subagents` — the official delegation service. */
export interface SubagentsPort {
  getProvider(name: string): SubagentProviderPort | undefined
  resolveMaxDepth(configured?: number | 'provider-managed'): number | undefined
  startActivation(spec: {
    provider: string
    label: string
    childId?: string
    request: {
      prompt: { type: 'text'; text: string }[]
      parent: AgentPort
      cwd?: string
      agentPreset?: string
      agentOptions?: ChildAgentOptions
      maxDepth?: number
    }
    signal: AbortSignal
    delivery: 'parent' | 'caller'
  }): Promise<{ childId: string }>
}

/** `ctx.systemPrompt` — only runtime-context registration is used. */
export interface SystemPromptPort {
  context(context: {
    name: string
    order: number
    text: (context: { agent?: AgentPort }) => string
    interpolate?: boolean
    required?: boolean
  }): () => void
}

/** `ctx.llm` — optional; used to validate a role's model before creating the child. */
export interface LlmPort {
  resolveCallConfig(
    config: { provider: string; model: string; reasoningEffort?: string },
    signal?: AbortSignal,
  ): Promise<unknown>
}

export interface LoggerPort {
  info(message: string): void
  warn(message: string): void
}

/** One KV table of an opened storage domain: synchronous reads; a write settles when it is durable. */
export interface DomainTablePort {
  get(key: string): unknown
  put(key: string, value: unknown): Promise<void>
  entries(): Iterable<readonly [string, unknown]>
}

/** An opened storage domain. */
export interface DomainPort {
  table(name: string): DomainTablePort
  close(): Promise<void>
}

/** `ctx.storageDomain` — the schema-validated KV domain facility (`@deepseek-ai/dsh-storage-domain`). */
export interface StorageDomainPort {
  open(spec: unknown): Promise<DomainPort>
}

/** The plugin's Host context. */
export interface HostContext {
  readonly subagents: SubagentsPort
  readonly systemPrompt: SystemPromptPort
  readonly agents: { list(): readonly AgentPort[] }
  readonly logger: LoggerPort
  get(name: 'llm'): LlmPort | undefined
  get(name: 'sessions'): { get(id: string): SessionPort | undefined } | undefined
  get(name: 'storageDomain'): StorageDomainPort | undefined
  get(name: string): unknown
  on(event: 'agent/created', listener: (payload: { agent: AgentPort; source: string }) => void | Promise<void>): unknown
  on(event: 'agent/disposed', listener: (payload: { agent: AgentPort }) => void): unknown
  on(event: 'tools/change', listener: () => void): unknown
  on(
    event: 'session/event',
    listener: (session: SessionPort, event: { readonly type: string; readonly data?: unknown }) => void,
  ): unknown
  effect(execute: () => () => void | Promise<void>, label?: string): unknown
}
