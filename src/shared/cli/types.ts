/**
 * The data-only contract every external coding-agent CLI is described by.
 *
 * A descriptor holds everything the browser editor and the Host must agree on
 * (display name, default executable, permission presets and their access
 * level, effort options, model suggestions). It contains no behaviour, so it
 * can be bundled into the browser and the Host alike. The Host-side adapter
 * that actually runs the CLI lives in `src/host/cli/<id>/`.
 */

/** Identifier of one supported external CLI. */
export type CliId = 'codex' | 'claude-code' | 'agy' | 'opencode' | 'grok-build' | 'pi'

/** Every supported CLI, in the order the editor lists them. */
export const CLI_IDS: readonly CliId[] = Object.freeze([
  'codex',
  'claude-code',
  'agy',
  'opencode',
  'grok-build',
  'pi',
] as const)

/** How much a child may change. Ordered: read-only < workspace-write < full-access. */
export type AccessLevel = 'read-only' | 'workspace-write' | 'full-access'

/** Rank of each {@link AccessLevel}; a lower rank allows less. */
export const ACCESS_ORDER: Readonly<Record<AccessLevel, number>> = Object.freeze({
  'read-only': 0,
  'workspace-write': 1,
  'full-access': 2,
})

/**
 * What enforces a preset's limits:
 * - `os-sandbox`: an operating-system sandbox of the CLI (Codex), which also covers its shell commands
 *   and resolves symbolic links;
 * - `tool-scope`: the CLI's own tool permissions (which tools exist, which paths they may write). Before a
 *   workspace-write run of such a preset the engine checks the workspace and refuses when the CLI's scope
 *   could reach outside it (see `docs/external-cli.md`);
 * - `none`: no limit (full access).
 */
export type Confinement = 'os-sandbox' | 'tool-scope' | 'none'

/** One CLI-native permission preset offered in the editor. */
export interface PermissionPreset {
  /** CLI-native id, e.g. codex `workspace-write`, claude `acceptEdits`. */
  readonly id: string
  /** What the preset allows; used for the access ceiling. */
  readonly access: AccessLevel
  /** What enforces it. */
  readonly confinement: Confinement
  /** Preserves native settings/extensions; never silently substitute a restricted harness for this choice. */
  readonly nativeHarness?: boolean
}

/** Static description of one CLI. Pure data, shared by the Host and the browser. */
export interface CliDescriptor {
  readonly id: CliId
  /** Human-facing name: 'Codex', 'Claude Code', 'Antigravity', 'OpenCode'. */
  readonly displayName: string
  /** Default executable looked up on PATH when the settings name none. */
  readonly executable: string
  /** Whether a model is chosen as provider + model (OpenCode); then both are required. */
  readonly needsProvider: boolean
  /** Static fallback list for the editor's model field (free text is always allowed). */
  readonly modelSuggestions: readonly string[]
  /** Allowed effort ids; empty when the CLI has no fixed effort list. */
  readonly efforts: readonly string[]
  /** True when any non-empty effort text is accepted (model-defined variants, OpenCode). */
  readonly effortFreeText: boolean
  /** Presets in display order; ids are unique. */
  readonly permissions: readonly PermissionPreset[]
  /** Preset a role gets when it switches to this CLI. */
  readonly defaultPermission: string
  /** Preset used to lower access. Missing levels are unsupported and must be refused, never widened. */
  readonly presetForAccess: Readonly<Partial<Record<AccessLevel, string>>>
  /** Where the role's instructions reach the CLI (documentation for the preview and README). */
  readonly instructionsChannel: 'system' | 'prompt'
  /**
   * How far a `tool-scope` preset's file tools reach: `cwd` (the run's directory tree), or `git-worktree`
   * (the whole git worktree that contains the directory — OpenCode). With `git-worktree`, a workspace-write
   * run from below a worktree's top-level is refused.
   */
  readonly toolScope: 'cwd' | 'git-worktree'
  /**
   * Project directories (relative names, searched from the run's directory up to its git top-level) whose
   * code the CLI runs at start even under its restricted presets (OpenCode `.opencode/plugin`). Below full
   * access, a run is refused when one exists.
   */
  readonly startupCodeDirs?: readonly string[]
}
