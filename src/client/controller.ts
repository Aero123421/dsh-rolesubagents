/**
 * The page's controller: one observable state over the Host settings form, the
 * draft being edited, the save in flight, and the model and preset lists the
 * editor offers. Components read {@link Controller.getSnapshot} and call the
 * actions; nothing here touches React or the DOM.
 *
 * The draft always exists while the form is `ready`. It follows the Host while
 * it holds no edits; once it holds edits, a Host revision that moved underneath
 * it is a conflict, and the only ways out are to discard or reload.
 *
 * It also runs the External CLIs connection test (`rolesubagentsCli/probe`)
 * when the page was given a way to call it. Diagnostic capability, transport,
 * authentication and CLI-result failures remain separate, retryable per-CLI states.
 */

import { CLI_IDS, type CliId, cliDescriptor, isCliId } from '../shared/cli/index.ts'
import {
  type CliSettings,
  type ForkScope,
  normalizeSettings,
  type RoleContext,
  type RoleModel,
  type RoleSettings,
  type SettingsProblem,
} from '../shared/roles.ts'
import {
  addBlankRole,
  addTemplateRole,
  analyseDraft,
  canAddRole,
  createDraft,
  type Draft,
  draftSettings,
  duplicateRow,
  type Issue,
  isDirty,
  moveRow,
  patchRole,
  patchRunner,
  type RolePatch,
  type RunnerPatch,
  removeRow,
  sameSettings,
  setAgentPreset,
  setCliSettings,
  setContext,
  setEnabled,
  setForkScope,
  setModel,
  setRunner,
  setWorkflowModel,
} from './draft.ts'
import type {
  CatalogEffort,
  ConfigFormLike,
  DshRemote,
  FormSnapshot,
  ModelCatalogLike,
  ProbeModelLike,
  ProbeResultLike,
  RemoteResult,
} from './dsh.ts'

/** One model a provider offers, with the reasoning efforts it advertises. */
export interface ModelOption {
  readonly id: string
  readonly name: string
  readonly efforts: readonly CatalogEffort[]
}

/** One provider and its models. */
export interface ProviderOption {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelOption[]
}

/** The model catalog as the editor uses it. `groups` keeps the last good list while a reload runs. */
export interface CatalogState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly groups: readonly ProviderOption[]
  /** Some providers failed to list their models. */
  readonly partial: boolean
}

/** One selectable agent preset. */
export interface PresetOption {
  readonly id: string
  readonly name: string
}

/** The agent presets as the editor uses them. An empty `ready` list means the Host composes none. */
export interface PresetState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly options: readonly PresetOption[]
}

export type SavePhase = 'idle' | 'saving' | 'saved' | 'failed'

/** Calls the Host's `rolesubagentsCli/probe`. Throws {@link ProbeUnavailableError} when there is no way to call it. */
export type ProbeCall = (cli: CliId, signal: AbortSignal) => Promise<RemoteResult<unknown>>

/** Thrown by a {@link ProbeCall} when the page cannot reach the probe at all (no `connection` service). */
export class ProbeUnavailableError extends Error {
  constructor(message = 'the CLI connection test is not available') {
    super(message)
    this.name = 'ProbeUnavailableError'
  }
}

/** Fixed UI diagnostics; never render transport/Host exception text (it may contain secrets). */
export type ProbeIssue =
  | 'connection-unavailable'
  | 'remote-unavailable'
  | 'endpoint-unavailable'
  | 'host-auth'
  | 'transport'
  | 'malformed'
  | 'remote-error'

/** One CLI's connection test. Errors are retryable and never disable other CLI cards. */
export interface ProbeState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly result?: ProbeResultLike
  readonly issue?: ProbeIssue
}

/** Connection tests of every CLI. `available` means a caller was supplied, not that the Host is compatible. */
export interface ProbesState {
  readonly available: boolean
  readonly clis: Readonly<Record<CliId, ProbeState>>
}

/** Everything the page renders from. A new object is published on every change. */
export interface PageState {
  readonly locale: string
  readonly status: 'loading' | 'ready' | 'unavailable'
  /** Whether the Host document accepts writes. */
  readonly writable: boolean
  /** The draft; defined exactly while `status` is `ready`. */
  readonly draft: Draft | undefined
  readonly dirty: boolean
  /** Why the draft cannot be saved as typed; empty when it can. */
  readonly issues: readonly Issue[]
  /** Problems found in the stored settings, which the draft shows repaired. */
  readonly repaired: readonly SettingsProblem[]
  /** The Host revision moved while the draft held edits. */
  readonly conflict: boolean
  readonly save: SavePhase
  /** The row whose editor is open. */
  readonly expanded: number | undefined
  readonly canEdit: boolean
  readonly canSave: boolean
  readonly canAdd: boolean
  readonly catalog: CatalogState
  readonly presets: PresetState
  readonly probes: ProbesState
}

export interface ControllerOptions {
  form: ConfigFormLike
  /** Source of the model catalog and the preset list; both are optional. */
  remote: DshRemote | undefined
  locale: string
  /** The CLI connection test; omitted when the page has no way to call it (the button is then hidden). */
  probe?: ProbeCall
}

export interface Controller {
  subscribe(listener: () => void): () => void
  getSnapshot(): PageState
  setEnabled(enabled: boolean): void
  setWorkflowModel(model: RoleSettings['workflowModel']): void
  /** Load only the workflow model catalog; explicit calls retry failures. */
  loadWorkflowCatalog(): void
  patchRole(uid: number, patch: RolePatch): void
  setContext(uid: number, context: RoleContext): void
  setForkScope(uid: number, scope: ForkScope): void
  setModel(uid: number, model: RoleModel | undefined): void
  setAgentPreset(uid: number, preset: string | undefined): void
  /** Choose where a role runs: a CLI, or undefined for DSH. */
  setRunner(uid: number, cli: CliId | undefined): void
  patchRunner(uid: number, patch: RunnerPatch): void
  /** Edit the External CLIs settings of one CLI. */
  setCliSettings(cli: CliId, patch: CliSettings): void
  /** Run the connection test of one CLI against the Host's saved settings. */
  probeCli(cli: CliId): void
  moveRole(uid: number, delta: -1 | 1): void
  duplicateRole(uid: number): void
  removeRole(uid: number): void
  addRole(): void
  addTemplate(templateId: string): void
  /** Open or close one row's editor. */
  toggleEditor(uid: number): void
  /** Write the whole draft in one revision-fenced mutation. */
  save(): Promise<void>
  /** Drop the edits and any conflict, and show the Host's current settings. */
  discard(): void
  /** Load the model catalog and the preset list when they are not loaded; retries after a failure. */
  loadReference(): void
  /** Forget both lists (the Host's models changed or the connection reset); reload when the editor needs them. */
  invalidateReference(): void
  /** Forget the connection tests and whether the Host offers them (a new connection may reach another Host). */
  resetProbes(): void
  setLocale(locale: string): void
  dispose(): void
}

const IDLE_CATALOG: CatalogState = { status: 'idle', groups: [], partial: false }
const IDLE_PRESETS: PresetState = { status: 'idle', options: [] }
const IDLE_PROBE: ProbeState = { status: 'idle' }

function idleProbes(available: boolean): ProbesState {
  const clis = {} as Record<CliId, ProbeState>
  for (const id of CLI_IDS) clis[id] = IDLE_PROBE
  return { available, clis }
}

/** Remote error code of a Host that does not run the optional agent-preset service. */
const PRESETS_ABSENT = 'gateway/invocation-unavailable'

/** Gateway answers of a Host that does not export `rolesubagentsCli/probe` (an older plugin, or Remote services off). */
const PROBE_ABSENT = new Set([
  'gateway/invocation-unavailable',
  'gateway/method-unavailable',
  'gateway/service-unavailable',
  'gateway/definition-unavailable',
])

/** The installed Connection rejects non-2xx with `...: HTTP NNN` (no typed HTTP error). */
export function probeFailureOf(error: unknown): ProbeIssue {
  if (error instanceof ProbeUnavailableError) return 'connection-unavailable'
  if (
    error instanceof SyntaxError ||
    (error instanceof Error &&
      /^(?:connection: invalid (?:server-response|binary response)|rpcId mismatch for )/.test(error.message))
  )
    return 'malformed'
  const status = error instanceof Error ? /\bHTTP (\d{3})\b/.exec(error.message)?.[1] : undefined
  if (status === '401' || status === '403') return 'host-auth'
  // A 404 alone cannot tell whether Gateway or its Remote endpoint is absent.
  if (status === '404') return 'endpoint-unavailable'
  return 'transport'
}

function probeAnswerOf(cli: CliId, answer: unknown): ProbeState {
  if (typeof answer !== 'object' || answer === null) return { status: 'error', issue: 'malformed' }
  const wire = answer as Record<string, unknown>
  if (wire.ok === true) {
    const result = probeResultOf(cli, wire.value)
    return result === undefined ? { status: 'error', issue: 'malformed' } : { status: 'ready', result }
  }
  if (wire.ok !== false || typeof wire.error !== 'object' || wire.error === null)
    return { status: 'error', issue: 'malformed' }
  const error = wire.error as Record<string, unknown>
  if (typeof error.code !== 'string' || typeof error.message !== 'string')
    return { status: 'error', issue: 'malformed' }
  return {
    status: 'error',
    issue: PROBE_ABSENT.has(error.code)
      ? 'remote-unavailable'
      : error.code === 'remote-access/denied'
        ? 'host-auth'
        : 'remote-error',
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read a probe answer defensively: it crosses the wire, so only the known fields of the right type are kept.
 * @param cli - the CLI that was tested.
 * @param value - the Remote value.
 * @returns the result, or undefined when it is not a probe result.
 */
export function probeResultOf(cli: CliId, value: unknown): ProbeResultLike | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.found !== 'boolean' || (raw.cli !== undefined && raw.cli !== cli)) return undefined
  const models = Array.isArray(raw.models)
    ? raw.models.flatMap((entry): ProbeModelLike[] => {
        const model = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {}
        const id = text(model.id)
        if (id === undefined) return []
        const name = text(model.name)
        const efforts = Array.isArray(model.efforts)
          ? model.efforts.filter((effort): effort is string => typeof effort === 'string' && effort.length > 0)
          : undefined
        return [{ id, ...(name === undefined ? {} : { name }), ...(efforts === undefined ? {} : { efforts }) }]
      })
    : undefined
  const path = text(raw.path)
  const version = text(raw.version)
  const message = text(raw.message)
  const auth = raw.auth === 'ok' || raw.auth === 'missing' || raw.auth === 'unknown' ? raw.auth : undefined
  return {
    cli,
    found: raw.found,
    ...(path === undefined ? {} : { path }),
    ...(version === undefined ? {} : { version }),
    ...(auth === undefined ? {} : { auth }),
    ...(models === undefined ? {} : { models }),
    ...(message === undefined ? {} : { message }),
  }
}

/** What the editor suggests for a CLI role's provider, model and effort fields. */
export interface CliSuggestions {
  /** OpenCode only: providers found in the listed `provider/model` ids. */
  readonly providers: readonly string[]
  /** Model ids; for OpenCode, the ids of `provider` (without the `provider/` prefix). */
  readonly models: readonly string[]
  /** Efforts the listed model advertises (OpenCode's free-text effort). */
  readonly efforts: readonly string[]
}

const unique = (values: readonly string[]): string[] => [...new Set(values)]

/**
 * Suggestions for a CLI role's fields: the models a connection test listed, else the descriptor's static list.
 * @param probe - the CLI's connection test state.
 * @param cli - the CLI.
 * @param provider - OpenCode: the provider typed so far.
 * @param model - the model typed so far (for its efforts).
 * @returns the suggestions.
 */
export function cliSuggestions(probe: ProbeState | undefined, cli: CliId, provider = '', model = ''): CliSuggestions {
  const descriptor = cliDescriptor(cli)
  const listed = probe?.status === 'ready' ? (probe.result?.models ?? []) : []
  if (!descriptor.needsProvider) {
    const models = listed.length > 0 ? unique(listed.map(entry => entry.id)) : [...descriptor.modelSuggestions]
    return { providers: [], models, efforts: listed.find(entry => entry.id === model)?.efforts ?? [] }
  }
  const split = listed.flatMap(entry => {
    const slash = entry.id.indexOf('/')
    return slash > 0 && slash < entry.id.length - 1
      ? [{ provider: entry.id.slice(0, slash), model: entry.id.slice(slash + 1), efforts: entry.efforts ?? [] }]
      : []
  })
  const ofProvider = split.filter(entry => entry.provider === provider)
  return {
    providers: unique(split.map(entry => entry.provider)),
    models: unique((ofProvider.length > 0 ? ofProvider : split).map(entry => entry.model)),
    efforts: ofProvider.find(entry => entry.model === model)?.efforts ?? [],
  }
}

function catalogOf(value: ModelCatalogLike): { groups: ProviderOption[]; partial: boolean } {
  return {
    groups: value.groups.map(group => ({
      id: group.id,
      name: group.name,
      models: group.models.map(model => ({ id: model.id, name: model.name, efforts: model.reasoning?.efforts ?? [] })),
    })),
    partial: value.failures.length > 0,
  }
}

/**
 * Create the page controller.
 * @param options - the Host form, the Remote namespaces, and the active locale.
 * @returns the controller; call `dispose` to release its subscriptions.
 */
export function createController(options: ControllerOptions): Controller {
  const { form, remote, probe } = options
  const listeners = new Set<() => void>()
  let disposed = false
  let locale = options.locale
  let draft: Draft | undefined
  let repaired: SettingsProblem[] = []
  let conflict = false
  let save: SavePhase = 'idle'
  let expanded: number | undefined
  let catalog = IDLE_CATALOG
  let presets = IDLE_PRESETS
  let referenceWanted = false
  let workflowCatalogWanted = false
  let catalogRun = 0
  let presetRun = 0
  let probes = idleProbes(probe !== undefined)
  const probeRuns = new Map<CliId, AbortController>()
  let state: PageState

  const hostSettings = (snapshot: FormSnapshot) => normalizeSettings(snapshot.value)

  function build(): PageState {
    const snapshot = form.getSnapshot()
    const current = snapshot.status === 'ready' ? draft : undefined
    const issues = current === undefined ? [] : analyseDraft(current).issues
    const dirty = current !== undefined && isDirty(current)
    const canEdit = current !== undefined && snapshot.writable && save !== 'saving'
    return {
      locale,
      status: snapshot.status,
      writable: snapshot.writable,
      draft: current,
      dirty,
      issues,
      repaired,
      conflict,
      save,
      expanded,
      canEdit,
      canSave: canEdit && dirty && issues.length === 0 && !conflict,
      canAdd: canEdit && canAddRole(current),
      catalog,
      presets,
      probes,
    }
  }

  function publish(): void {
    if (disposed) return
    state = build()
    for (const listener of [...listeners]) listener()
  }

  /** Start a fresh draft from what the Host holds now. */
  function rebase(snapshot: FormSnapshot): void {
    const host = hostSettings(snapshot)
    draft = createDraft(host.settings, snapshot.revision)
    repaired = host.problems
    conflict = false
    expanded = undefined
  }

  function onForm(): void {
    if (disposed) return
    const snapshot = form.getSnapshot()
    if (snapshot.status !== 'ready') {
      draft = undefined
      conflict = false
    } else if (save !== 'saving') {
      if (draft === undefined) {
        rebase(snapshot)
        save = 'idle'
      } else if (snapshot.revision !== draft.revision) {
        // The Host moved. Follow it unless the draft holds edits the Host does not already have.
        if (!isDirty(draft) || sameSettings(draftSettings(draft), hostSettings(snapshot).settings)) {
          rebase(snapshot)
          save = 'idle'
        } else {
          conflict = true
        }
      }
    }
    publish()
  }

  /** Apply a draft edit when editing is allowed; a no-op edit publishes nothing. */
  function edit(change: (current: Draft) => Draft, after?: (next: Draft, previous: Draft) => void): void {
    if (draft === undefined || !state.canEdit) return
    const previous = draft
    const next = change(previous)
    if (next === previous) return
    draft = next
    save = 'idle'
    after?.(next, previous)
    publish()
  }

  /** Open the editor of the row an add or duplicate just created. */
  const openNewRow = (_next: Draft, previous: Draft): void => {
    expanded = previous.nextUid
    loadReference()
  }

  async function loadCatalog(): Promise<void> {
    const run = ++catalogRun
    catalog = { ...catalog, status: 'loading' }
    publish()
    let next: CatalogState
    try {
      const result = await remote?.session?.modelCatalog()
      next = result?.ok ? { status: 'ready', ...catalogOf(result.value) } : { ...catalog, status: 'error' }
    } catch {
      next = { ...catalog, status: 'error' }
    }
    if (run !== catalogRun || disposed) return
    catalog = next
    publish()
  }

  async function loadPresets(): Promise<void> {
    const run = ++presetRun
    presets = { ...presets, status: 'loading' }
    publish()
    let next: PresetState
    try {
      const result = await remote?.agentPresets?.list()
      if (result?.ok) {
        const options = result.value.presets
          .filter(preset => preset.broken === undefined)
          .map(preset => ({ id: preset.id, name: preset.name ?? preset.id }))
        next = { status: 'ready', options }
      } else {
        // A Host without the preset service composes no presets: an empty list, not a failure.
        next =
          result?.error.code === PRESETS_ABSENT ? { status: 'ready', options: [] } : { ...presets, status: 'error' }
      }
    } catch {
      next = { ...presets, status: 'error' }
    }
    if (run !== presetRun || disposed) return
    presets = next
    publish()
  }

  function setProbe(cli: CliId, next: ProbeState): void {
    probes = { ...probes, clis: { ...probes.clis, [cli]: next } }
  }

  function stopProbes(): void {
    for (const run of probeRuns.values()) run.abort()
    probeRuns.clear()
  }

  async function runProbe(cli: CliId): Promise<void> {
    if (probe === undefined || !probes.available || !isCliId(cli)) return
    probeRuns.get(cli)?.abort()
    const run = new AbortController()
    probeRuns.set(cli, run)
    setProbe(cli, { ...probes.clis[cli], status: 'loading' })
    publish()
    let next: ProbeState
    try {
      next = probeAnswerOf(cli, await probe(cli, run.signal))
    } catch (error) {
      next = { status: 'error', issue: probeFailureOf(error) }
    }
    if (disposed || probeRuns.get(cli) !== run) return
    probeRuns.delete(cli)
    setProbe(cli, next)
    publish()
  }

  function loadWorkflowCatalog(): void {
    workflowCatalogWanted = true
    if (catalog.status === 'idle' || catalog.status === 'error') void loadCatalog()
  }

  function loadReference(): void {
    referenceWanted = true
    if (catalog.status === 'idle' || catalog.status === 'error') void loadCatalog()
    if (presets.status === 'idle' || presets.status === 'error') void loadPresets()
  }

  const unsubscribe = form.subscribe(onForm)
  {
    const snapshot = form.getSnapshot()
    if (snapshot.status === 'ready') rebase(snapshot)
  }
  state = build()

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => state,
    setEnabled: enabled => edit(current => setEnabled(current, enabled)),
    setWorkflowModel: model => edit(current => setWorkflowModel(current, model)),
    loadWorkflowCatalog,
    patchRole: (uid, patch) => edit(current => patchRole(current, uid, patch)),
    setContext: (uid, context) => edit(current => setContext(current, uid, context)),
    setForkScope: (uid, scope) => edit(current => setForkScope(current, uid, scope)),
    setModel: (uid, model) => edit(current => setModel(current, uid, model)),
    setAgentPreset: (uid, preset) => edit(current => setAgentPreset(current, uid, preset)),
    setRunner: (uid, cli) => edit(current => setRunner(current, uid, cli)),
    patchRunner: (uid, patch) => edit(current => patchRunner(current, uid, patch)),
    setCliSettings: (cli, patch) => edit(current => setCliSettings(current, cli, patch)),
    probeCli(cli) {
      void runProbe(cli)
    },
    moveRole: (uid, delta) => edit(current => moveRow(current, uid, delta)),
    duplicateRole: uid => edit(current => duplicateRow(current, uid), openNewRow),
    removeRole(uid) {
      edit(
        current => removeRow(current, uid),
        () => {
          if (expanded === uid) expanded = undefined
        },
      )
    },
    addRole: () => edit(addBlankRole, openNewRow),
    addTemplate: templateId => edit(current => addTemplateRole(current, templateId), openNewRow),
    toggleEditor(uid) {
      if (draft === undefined) return
      expanded = expanded === uid ? undefined : uid
      if (expanded !== undefined) loadReference()
      publish()
    },
    async save() {
      if (draft === undefined || !state.canSave) return
      const sent = draft
      const { settings, issues } = analyseDraft(sent)
      if (issues.length > 0) return
      if (form.getSnapshot().revision !== sent.revision) {
        conflict = true
        publish()
        return
      }
      save = 'saving'
      publish()
      let landed = false
      try {
        landed = await form.mutate(
          [
            { op: 'set', path: ['enabled'], value: settings.enabled },
            { op: 'set', path: ['roles'], value: settings.roles },
            { op: 'set', path: ['workflowModel'], value: settings.workflowModel ?? null },
            { op: 'set', path: ['clis'], value: settings.clis ?? {} },
          ],
          sent.revision,
        )
      } catch {
        landed = false
      }
      if (disposed) return
      const snapshot = form.getSnapshot()
      if (landed) {
        if (snapshot.status === 'ready') rebase(snapshot)
        save = 'saved'
      } else if (snapshot.revision !== sent.revision) {
        // The Host refused because the fence moved: someone else saved first.
        conflict = true
        save = 'idle'
      } else {
        save = 'failed'
      }
      publish()
    },
    discard() {
      if (save === 'saving') return
      const snapshot = form.getSnapshot()
      if (snapshot.status === 'ready') rebase(snapshot)
      save = 'idle'
      publish()
    },
    loadReference,
    invalidateReference() {
      catalogRun++
      presetRun++
      catalog = { ...catalog, status: 'idle' }
      presets = { ...presets, status: 'idle' }
      if (referenceWanted) loadReference()
      else if (workflowCatalogWanted) loadWorkflowCatalog()
      else publish()
    },
    resetProbes() {
      stopProbes()
      probes = idleProbes(probe !== undefined)
      publish()
    },
    setLocale(next) {
      if (next === locale) return
      locale = next
      publish()
    },
    dispose() {
      disposed = true
      catalogRun++
      presetRun++
      stopProbes()
      unsubscribe()
      listeners.clear()
    },
  }
}
