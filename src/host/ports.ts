/**
 * Structural views of the DSH Host services this plugin uses. Only the members
 * called here are described, so the real Cordis context is assignable and
 * tests can pass small fakes. Verified against DSH 0.2.1-alpha.3.
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

/** A tool lookup. `scope` is the agent whose view is wanted; omitted means the host view. */
export interface ToolLookup {
  get(name: string, scope?: AgentPort): ToolDefinition | undefined
}

/** One live Agent as `agent/created` and tool execution supply it. */
export interface AgentPort {
  readonly id: string
  readonly session: SessionPort
  /** Abort the active turn. Present on a real Agent; optional so fakes can omit it. */
  cancel?(cause: { readonly kind: 'user' }): void
  /** Stop the agent loop. Present on a real Agent handle; optional so fakes can omit it. */
  dispose?(): Promise<void> | void
  /** The Agent's own scoped context: registrations here are visible to this Agent only. */
  readonly ctx: {
    readonly tools: ToolLookup & {
      register(definition: ToolDefinition): () => void
      guard(guard: (call: ToolGuardCall) => string | undefined): () => void
    }
  }
}

/** Seed a provider may copy into a new child. Only the event `type` is inspected. */
export interface ContinuableSeed {
  readonly seed?: readonly unknown[]
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
  /**
   * When present, a task-only start inspects the seed. A declaration that the
   * provider copies nothing is not enough on its own.
   */
  prepareContinuable?(request: {
    parent: AgentPort
    sessionId: string
    signal?: AbortSignal
  }): Promise<ContinuableSeed | undefined>
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
  }): Promise<{ childId: string; dispose?: () => Promise<void> | void }>
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

/**
 * `ctx.sessions`. `list` is the live set, including a resumed session whose
 * agent is not in `ctx.agents.list()`.
 */
export interface SessionsPort {
  get(id: string): SessionPort | undefined
  list?(): readonly SessionPort[]
}

/** The plugin's Host context. */
export interface HostContext {
  readonly subagents: SubagentsPort
  readonly systemPrompt: SystemPromptPort
  /** Host tool registry, when the plugin was injected with `tools`. Used to tell an inherited tool from a shadow. */
  readonly tools?: ToolLookup
  readonly agents: { list(): readonly AgentPort[] }
  readonly logger: LoggerPort
  get(name: 'llm'): LlmPort | undefined
  get(name: 'sessions'): SessionsPort | undefined
  get(name: string): unknown
  on(event: 'agent/created', listener: (payload: { agent: AgentPort; source: string }) => void): unknown
  on(event: 'agent/disposed', listener: (payload: { agent: AgentPort }) => void): unknown
  on(
    event: 'session/event',
    listener: (session: SessionPort, event: { readonly type: string; readonly data?: unknown }) => void,
  ): unknown
  effect(execute: () => () => void, label?: string): unknown
}
