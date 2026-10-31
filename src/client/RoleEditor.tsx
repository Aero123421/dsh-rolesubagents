/** The inline editor of one role: fields, model and preset pickers (or the CLI runner fields), and the preview. */

import { useEffect, useId, useRef } from 'react'
import { CLI_IDS, cliDescriptor, isCliId } from '../shared/cli/index.ts'
import {
  type ForkScope,
  MAX_DESCRIPTION_LENGTH,
  MAX_INSTRUCTIONS_LENGTH,
  type RoleDefinition,
  type RoleModel,
  type RoleRunner,
} from '../shared/roles.ts'
import { CliModelRefresh } from './CliSection.tsx'
import { useController, useT } from './context.tsx'
import { cliSuggestions, type PageState } from './controller.ts'
import { childText, type DraftRow, ID_MAX_LENGTH, type IssueField, parentLine, permissionAllowed } from './draft.ts'
import {
  accessName,
  confinementHelp,
  issueText,
  presetName,
  readOnlyHelp,
  TIMEOUT_TEXT,
  type Translator,
} from './i18n.ts'
import { Button, Field, TextInput } from './ui.tsx'

interface EditorProps {
  row: DraftRow
  state: PageState
}

function counterOf(t: Translator, used: number, max: number): { text: string; over: boolean } {
  const left = max - used
  return left >= 0
    ? { text: t('ed.remaining', { count: left }), over: false }
    : { text: t('ed.over', { count: -left }), over: true }
}

export function RoleEditor({ row, state }: EditorProps) {
  const c = useController()
  const t = useT()
  const { role, uid } = row
  const builtin = role.builtin !== undefined
  const canEdit = state.canEdit
  const contextName = useId()
  const readOnlyHelpId = useId()
  const root = useRef<HTMLElement>(null)
  const errorOf = (field: IssueField): string | undefined => {
    const issue = state.issues.find(candidate => candidate.uid === uid && candidate.field === field)
    return issue === undefined ? undefined : issueText(issue, t)
  }

  // Opening an editor (or adding a role) moves the cursor to its first editable field.
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled)')?.focus()
  }, [])

  return (
    <section className="dshrs-editor" aria-label={t('row.editLabel', { id: role.id })} ref={root}>
      <Field
        label={t('ed.id')}
        help={builtin ? t('ed.idFixed') : t('ed.idHelp', { max: ID_MAX_LENGTH })}
        error={errorOf('id')}
      >
        {a11y => (
          <input
            {...a11y}
            className="dshrs-input dshrs-mono"
            value={role.id}
            disabled={!canEdit || builtin}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="none"
            onChange={event => c.patchRole(uid, { id: event.target.value })}
          />
        )}
      </Field>

      <RunsOnField uid={uid} role={role} canEdit={canEdit} error={errorOf('runner')} />

      <Field
        label={t('ed.description')}
        help={t('ed.descriptionHelp')}
        error={errorOf('description')}
        counter={counterOf(t, role.description.length, MAX_DESCRIPTION_LENGTH)}
      >
        {a11y => (
          <textarea
            {...a11y}
            className="dshrs-textarea"
            rows={3}
            value={role.description}
            disabled={!canEdit}
            onChange={event => c.patchRole(uid, { description: event.target.value })}
          />
        )}
      </Field>

      <Field
        label={t('ed.instructions')}
        help={t('ed.instructionsHelp')}
        error={errorOf('instructions')}
        counter={counterOf(t, role.instructions.length, MAX_INSTRUCTIONS_LENGTH)}
      >
        {a11y => (
          <textarea
            {...a11y}
            className="dshrs-textarea"
            rows={6}
            value={role.instructions}
            disabled={!canEdit}
            onChange={event => c.patchRole(uid, { instructions: event.target.value })}
          />
        )}
      </Field>

      {role.runner === undefined ? (
        <>
          <fieldset className="dshrs-group">
            <legend>{t('ed.context')}</legend>
            {(['spawn', 'fork'] as const).map(value => (
              <label className="dshrs-choice" key={value}>
                <input
                  type="radio"
                  name={contextName}
                  value={value}
                  checked={role.context === value}
                  disabled={!canEdit || builtin}
                  onChange={() => c.setContext(uid, value)}
                />
                <span>{t(value === 'spawn' ? 'ed.contextSpawn' : 'ed.contextFork')}</span>
              </label>
            ))}
            {builtin ? <p className="dshrs-hint">{t('ed.contextFixed')}</p> : null}
          </fieldset>

          {role.context === 'fork' ? <ForkScopeField uid={uid} role={role} canEdit={canEdit} /> : null}

          <ModelFields uid={uid} role={role} state={state} error={errorOf('model')} />
          <PresetField uid={uid} role={role} state={state} error={errorOf('preset')} />
        </>
      ) : (
        <RunnerFields uid={uid} role={role} runner={role.runner} state={state} errorOf={errorOf} />
      )}

      <fieldset className="dshrs-group">
        <legend>{t('ed.readOnly')}</legend>
        <label className="dshrs-choice">
          <input
            type="checkbox"
            checked={role.readOnly}
            disabled={!canEdit}
            aria-describedby={readOnlyHelpId}
            onChange={event => c.patchRole(uid, { readOnly: event.target.checked })}
          />
          <span>{t('ed.readOnlyLabel')}</span>
        </label>
        <p className="dshrs-hint" id={readOnlyHelpId}>
          {role.runner === undefined ? t('ed.readOnlyHelp') : readOnlyHelp(t, role.runner.cli)}
        </p>
      </fieldset>

      <Preview role={role} />
    </section>
  )
}

function RunsOnField(props: { uid: number; role: RoleDefinition; canEdit: boolean; error: string | undefined }) {
  const c = useController()
  const t = useT()
  const builtin = props.role.builtin !== undefined
  return (
    <Field label={t('ed.runsOn')} help={t(builtin ? 'ed.runsOnBuiltin' : 'ed.runsOnHelp')} error={props.error}>
      {a11y => (
        <select
          {...a11y}
          className="dshrs-select"
          value={props.role.runner?.cli ?? ''}
          disabled={!props.canEdit || builtin}
          onChange={event => {
            const next = event.target.value
            c.setRunner(props.uid, isCliId(next) ? next : undefined)
          }}
        >
          <option value="">{t('ed.runsOnDsh')}</option>
          {CLI_IDS.map(id => (
            <option key={id} value={id}>
              {cliDescriptor(id).displayName}
            </option>
          ))}
        </select>
      )}
    </Field>
  )
}

/** Typed timeout text → the text of the number it stands for ('' when empty). */
const timeoutText = (text: string): string => (text.trim() === '' ? '' : String(Number(text.trim())))

/** The fields of a role that runs on an external CLI, and what such a role cannot do. */
function RunnerFields(props: {
  uid: number
  role: RoleDefinition
  runner: RoleRunner
  state: PageState
  errorOf: (field: IssueField) => string | undefined
}) {
  const c = useController()
  const t = useT()
  const { uid, role, runner, state, errorOf } = props
  const descriptor = cliDescriptor(runner.cli)
  const cli = descriptor.displayName
  const disabled = !state.canEdit
  const provider = runner.provider ?? ''
  const model = runner.model ?? ''
  const effort = runner.effort ?? ''
  const suggestions = cliSuggestions(state.probes.clis[runner.cli], runner.cli, provider, model)
  // Plain characters only: some DOMs resolve `list` through a CSS selector, where React's `:r1:` ids are invalid.
  const lists = `dshrs-list${useId().replace(/[^\w-]/g, '')}`
  const modelError = errorOf('runnerModel')
  const effortList =
    descriptor.effortFreeText || suggestions.efforts.length > 0 ? [...suggestions.efforts] : [...descriptor.efforts]
  const textInput = { className: 'dshrs-input', spellCheck: false, autoComplete: 'off', disabled } as const
  return (
    <fieldset className="dshrs-group">
      <legend>{t('ed.cliSettings', { cli })}</legend>
      <div className="dshrs-model-grid">
        {descriptor.needsProvider ? (
          <Field label={t('ed.provider')} error={modelError}>
            {a11y => (
              <input
                {...a11y}
                {...textInput}
                list={`${lists}-providers`}
                value={provider}
                onChange={event => c.patchRunner(uid, { provider: event.target.value })}
              />
            )}
          </Field>
        ) : null}
        <Field label={t('ed.modelId')} error={descriptor.needsProvider ? undefined : modelError}>
          {a11y => (
            <input
              {...a11y}
              {...textInput}
              list={`${lists}-models`}
              value={model}
              placeholder={descriptor.needsProvider ? undefined : t('row.cliDefault')}
              onChange={event => c.patchRunner(uid, { model: event.target.value })}
            />
          )}
        </Field>
        {descriptor.effortFreeText ? (
          <Field label={t('ed.effort')} help={t('ed.cliEffortFree')} error={errorOf('effort')}>
            {a11y => (
              <input
                {...a11y}
                {...textInput}
                list={`${lists}-efforts`}
                value={effort}
                onChange={event => c.patchRunner(uid, { effort: event.target.value })}
              />
            )}
          </Field>
        ) : descriptor.efforts.length > 0 ? (
          <Field label={t('ed.effort')} error={errorOf('effort')}>
            {a11y => (
              <select
                {...a11y}
                className="dshrs-select"
                value={effort}
                disabled={disabled}
                onChange={event => c.patchRunner(uid, { effort: event.target.value })}
              >
                <option value="">{t('ed.effortDefault')}</option>
                {effortList.map(id => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
                {effort !== '' && !effortList.includes(effort) ? (
                  <option value={effort}>{t('ed.unlisted', { value: effort })}</option>
                ) : null}
              </select>
            )}
          </Field>
        ) : null}
      </div>
      <p className="dshrs-hint">{t(descriptor.needsProvider ? 'ed.cliModelOpenCode' : 'ed.cliModelHelp', { cli })}</p>
      <CliModelRefresh cli={runner.cli} state={state} />
      <datalist id={`${lists}-providers`}>
        {suggestions.providers.map(id => (
          <option key={id} value={id} />
        ))}
      </datalist>
      <datalist id={`${lists}-models`}>
        {suggestions.models.map(id => (
          <option key={id} value={id} />
        ))}
      </datalist>
      <datalist id={`${lists}-efforts`}>
        {effortList.map(id => (
          <option key={id} value={id} />
        ))}
      </datalist>
      <div className="dshrs-model-grid">
        <Field
          label={t('ed.permission')}
          help={[
            t('ed.permissionHelp', { cli }),
            confinementHelp(t, runner.cli, runner.permission),
            role.readOnly ? t('ed.permissionReadOnly') : '',
          ]
            .filter(text => text !== '')
            .join(' ')}
          error={errorOf('permission')}
        >
          {a11y => (
            <select
              {...a11y}
              className="dshrs-select"
              value={runner.permission}
              disabled={disabled}
              onChange={event => c.patchRunner(uid, { permission: event.target.value })}
            >
              {descriptor.permissions.map(preset => (
                <option
                  key={preset.id}
                  value={preset.id}
                  disabled={!permissionAllowed(runner.cli, preset.id, role.readOnly)}
                >
                  {t('ed.permissionOption', {
                    name: preset.confinement === 'host-sandbox' ? t('preset.host-workspace') : presetName(t, preset.id),
                    access: preset.nativeHarness ? t('access.native') : accessName(t, preset.access),
                  })}
                </option>
              ))}
              {descriptor.permissions.some(preset => preset.id === runner.permission) ? null : (
                <option value={runner.permission}>{t('ed.unlisted', { value: runner.permission })}</option>
              )}
            </select>
          )}
        </Field>
        <Field label={t('ed.timeout')} help={t('ed.timeoutHelp', TIMEOUT_TEXT)} error={errorOf('timeout')}>
          {a11y => (
            <TextInput
              {...a11y}
              {...textInput}
              inputMode="numeric"
              placeholder={String(TIMEOUT_TEXT.default)}
              value={runner.timeoutMinutes === undefined ? '' : String(runner.timeoutMinutes)}
              canonical={timeoutText}
              onText={text =>
                c.patchRunner(uid, { timeoutMinutes: text.trim() === '' ? undefined : Number(text.trim()) })
              }
            />
          )}
        </Field>
      </div>
      <div className="dshrs-notice">
        <p>{t('ed.cliLimits')}</p>
        <ul>
          <li>{t('ed.cliLimitOnce')}</li>
          <li>{t('ed.cliLimitFresh')}</li>
          <li>{t('ed.cliLimitInstalled', { cli })}</li>
          <li>{t('ed.cliLimitCancel')}</li>
        </ul>
      </div>
    </fieldset>
  )
}

function ForkScopeField({ uid, role, canEdit }: { uid: number; role: RoleDefinition; canEdit: boolean }) {
  const c = useController()
  const t = useT()
  const scope: ForkScope = role.forkScope === 'task' ? 'task' : 'full'
  return (
    <>
      <Field label={t('ed.forkScope')} help={scope === 'task' ? t('ed.forkScopeTaskHelp') : undefined}>
        {a11y => (
          <select
            {...a11y}
            className="dshrs-select"
            value={scope}
            disabled={!canEdit}
            onChange={event => c.setForkScope(uid, event.target.value === 'task' ? 'task' : 'full')}
          >
            <option value="full">{t('ed.forkScopeFull')}</option>
            <option value="task">{t('ed.forkScopeTask')}</option>
          </select>
        )}
      </Field>
      {scope === 'full' ? (
        <p className="dshrs-notice dshrs-notice--warn" role="note">
          {t('ed.forkScopeWarn')}
        </p>
      ) : null}
    </>
  )
}

interface PickerProps {
  uid: number
  role: RoleDefinition
  state: PageState
  error: string | undefined
}

/** The workflow picker shares provider/model controls, but never role-only settings. */
export function WorkflowModelFields({ state }: { state: PageState }) {
  const c = useController()
  const t = useT()
  useEffect(() => c.loadWorkflowCatalog(), [c])
  const issue = state.issues.find(candidate => candidate.code === 'invalid-workflow-model')
  return <ModelFields state={state} workflow error={issue === undefined ? undefined : issueText(issue, t)} />
}

function ModelFields({
  uid,
  role,
  state,
  error,
  workflow = false,
}: {
  uid?: number
  role?: RoleDefinition
  state: PageState
  error: string | undefined
  workflow?: boolean
}) {
  const c = useController()
  const t = useT()
  const { catalog } = state
  const fork = role?.context === 'fork'
  const disabled = !state.canEdit || fork
  const selected = workflow ? state.draft?.workflowModel : role?.model
  const provider = selected?.provider ?? ''
  const model = selected?.model ?? ''
  const effort = role?.model?.reasoningEffort ?? ''
  const setModel = (next: RoleModel | undefined) => {
    if (workflow) c.setWorkflowModel(next === undefined ? undefined : { provider: next.provider, model: next.model })
    else if (uid !== undefined) c.setModel(uid, next)
  }
  const route = (next: Partial<RoleModel>) => setModel({ provider, model, reasoningEffort: effort, ...next })

  const group = catalog.groups.find(candidate => candidate.id === provider)
  const option = group?.models.find(candidate => candidate.id === model)
  const efforts = option?.efforts ?? []
  const listed = catalog.groups.length > 0
  const hint = fork
    ? t('ed.modelForkNote')
    : listed
      ? t('ed.modelParentNote')
      : catalog.status === 'error' || catalog.status === 'ready'
        ? t('ed.catalogFailed')
        : t('ed.catalogLoading')

  return (
    <fieldset className="dshrs-group">
      <legend>{t(workflow ? 'workflow.heading' : 'ed.model')}</legend>
      <div className="dshrs-model-grid">
        <Field label={t('ed.provider')} error={error}>
          {a11y =>
            listed ? (
              <select
                {...a11y}
                className="dshrs-select"
                value={provider}
                disabled={disabled}
                onChange={event => {
                  const next = event.target.value
                  const first = catalog.groups.find(candidate => candidate.id === next)?.models[0]?.id ?? ''
                  setModel(next === '' ? undefined : { provider: next, model: first })
                }}
              >
                <option value="">{t('ed.parentModel')}</option>
                {catalog.groups.map(candidate => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
                {provider !== '' && group === undefined ? (
                  <option value={provider}>{t('ed.unlisted', { value: provider })}</option>
                ) : null}
              </select>
            ) : (
              <input
                {...a11y}
                className="dshrs-input"
                value={provider}
                disabled={disabled}
                spellCheck={false}
                autoComplete="off"
                onChange={event => route({ provider: event.target.value })}
              />
            )
          }
        </Field>
        {listed && provider === '' ? null : (
          <Field label={t('ed.modelId')}>
            {a11y =>
              listed ? (
                <select
                  {...a11y}
                  className="dshrs-select"
                  value={model}
                  disabled={disabled}
                  onChange={event => setModel({ provider, model: event.target.value })}
                >
                  <option value="">{t('ed.selectModel')}</option>
                  {(group?.models ?? []).map(candidate => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                  {model !== '' && option === undefined ? (
                    <option value={model}>{t('ed.unlisted', { value: model })}</option>
                  ) : null}
                </select>
              ) : (
                <input
                  {...a11y}
                  className="dshrs-input"
                  value={model}
                  disabled={disabled}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={event => route({ model: event.target.value })}
                />
              )
            }
          </Field>
        )}
        {workflow || (listed && (provider === '' || model === '' || (efforts.length === 0 && effort === ''))) ? null : (
          <Field label={t('ed.effort')}>
            {a11y =>
              listed ? (
                <select
                  {...a11y}
                  className="dshrs-select"
                  value={effort}
                  disabled={disabled}
                  onChange={event => route({ reasoningEffort: event.target.value })}
                >
                  <option value="">{t('ed.effortDefault')}</option>
                  {efforts.map(candidate => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                  {effort !== '' && !efforts.some(candidate => candidate.id === effort) ? (
                    <option value={effort}>{t('ed.unlisted', { value: effort })}</option>
                  ) : null}
                </select>
              ) : (
                <input
                  {...a11y}
                  className="dshrs-input"
                  value={effort}
                  disabled={disabled}
                  spellCheck={false}
                  autoComplete="off"
                  onChange={event => route({ reasoningEffort: event.target.value })}
                />
              )
            }
          </Field>
        )}
      </div>
      {workflow ? <p className="dshrs-hint">{t('workflow.hint')}</p> : null}
      <p className="dshrs-hint">
        {hint}
        {catalog.partial && listed && !fork ? ` ${t('ed.catalogPartial')}` : ''}
      </p>
      {!fork && catalog.status === 'error' ? (
        <div>
          <Button onClick={() => (workflow ? c.loadWorkflowCatalog() : c.loadReference())}>{t('ed.retry')}</Button>
        </div>
      ) : null}
    </fieldset>
  )
}

function PresetField({ uid, role, state, error }: PickerProps) {
  const c = useController()
  const t = useT()
  const { presets } = state
  const fork = role.context === 'fork'
  const preset = role.agentPreset ?? ''
  const typed = presets.status === 'error'
  const help = fork
    ? t('ed.presetFork')
    : presets.status === 'ready' && presets.options.length === 0
      ? `${t('ed.presetHelp')} ${t('ed.presetNoneAvailable')}`
      : t('ed.presetHelp')
  return (
    <Field label={t('ed.preset')} help={help} error={error}>
      {a11y =>
        typed ? (
          <input
            {...a11y}
            className="dshrs-input"
            value={preset}
            disabled={!state.canEdit || fork}
            spellCheck={false}
            autoComplete="off"
            onChange={event => c.setAgentPreset(uid, event.target.value)}
          />
        ) : (
          <select
            {...a11y}
            className="dshrs-select"
            value={preset}
            disabled={!state.canEdit || fork}
            onChange={event => c.setAgentPreset(uid, event.target.value)}
          >
            <option value="">{t('ed.presetNone')}</option>
            {presets.options.map(option => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
            {preset !== '' && !presets.options.some(option => option.id === preset) ? (
              <option value={preset}>{t('ed.unlisted', { value: preset })}</option>
            ) : null}
          </select>
        )
      }
    </Field>
  )
}

function Preview({ role }: { role: RoleDefinition }) {
  const t = useT()
  const child = childText(role)
  return (
    <section className="dshrs-preview" aria-label={t('ed.preview')}>
      <h4 className="dshrs-sub">{t('ed.previewParent')}</h4>
      <pre className="dshrs-pre">{parentLine(role)}</pre>
      <h4 className="dshrs-sub">{t('ed.previewChild')}</h4>
      {child === '' ? (
        <p className="dshrs-hint">{t('ed.previewChildNone')}</p>
      ) : (
        <pre className="dshrs-pre">{child}</pre>
      )}
    </section>
  )
}
