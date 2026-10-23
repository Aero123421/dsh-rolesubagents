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
import { mergeKnownRoles } from '../shared/role-management.ts'
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
  sameRawRoles,
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

/** Fixed role-write diagnostics; never render Host or transport exception text. */
export type RoleSaveIssue =
  | 'expression-backed-role-settings'
  | 'role-write-safety-unavailable'
  | 'role-write-safety-conflict'
  | 'role-save-unconfirmed'

/** Check raw Host syntax safety at the exact revision about to be written. */
export type RoleWriteSafetyCall = (expectedRevision: number, signal: AbortSignal) => Promise<RemoteResult<unknown>>

/** Live, separately persisted permission; never part of a role draft or Session snapshot. */
export interface ManagementState {
  readonly enabled: boolean
  readonly save: SavePhase | 'conflict'
  readonly hasRevision: boolean
  readonly canToggle: boolean
}

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
  readonly saveIssue: RoleSaveIssue | undefined
  readonly management: ManagementState
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
  /** Production always supplies this; omission is a backwards-compatible unit-test/embedding seam. */
  roleWriteSafety?: RoleWriteSafetyCall
}

export interface Controller {
  subscribe(listener: () => void): () => void
  getSnapshot(): PageState
  setEnabled(enabled: boolean): void
  /** Save only the live management gate immediately, using the current Host revision. */
  setAllowAiRoleManagement(enabled: boolean): Promise<void>
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
  /** Invalidate syntax checks across a transport/Host reset; wait for a fresh accepted form. */
  resetRoleWriteSafety(): void
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

function roleWriteSafetyIssue(reply: unknown, expectedRevision: number): RoleSaveIssue | undefined {
  if (typeof reply !== 'object' || reply === null || !('ok' in reply) || reply.ok !== true || !('value' in reply))
    return 'role-write-safety-unavailable'
  const value = reply.value
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('safe' in value) ||
    typeof value.safe !== 'boolean' ||
    !('reason' in value)
  )
    return 'role-write-safety-unavailable'
  if (value.reason === 'revision-conflict') return 'role-write-safety-conflict'
  const revision = 'revision' in value ? value.revision : undefined
  if (revision !== undefined && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0))
    return 'role-write-safety-unavailable'
  if (typeof revision === 'number' && revision !== expectedRevision) return 'role-write-safety-conflict'
  if (value.safe === false && value.reason === 'expression-backed-role-settings')
    return 'expression-backed-role-settings'
  return value.safe === true && value.reason === 'literal-role-settings' && revision === expectedRevision
    ? undefined
    : 'role-write-safety-unavailable'
}

/**
 * Create the page controller.
 * @param options - the Host form, the Remote namespaces, and the active locale.
 * @returns the controller; call `dispose` to release its subscriptions.
 */
export function createController(options: ControllerOptions): Controller {
  const { form, remote, probe, roleWriteSafety } = options
  const lifetime = new AbortController()
  const listeners = new Set<() => void>()
  let disposed = false
  let locale = options.locale
  let draft: Draft | undefined
  let repaired: SettingsProblem[] = []
  let conflict = false
  let save: SavePhase = 'idle'
  let saveIssue: RoleSaveIssue | undefined
  let managementSave: ManagementState['save'] = 'idle'
  let lastManagementEnabled = false
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
  let observedForm = form.getSnapshot()
  let formEpoch = 0
  let roleSafetyWaitForForm = false
  let activeRoleSafety: AbortController | undefined

  const hostSettings = (snapshot: FormSnapshot) => normalizeSettings(snapshot.value)
  const rawRoles = (snapshot: FormSnapshot): readonly unknown[] => {
    const value = snapshot.value
    if (typeof value === 'object' && value !== null && 'roles' in value && Array.isArray(value.roles))
      return value.roles
    // The draft also uses normalized defaults when an old Host omitted a literal roles array.
    return hostSettings(snapshot).settings.roles
  }
  const managementEnabled = (snapshot: FormSnapshot): boolean => {
    const value = snapshot.value
    return (
      snapshot.status === 'ready' &&
      typeof value === 'object' &&
      value !== null &&
      'allowAiRoleManagement' in value &&
      value.allowAiRoleManagement === true
    )
  }
  const hasRevision = (snapshot: FormSnapshot): boolean =>
    typeof snapshot.revision === 'number' && Number.isSafeInteger(snapshot.revision) && snapshot.revision >= 0

  function build(): PageState {
    const snapshot = form.getSnapshot()
    const current = snapshot.status === 'ready' ? draft : undefined
    const issues = current === undefined ? [] : analyseDraft(current).issues
    const dirty = current !== undefined && isDirty(current)
    const canEdit = current !== undefined && snapshot.writable && save !== 'saving' && managementSave !== 'saving'
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
      saveIssue,
      management: {
        enabled: managementEnabled(snapshot),
        save: managementSave,
        hasRevision: hasRevision(snapshot),
        canToggle:
          snapshot.status === 'ready' &&
          snapshot.writable &&
          hasRevision(snapshot) &&
          (save !== 'saving' || managementEnabled(snapshot)) &&
          (!roleSafetyWaitForForm || managementEnabled(snapshot)) &&
          managementSave !== 'saving',
      },
      expanded,
      canEdit,
      canSave: canEdit && (dirty || repaired.length > 0) && issues.length === 0 && !conflict && !roleSafetyWaitForForm,
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
    saveIssue = undefined
    const host = hostSettings(snapshot)
    draft = createDraft(host.settings, snapshot.revision, rawRoles(snapshot))
    repaired = host.problems
    conflict = false
    expanded = undefined
  }

  const origins = (current: Draft) =>
    current.rows.flatMap(row => (row.sourceId === undefined ? [] : [{ id: row.role.id, sourceId: row.sourceId }]))

  function onForm(): void {
    if (disposed) return
    const snapshot = form.getSnapshot()
    const dataChanged = snapshot.value !== observedForm.value || snapshot.revision !== observedForm.revision
    const becameReady = snapshot.status === 'ready' && observedForm.status !== 'ready'
    if (dataChanged || snapshot.status !== observedForm.status || snapshot.writable !== observedForm.writable) {
      formEpoch++
      if (activeRoleSafety !== undefined) {
        saveIssue = 'role-write-safety-conflict'
        activeRoleSafety.abort()
      }
    }
    if (snapshot.status !== 'ready') roleSafetyWaitForForm = true
    else if (dataChanged || becameReady) roleSafetyWaitForForm = false
    observedForm = snapshot
    const acceptedGate = managementEnabled(snapshot)
    if (acceptedGate !== lastManagementEnabled && managementSave !== 'saving') managementSave = 'idle'
    lastManagementEnabled = acceptedGate
    // A temporary namespace disappearance hides the editor, not the user's inputs.
    // Reconcile the retained draft only when an authoritative ready view returns.
    if (snapshot.status === 'ready' && save !== 'saving') {
      if (draft === undefined) {
        rebase(snapshot)
        save = 'idle'
      } else if (snapshot.revision !== draft.revision || dataChanged || becameReady) {
        const host = hostSettings(snapshot)
        const raw = rawRoles(snapshot)
        const rawUnchanged = sameRawRoles(draft.rawBaseRoles, raw)
        if (!isDirty(draft) && saveIssue !== 'role-save-unconfirmed') {
          rebase(snapshot)
          save = 'idle'
        } else if (
          host.problems.length === 0 &&
          sameSettings(draftSettings(draft), host.settings) &&
          sameRawRoles(mergeKnownRoles(draft.rawBaseRoles, draftSettings(draft).roles, origins(draft)), raw)
        ) {
          // The mirror confirms exactly this draft, including its untouched opaque metadata.
          rebase(snapshot)
          save = 'idle'
        } else if (sameSettings(draft.base, host.settings) && rawUnchanged) {
          // A disjoint live setting (notably the management gate) changed. Keep every input/editor.
          draft = { ...draft, revision: snapshot.revision }
          repaired = host.problems
          conflict = saveIssue === 'role-save-unconfirmed'
        } else {
          conflict = true
        }
      }
    }
    publish()
  }

  /** Apply a draft edit when editing is allowed; a no-op edit publishes nothing. */
  function edit(change: (current: Draft) => Draft, after?: (next: Draft, previous: Draft) => void): void {
    if (disposed || draft === undefined || !state.canEdit) return
    const previous = draft
    const next = change(previous)
    if (next === previous) return
    draft = next
    save = 'idle'
    saveIssue = roleSafetyWaitForForm ? 'role-write-safety-conflict' : undefined
    after?.(next, previous)
    publish()
  }

  /** Open the editor of the row an add or duplicate just created. */
  const openNewRow = (_next: Draft, previous: Draft): void => {
    expanded = previous.nextUid
    loadReference()
  }

  async function loadCatalog(): Promise<void> {
    if (disposed) return
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
    if (disposed) return
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
    if (disposed || probe === undefined || !probes.available || !isCliId(cli)) return
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
    lastManagementEnabled = managementEnabled(snapshot)
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
    async setAllowAiRoleManagement(enabled) {
      if (disposed) return
      const sent = form.getSnapshot()
      const revision = sent.revision
      if (
        !state.management.canToggle ||
        sent.status !== 'ready' ||
        !sent.writable ||
        typeof revision !== 'number' ||
        !hasRevision(sent) ||
        ((save === 'saving' || roleSafetyWaitForForm) && enabled) ||
        managementEnabled(sent) === enabled
      )
        return
      managementSave = 'saving'
      publish()
      let landed = false
      try {
        landed = await form.mutate([{ op: 'set', path: ['allowAiRoleManagement'], value: enabled }], revision)
      } catch {
        landed = false
      }
      if (disposed) return
      const accepted = form.getSnapshot()
      managementSave =
        landed &&
        accepted.status === 'ready' &&
        hasRevision(accepted) &&
        accepted.revision !== revision &&
        managementEnabled(accepted) === enabled
          ? 'saved'
          : accepted.revision !== revision
            ? 'conflict'
            : 'failed'
      publish()
    },
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
      if (disposed || draft === undefined) return
      expanded = expanded === uid ? undefined : uid
      if (expanded !== undefined) loadReference()
      publish()
    },
    async save() {
      if (disposed || draft === undefined || !state.canSave) return
      const sent = draft
      const sentForm = form.getSnapshot()
      const sentEpoch = formEpoch
      const { settings, issues } = analyseDraft(sent)
      if (issues.length > 0) return
      if (sentForm.revision !== sent.revision || sentForm.value !== observedForm.value || sentForm.status !== 'ready') {
        conflict = true
        publish()
        return
      }
      saveIssue = undefined
      save = 'saving'
      publish()
      if (roleWriteSafety !== undefined) {
        const request = new AbortController()
        activeRoleSafety = request
        let blocked: RoleSaveIssue | undefined
        const revision = sent.revision
        if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
          blocked = 'role-write-safety-unavailable'
        } else {
          try {
            blocked = roleWriteSafetyIssue(await roleWriteSafety(revision, request.signal), revision)
          } catch {
            blocked = 'role-write-safety-unavailable'
          }
        }
        if (activeRoleSafety === request) activeRoleSafety = undefined
        if (disposed || lifetime.signal.aborted) return
        const accepted = form.getSnapshot()
        if (formEpoch !== sentEpoch || draft !== sent || accepted.value !== sentForm.value || roleSafetyWaitForForm)
          blocked = 'role-write-safety-conflict'
        if (blocked === undefined && (accepted.status !== 'ready' || !accepted.writable))
          blocked = 'role-write-safety-unavailable'
        if (blocked === undefined && accepted.revision !== sent.revision) blocked = 'role-write-safety-conflict'
        if (blocked !== undefined) {
          saveIssue = blocked
          save = 'failed'
          if (
            draft !== undefined &&
            accepted.status === 'ready' &&
            (accepted.revision !== sent.revision || accepted.value !== sentForm.value || formEpoch !== sentEpoch)
          ) {
            if (
              sameSettings(draft.base, hostSettings(accepted).settings) &&
              sameRawRoles(draft.rawBaseRoles, rawRoles(accepted))
            ) {
              draft = { ...draft, revision: accepted.revision }
              conflict = false
            } else conflict = true
          }
          publish()
          return
        }
      }
      let landed = false
      let sentRoles: readonly unknown[] = []
      try {
        sentRoles = mergeKnownRoles(sent.rawBaseRoles, settings.roles, origins(sent))
        landed = await form.mutate(
          [
            { op: 'set', path: ['enabled'], value: settings.enabled },
            { op: 'set', path: ['roles'], value: sentRoles },
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
        const held = hostSettings(snapshot)
        if (
          snapshot.status === 'ready' &&
          sameSettings(settings, held.settings) &&
          held.problems.length === 0 &&
          sameRawRoles(sentRoles, rawRoles(snapshot))
        ) {
          rebase(snapshot)
          save = 'saved'
        } else {
          // Acceptance is not proof that a shared form's mirror has caught up.
          // Preserve the submitted draft; neither claim failure nor retry a possibly committed write.
          conflict = true
          save = 'idle'
          saveIssue = 'role-save-unconfirmed'
        }
      } else if (snapshot.revision !== sent.revision) {
        // Reconcile the refused write, but never retry it. A gate-only change can safely
        // advance the draft fence; real role/metadata changes still produce a conflict.
        save = 'idle'
        onForm()
        return
      } else {
        save = 'failed'
      }
      publish()
    },
    discard() {
      if (disposed || save === 'saving' || managementSave === 'saving') return
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
    resetRoleWriteSafety() {
      formEpoch++
      roleSafetyWaitForForm = true
      activeRoleSafety?.abort()
      if (save === 'saving' || (draft !== undefined && isDirty(draft))) saveIssue = 'role-write-safety-conflict'
      publish()
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
      lifetime.abort()
      activeRoleSafety?.abort()
      catalogRun++
      presetRun++
      stopProbes()
      unsubscribe()
      listeners.clear()
    },
  }
}
