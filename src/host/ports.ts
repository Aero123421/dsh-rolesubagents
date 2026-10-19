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

/** One content block of a prompt or a result; only text is produced here. */
export interface ContentBlockPort {
  readonly type: string
  readonly text?: string
}

/** Why a subagent run ended (DSH's known stop reasons). */
export type SubagentStopReasonPort = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'refusal'

/** The terminal outcome of one subagent run. */
export interface SubagentResultPort {
  readonly output: readonly ContentBlockPort[]
  /** Safe, fixed-vocabulary failure detail (≤ 4096 UTF-8 bytes); never raw CLI output. */
  readonly diagnostic?: string
  readonly stopReason: SubagentStopReasonPort
}

/** A started out-of-process run, owned by DSH's activation registry once returned. */
export interface SubagentRunPort {
  /** Provider-minted unique id. */
  readonly id: string
  /** Settles with the terminal result; never rejects. */
  readonly result: Promise<SubagentResultPort>
  /** Cancel, reach quiescence and release resources. Idempotent. */
  dispose(): Promise<void>
}

/** What DSH hands an external provider's `start` (`ResolvedSubagentStartRequest` subset). */
export interface SubagentStartRequestPort {
  /** Absolute child directory selected by DSH (not validated by DSH). */
  readonly cwd: string
  readonly label?: string
  readonly prompt: readonly ContentBlockPort[]
  readonly parent: AgentPort
  /** Manager-owned: aborts on `interrupt_agent` and disposal. */
  readonly signal: AbortSignal
}

/** A provider this plugin registers for one external delegation. */
export interface ExternalProviderPort extends SubagentProviderPort {
  readonly capabilities: {
    readonly agentOptions: false
    readonly agentPreset: false
    readonly outputSchema: false
    readonly depthLimit: false
  }
  readonly inheritsParentContext: false
  start(request: SubagentStartRequestPort): Promise<SubagentRunPort>
}

/** `ctx.subagents` — the official delegation service. */
export interface SubagentsPort {
  getProvider(name: string): SubagentProviderPort | undefined
  /** Register a provider in the caller's scope; returns its removal. Needed for external roles only. */
  registerProvider?(provider: ExternalProviderPort): () => void
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

/** `ctx.sandboxPolicy` — optional; resolves a Session's effective file-sandbox policy. */
export interface SandboxPolicyPort {
  resolve(request?: { session?: SessionPort }): { readonly mode?: string; readonly workspaceRoot?: string }
}

/** Exit facts of one closed process. */
export interface SubprocessOutcomePort {
  exitCode: number | null
  signal: string | null
}

/** Offset-based reader of one collected output stream. */
export interface SubprocessOutputReaderPort {
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean }
}

/** One stdout/stderr disposition (DSH's `SubprocessOutputMode`). */
export type SubprocessOutputModePort = 'pipe' | 'inherit' | { maxBytes: number }

/** A fully specified spawn request (DSH's `SubprocessSpawnSpec`). */
export interface SubprocessSpawnSpecPort {
  argv: readonly string[]
  cwd: string
  stdio: {
    stdin: 'ignore' | 'pipe' | { readonly data: string }
    stdout: SubprocessOutputModePort
    stderr: SubprocessOutputModePort
  }
  graceMs: number
  signal?: AbortSignal
  /** Merged over DSH's scrubbed parent environment; `undefined` removes an entry. */
  env?: Record<string, string | undefined>
}

/** A live process and its managed process range (DSH's `SubprocessHandle`). */
export interface SubprocessHandlePort {
  readonly stdin?: NodeJS.WritableStream & { destroyed?: boolean; writableEnded?: boolean }
  readonly stdout?: NodeJS.ReadableStream
  readonly stderr?: NodeJS.ReadableStream
  readonly collected: { readonly stdout?: SubprocessOutputReaderPort; readonly stderr?: SubprocessOutputReaderPort }
  /** Resolves with exit facts; rejects for spawn failures (e.g. ENOENT). */
  readonly done: Promise<SubprocessOutcomePort>
  /** Start TERM → grace → KILL on the managed range. */
  terminate(): void
  /** Resolves true once the managed range is quiet. */
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

/**
 * `ctx.subprocess` — optional; DSH's process seam (`@deepseek-ai/dsh-subprocess`).
 * The local implementation spawns POSIX children with `detached: true`
 * (directly, or `systemd-run` when a user scope is available), i.e. in a new
 * session via setsid: the child has NO controlling terminal, so a CLI that
 * opens `/dev/tty` for an interactive login fails instead of prompting.
 * Verified in `@deepseek-ai/dsh-subprocess-local` 0.2.1 (`spawnSubprocess`, `launchLinuxScope`).
 */
export interface SubprocessPort {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>
  spawn(spec: SubprocessSpawnSpecPort): SubprocessHandlePort
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
  get(name: 'subprocess'): SubprocessPort | undefined
  get(name: 'sandboxPolicy'): SandboxPolicyPort | undefined
  get(name: string): unknown
  on(event: 'agent/created', listener: (payload: { agent: AgentPort; source: string }) => void): unknown
  on(event: 'agent/disposed', listener: (payload: { agent: AgentPort }) => void): unknown
  on(event: 'tools/change', listener: () => void): unknown
  on(
    event: 'session/event',
    listener: (session: SessionPort, event: { readonly type: string; readonly data?: unknown }) => void,
  ): unknown
  effect(execute: () => () => void, label?: string): unknown
  /** Cordis child-plugin loading; used only to mount the optional probe service. */
  plugin?(plugin: unknown, config?: unknown): unknown
}
