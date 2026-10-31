/** The "External CLIs" section: per-CLI executable, forwarded variable names, and the connection test. */

import { useEffect, useRef } from 'react'
import { CLI_IDS, type CliId, cliDescriptor } from '../shared/cli/index.ts'
import { CliCompatibility } from './CliCompatibility.tsx'
import { useController, useT } from './context.tsx'
import { sameCliSettings, supportsCliModelRefresh, type PageState, type ProbeState } from './controller.ts'
import { type IssueField, parseEnvNames } from './draft.ts'
import { issueText } from './i18n.ts'
import { shouldRevealProbe } from './scroll-clearance.ts'
import { Button, Field, TextInput } from './ui.tsx'

export function CliSection({ state }: { state: PageState }) {
  const t = useT()
  return (
    <section className="dshrs-section">
      <h3 className="dshrs-heading">{t('clis.heading')}</h3>
      <p className="dshrs-hint">{t('clis.hint')}</p>
      {state.probes.available ? null : <p className="dshrs-hint">{t('clis.unavailable')}</p>}
      <div className="dshrs-cli-grid">
        {CLI_IDS.map(cli => (
          <CliCard key={cli} cli={cli} state={state} />
        ))}
      </div>
    </section>
  )
}

/** Typed names → the text of the list they parse to. */
const namesText = (text: string): string => parseEnvNames(text).join(', ')

function CliCard({ cli, state }: { cli: CliId; state: PageState }) {
  const c = useController()
  const t = useT()
  const descriptor = cliDescriptor(cli)
  const name = descriptor.displayName
  const settings = state.draft?.clis?.[cli]
  const changed = !sameCliSettings(settings, state.draft?.base.clis?.[cli])
  const used = state.draft?.rows.filter(row => row.role.runner?.cli === cli).length ?? 0
  const probe = state.probes.clis[cli]
  const loading = probe.status === 'loading'
  const errorOf = (field: IssueField): string | undefined => {
    const issue = state.issues.find(candidate => candidate.cli === cli && candidate.field === field)
    return issue === undefined ? undefined : issueText(issue, t)
  }
  const input = { className: 'dshrs-input dshrs-mono', spellCheck: false, autoComplete: 'off' } as const
  return (
    <section className="dshrs-card" aria-label={name}>
      <div className="dshrs-card-head">
        <h4 className="dshrs-card-title">{name}</h4>
        {used > 0 ? <span className="dshrs-hint">{t('clis.used', { count: used })}</span> : null}
      </div>
      <Field
        label={t('clis.executable')}
        help={t('clis.executableHelp', { default: descriptor.executable })}
        error={errorOf('executable')}
      >
        {a11y => (
          <input
            {...a11y}
            {...input}
            value={settings?.executable ?? ''}
            placeholder={descriptor.executable}
            disabled={!state.canEdit}
            onChange={event => c.setCliSettings(cli, { executable: event.target.value })}
          />
        )}
      </Field>
      <Field label={t('clis.env')} help={t('clis.envHelp', { cli: name })} error={errorOf('env')}>
        {a11y => (
          <TextInput
            {...a11y}
            {...input}
            value={(settings?.envPassthrough ?? []).join(', ')}
            canonical={namesText}
            placeholder={t('clis.envPlaceholder')}
            disabled={!state.canEdit}
            onText={text => c.setCliSettings(cli, { envPassthrough: parseEnvNames(text) })}
          />
        )}
      </Field>
      <CliModelRefresh cli={cli} state={state} action={false} />
      {state.probes.available ? (
        <>
          <div className="dshrs-probe-bar">
            <Button
              aria-label={t('clis.testLabel', { cli: name })}
              busy={loading}
              disabled={loading}
              onClick={() => c.probeCli(cli)}
            >
              {t(loading ? 'clis.testing' : 'clis.test')}
            </Button>
            {changed ? <span className="dshrs-hint">{t('clis.testSaved')}</span> : null}
          </div>
          <ProbeOutcome probe={probe} cli={name} />
          {probe.status === 'ready' && probe.result?.found ? (
            <details className="dshrs-hint">
              <summary>
                {state.locale.startsWith('ja') ? '互換性の検証記録' : 'Compatibility verification records'}
              </summary>
              <CliCompatibility scope={{ cli, cliVersion: probe.result.version }} locale={state.locale} />
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

function ProbeOutcome({ probe, cli }: { probe: ProbeState; cli: string }) {
  const t = useT()
  const lines: { text: string; tone: '' | ' dshrs-ok' | ' dshrs-bad' }[] = []
  const result = probe.status === 'loading' ? undefined : probe.result
  if (probe.status === 'error')
    lines.push({ text: t(probe.issue === undefined ? 'probe.error' : `probe.${probe.issue}`), tone: ' dshrs-bad' })
  else if (result?.message === 'subprocess-unavailable')
    lines.push({ text: t('probe.noSubprocess'), tone: ' dshrs-bad' })
  else if (result !== undefined && !result.found) lines.push({ text: t('probe.notFound', { cli }), tone: ' dshrs-bad' })
  else if (result !== undefined) {
    const facts = [
      t('probe.found', { path: result.path ?? cli }),
      ...(result.version === undefined ? [] : [t('probe.version', { version: result.version })]),
      ...(result.auth === 'ok' ? [t('probe.authOk')] : result.auth === 'unknown' ? [t('probe.authUnknown')] : []),
      ...(result.models === undefined || result.models.length === 0
        ? []
        : [t('probe.models', { count: result.models.length })]),
    ]
    lines.push({ text: facts.join(' · '), tone: ' dshrs-ok' })
    if (result.auth === 'missing') lines.push({ text: t('probe.authMissing', { cli }), tone: ' dshrs-bad' })
    if (result.message === 'probe-failed') lines.push({ text: t('probe.checksFailed'), tone: '' })
  }
  const resultRef = useRef<HTMLDivElement>(null)
  const statusRef = useRef(probe.status)
  const signature = lines.map(line => line.text).join('\n')
  useEffect(() => {
    const previous = statusRef.current
    statusRef.current = probe.status
    if (!shouldRevealProbe(previous, probe.status) || signature === '') return
    resultRef.current?.scrollIntoView({ block: 'nearest' })
  }, [probe.status, signature])
  return (
    <div className="dshrs-probe-result" aria-live="polite" ref={resultRef}>
      {lines.map(line => (
        <p key={line.text} className={`dshrs-probe${line.tone}`}>
          {line.text}
        </p>
      ))}
    </div>
  )
}

/** Model-list provenance is separate from executable/auth diagnostics. */
export function CliModelRefresh({ cli, state, action = true }: { cli: CliId; state: PageState; action?: boolean }) {
  const c = useController()
  const t = useT()
  const probe = state.probes.clis[cli]
  const supported = supportsCliModelRefresh(cli)
  const changed = !sameCliSettings(state.draft?.clis?.[cli], state.draft?.base.clis?.[cli])
  const listed = (probe.models?.length ?? 0) > 0
  const latestListed =
    probe.status === 'ready' &&
    probe.result?.found &&
    probe.result.auth !== 'missing' &&
    (probe.result.models?.length ?? 0) > 0
  return (
    <div className="dshrs-hint">
      {action && supported ? (
        <div className="dshrs-probe-bar">
          <Button
            disabled={!state.probes.available || probe.status === 'loading' || state.status !== 'ready'}
            busy={probe.status === 'loading'}
            onClick={() => c.refreshCliModels(cli)}
          >
            {t(probe.status === 'loading' ? 'models.refreshing' : 'models.refresh')}
          </Button>
        </div>
      ) : null}
      <div aria-live="polite">
        <p>
          {t(
            cli === 'claude-code'
              ? 'models.aliases'
              : !supported
                ? 'models.unsupported'
                : listed
                  ? 'models.live'
                  : 'models.static',
          )}
        </p>
        {supported ? <p>{t('models.explicit')}</p> : null}
        {action && supported && changed ? <p>{t('clis.testSaved')}</p> : null}
        {action && supported && !state.probes.available ? <p>{t('clis.unavailable')}</p> : null}
        {probe.checkedAt === undefined ? (
          supported ? (
            <p>{t('models.unchecked')}</p>
          ) : null
        ) : (
          <p>{t('models.checked', { time: new Date(probe.checkedAt).toISOString() })}</p>
        )}
        {listed && probe.modelsCheckedAt !== undefined ? (
          <p>{t('models.good', { time: new Date(probe.modelsCheckedAt).toISOString() })}</p>
        ) : null}
        {supported && probe.status === 'loading' ? <p>{t('models.refreshing')}</p> : null}
        {action && supported && probe.status === 'error' ? (
          <p>{t(probe.issue === undefined ? 'probe.error' : `probe.${probe.issue}`)}</p>
        ) : null}
        {supported && probe.status === 'ready' && !latestListed ? (
          <p>
            {t(
              probe.result?.message === 'models-timeout'
                ? 'models.timeout'
                : probe.result?.message === 'models-unavailable'
                  ? 'models.unavailable'
                  : 'models.empty',
            )}
          </p>
        ) : null}
        {listed && !latestListed ? <p>{t('models.retained')}</p> : null}
      </div>
    </div>
  )
}
