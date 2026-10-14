/**
 * The page's controller: one observable state over the Host settings form, the
 * draft being edited, the save in flight, and the model and preset lists the
 * editor offers. Components read {@link Controller.getSnapshot} and call the
 * actions; nothing here touches React or the DOM.
 *
 * The draft always exists while the form is `ready`. It follows the Host while
 * it holds no edits; once it holds edits, a Host revision that moved underneath
 * it is a conflict, and the only ways out are to discard or reload.
 */

import { normalizeSettings, type RoleContext, type RoleModel, type SettingsProblem } from '../shared/roles.ts'
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
  type RolePatch,
  removeRow,
  sameSettings,
  setAgentPreset,
  setContext,
  setEnabled,
  setModel,
} from './draft.ts'
import type { CatalogEffort, ConfigFormLike, DshRemote, FormSnapshot, ModelCatalogLike } from './dsh.ts'

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
}

export interface ControllerOptions {
  form: ConfigFormLike
  /** Source of the model catalog and the preset list; both are optional. */
  remote: DshRemote | undefined
  locale: string
}

export interface Controller {
  subscribe(listener: () => void): () => void
  getSnapshot(): PageState
  setEnabled(enabled: boolean): void
  patchRole(uid: number, patch: RolePatch): void
  setContext(uid: number, context: RoleContext): void
  setModel(uid: number, model: RoleModel | undefined): void
  setAgentPreset(uid: number, preset: string | undefined): void
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
  setLocale(locale: string): void
  dispose(): void
}

const IDLE_CATALOG: CatalogState = { status: 'idle', groups: [], partial: false }
const IDLE_PRESETS: PresetState = { status: 'idle', options: [] }

/** Remote error code of a Host that does not run the optional agent-preset service. */
const PRESETS_ABSENT = 'gateway/invocation-unavailable'

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
  const { form, remote } = options
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
  let catalogRun = 0
  let presetRun = 0
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
    patchRole: (uid, patch) => edit(current => patchRole(current, uid, patch)),
    setContext: (uid, context) => edit(current => setContext(current, uid, context)),
    setModel: (uid, model) => edit(current => setModel(current, uid, model)),
    setAgentPreset: (uid, preset) => edit(current => setAgentPreset(current, uid, preset)),
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
      else publish()
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
      unsubscribe()
      listeners.clear()
    },
  }
}
