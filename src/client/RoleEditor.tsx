/** The inline editor of one role: fields, model and preset pickers, and the preview. */

import { useEffect, useId, useRef } from 'react'
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_INSTRUCTIONS_LENGTH,
  type RoleDefinition,
  type RoleModel,
} from '../shared/roles.ts'
import { useController, useT } from './context.tsx'
import type { PageState } from './controller.ts'
import { childText, type DraftRow, ID_MAX_LENGTH, type IssueField, parentLine } from './draft.ts'
import { issueText, type Translator } from './i18n.ts'
import { Button, Field } from './ui.tsx'

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
  const readOnlyHelp = useId()
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

      <ModelFields uid={uid} role={role} state={state} error={errorOf('model')} />
      <PresetField uid={uid} role={role} state={state} error={errorOf('preset')} />

      <fieldset className="dshrs-group">
        <legend>{t('ed.readOnly')}</legend>
        <label className="dshrs-choice">
          <input
            type="checkbox"
            checked={role.readOnly}
            disabled={!canEdit}
            aria-describedby={readOnlyHelp}
            onChange={event => c.patchRole(uid, { readOnly: event.target.checked })}
          />
          <span>{t('ed.readOnlyLabel')}</span>
        </label>
        <p className="dshrs-hint" id={readOnlyHelp}>
          {t('ed.readOnlyHelp')}
        </p>
      </fieldset>

      <Preview role={role} />
    </section>
  )
}

interface PickerProps {
  uid: number
  role: RoleDefinition
  state: PageState
  error: string | undefined
}

function ModelFields({ uid, role, state, error }: PickerProps) {
  const c = useController()
  const t = useT()
  const { catalog } = state
  const fork = role.context === 'fork'
  const disabled = !state.canEdit || fork
  const provider = role.model?.provider ?? ''
  const model = role.model?.model ?? ''
  const effort = role.model?.reasoningEffort ?? ''
  const route = (next: Partial<RoleModel>) => c.setModel(uid, { provider, model, reasoningEffort: effort, ...next })

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
      <legend>{t('ed.model')}</legend>
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
                  c.setModel(uid, next === '' ? undefined : { provider: next, model: first })
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
                  onChange={event => c.setModel(uid, { provider, model: event.target.value })}
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
        {listed && (provider === '' || model === '' || (efforts.length === 0 && effort === '')) ? null : (
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
      <p className="dshrs-hint">
        {hint}
        {catalog.partial && listed && !fork ? ` ${t('ed.catalogPartial')}` : ''}
      </p>
      {!fork && catalog.status === 'error' ? (
        <div>
          <Button onClick={() => c.loadReference()}>{t('ed.retry')}</Button>
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
