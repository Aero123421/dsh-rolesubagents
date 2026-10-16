/** The role settings page that fills the `plugins.bundle.config` slot of this bundle. */

import { type ReactNode, useId, useState } from 'react'
import { MAX_ROLES } from '../shared/roles.ts'
import { ControllerProvider, useController, usePageState, useT } from './context.tsx'
import type { Controller, PageState } from './controller.ts'
import { type DraftRow, routeLabel, templates } from './draft.ts'
import { languageOf, issueText } from './i18n.ts'
import { RoleEditor, WorkflowModelFields } from './RoleEditor.tsx'
import { Badge, Button, Switch } from './ui.tsx'

export interface RolesPageProps {
  controller: Controller
  /** The Plugins page asks a bundle's configuration for `page` only. */
  view?: 'summary' | 'page'
}

const TEMPLATES = templates()

export function RolesPage(props: RolesPageProps) {
  if (props.view === 'summary') return null
  return (
    <ControllerProvider controller={props.controller}>
      <Page />
    </ControllerProvider>
  )
}

function Frame({ locale, children }: { locale: string; children: ReactNode }) {
  return (
    <div className="dshrs-root" lang={languageOf(locale)}>
      {children}
    </div>
  )
}

function Page() {
  const state = usePageState()
  const t = useT()
  const { draft } = state
  if (state.status !== 'ready' || draft === undefined) {
    return (
      <Frame locale={state.locale}>
        <p className="dshrs-notice" role="status">
          {t(state.status === 'unavailable' ? 'state.unavailable' : 'state.loading')}
        </p>
      </Frame>
    )
  }
  return (
    <Frame locale={state.locale}>
      {state.writable ? null : <p className="dshrs-notice">{t('state.readOnly')}</p>}
      {state.repaired.length === 0 ? null : (
        <div className="dshrs-notice dshrs-notice--warn">
          <p>{t('state.repaired', { count: state.repaired.length })}</p>
          <ul>
            {state.repaired.map(problem => (
              <li key={`${problem.code}:${problem.index ?? ''}:${problem.id ?? ''}`}>{problem.message}</li>
            ))}
          </ul>
        </div>
      )}
      <MasterSwitch state={state} />
      <section className="dshrs-section">
        <WorkflowModelFields state={state} />
      </section>
      <RoleList state={state} rows={draft.rows} />
      {state.writable ? <Footer state={state} /> : null}
    </Frame>
  )
}

function MasterSwitch({ state }: { state: PageState }) {
  const c = useController()
  const t = useT()
  const hint = useId()
  return (
    <section className="dshrs-section">
      <div className="dshrs-master">
        <Switch
          checked={state.draft?.enabled ?? false}
          label={t('master.label')}
          describedBy={hint}
          disabled={!state.canEdit}
          onChange={enabled => c.setEnabled(enabled)}
        />
        <div className="dshrs-master-text">
          <h3 className="dshrs-heading">{t('master.label')}</h3>
          <p className="dshrs-hint" id={hint}>
            {t('master.hint')}
          </p>
        </div>
      </div>
    </section>
  )
}

function RoleList({ state, rows }: { state: PageState; rows: readonly DraftRow[] }) {
  const c = useController()
  const t = useT()
  const templateId = useId()
  const [template, setTemplate] = useState(TEMPLATES[0]?.id ?? '')
  return (
    <section className="dshrs-section">
      <div className="dshrs-bar">
        <h3 className="dshrs-heading">{t('roles.heading')}</h3>
        <span className="dshrs-hint">{t('roles.count', { count: rows.length, max: MAX_ROLES })}</span>
      </div>
      <p className="dshrs-hint">{t('roles.hint')}</p>
      <div className="dshrs-bar">
        <div className="dshrs-bar-actions">
          <Button disabled={!state.canAdd} onClick={() => c.addRole()}>
            {t('roles.new')}
          </Button>
        </div>
        <div className="dshrs-bar-actions">
          <label className="dshrs-hint" htmlFor={templateId}>
            {t('roles.template')}
          </label>
          <select
            id={templateId}
            className="dshrs-select"
            style={{ width: 'auto' }}
            value={template}
            disabled={!state.canAdd}
            onChange={event => setTemplate(event.target.value)}
          >
            {TEMPLATES.map(option => (
              <option key={option.id} value={option.id}>
                {option.id}
              </option>
            ))}
          </select>
          <Button disabled={!state.canAdd} onClick={() => c.addTemplate(template)}>
            {t('roles.addTemplate')}
          </Button>
        </div>
      </div>
      {state.canEdit && !state.canAdd ? <p className="dshrs-hint">{t('roles.full', { max: MAX_ROLES })}</p> : null}
      <ul className="dshrs-list">
        {rows.map((row, index) => (
          <RoleRow key={row.uid} row={row} index={index} count={rows.length} state={state} />
        ))}
      </ul>
    </section>
  )
}

function RoleRow(props: { row: DraftRow; index: number; count: number; state: PageState }) {
  const c = useController()
  const t = useT()
  const { row, state } = props
  const { role, uid } = row
  const open = state.expanded === uid
  const fork = role.context === 'fork'
  const route = routeLabel(role.model)
  const preset = state.presets.options.find(option => option.id === role.agentPreset)?.name ?? role.agentPreset
  const broken = state.issues.some(issue => issue.uid === uid)
  const classes = ['dshrs-row', role.enabled ? '' : 'dshrs-off', open ? 'dshrs-open' : ''].filter(Boolean).join(' ')
  return (
    <li className={classes}>
      <Switch
        checked={role.enabled}
        label={t('row.enable', { id: role.id })}
        disabled={!state.canEdit}
        onChange={enabled => c.patchRole(uid, { enabled })}
      />
      <div className="dshrs-row-main">
        <div className="dshrs-row-title">
          <span className="dshrs-row-id">{role.id === '' ? '…' : role.id}</span>
          {role.builtin === undefined ? null : <Badge tone="quiet">{t('row.builtin')}</Badge>}
          <Badge tone={fork ? 'fork' : undefined} title={t(fork ? 'row.forkTitle' : 'row.freshTitle')}>
            {t(fork ? 'row.fork' : 'row.fresh')}
          </Badge>
          {fork && role.forkScope === 'task' ? <Badge>{t('row.taskOnly')}</Badge> : null}
          {role.readOnly ? <Badge tone="ro">{t('row.readOnly')}</Badge> : null}
          {preset === undefined ? null : <Badge>{t('row.preset', { preset })}</Badge>}
          {broken ? <Badge tone="err">{t('row.needsFix')}</Badge> : null}
        </div>
        <p className="dshrs-row-model">{t('row.model', { model: route ?? t('row.modelParent') })}</p>
      </div>
      <div className="dshrs-row-actions">
        <Button
          aria-expanded={open}
          aria-label={t(open ? 'row.closeLabel' : 'row.editLabel', { id: role.id })}
          onClick={() => c.toggleEditor(uid)}
        >
          {t(open ? 'row.close' : 'row.edit')}
        </Button>
        <Button
          variant="ghost"
          aria-label={t('row.duplicateLabel', { id: role.id })}
          disabled={!state.canAdd}
          onClick={() => c.duplicateRole(uid)}
        >
          {t('row.duplicate')}
        </Button>
        {role.builtin === undefined ? (
          <Button
            variant="danger"
            aria-label={t('row.deleteLabel', { id: role.id })}
            disabled={!state.canEdit}
            onClick={() => c.removeRole(uid)}
          >
            {t('row.delete')}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          aria-label={t('row.upLabel', { id: role.id })}
          disabled={!state.canEdit || props.index === 0}
          onClick={() => c.moveRole(uid, -1)}
        >
          {t('row.up')}
        </Button>
        <Button
          variant="ghost"
          aria-label={t('row.downLabel', { id: role.id })}
          disabled={!state.canEdit || props.index === props.count - 1}
          onClick={() => c.moveRole(uid, 1)}
        >
          {t('row.down')}
        </Button>
      </div>
      {open ? (
        <div className="dshrs-row-editor">
          <RoleEditor row={row} state={state} />
        </div>
      ) : null}
    </li>
  )
}

function Footer({ state }: { state: PageState }) {
  const c = useController()
  const t = useT()
  const issuesId = useId()
  const saving = state.save === 'saving'
  const message =
    state.save === 'saving'
      ? { text: t('foot.saving'), tone: '' }
      : state.conflict
        ? { text: t('foot.conflict'), tone: ' dshrs-bad' }
        : state.save === 'failed'
          ? { text: t('foot.failed'), tone: ' dshrs-bad' }
          : state.save === 'saved'
            ? { text: t('foot.saved'), tone: ' dshrs-ok' }
            : { text: t(state.dirty ? 'foot.unsaved' : 'foot.clean'), tone: '' }
  return (
    <div className="dshrs-footer">
      {state.issues.length === 0 ? null : (
        <div className="dshrs-notice dshrs-notice--error" id={issuesId}>
          <p>{t('foot.fix')}</p>
          <ul>
            {state.issues.map(issue => (
              <li key={`${issue.code}:${issue.uid ?? ''}:${issue.roleId ?? ''}`}>{issueText(issue, t)}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="dshrs-footer-bar">
        <p className={`dshrs-status${message.tone}`} role="status" aria-live="polite">
          {message.text}
        </p>
        <div className="dshrs-footer-actions">
          {state.conflict ? <Button onClick={() => c.discard()}>{t('foot.reload')}</Button> : null}
          <Button disabled={saving || !(state.dirty || state.conflict)} onClick={() => c.discard()}>
            {t('foot.discard')}
          </Button>
          <Button
            variant="primary"
            busy={saving}
            disabled={!state.canSave}
            aria-describedby={state.issues.length > 0 ? issuesId : undefined}
            onClick={() => {
              void c.save()
            }}
          >
            {t(saving ? 'foot.saving' : 'foot.save')}
          </Button>
        </div>
      </div>
    </div>
  )
}
