import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ExternalRunDisplay } from '../shared/role-display.ts'
import { cliDescriptor } from '../shared/cli/index.ts'
import type { ExternalRunsState } from './external-runs.ts'

export function runStatusLabel(status: ExternalRunDisplay['status'] | undefined, ja: boolean): string {
  switch (status) {
    case 'running':
      return ja ? '実行中' : 'Running'
    case 'succeeded':
      return ja ? '完了' : 'Completed'
    case 'failed':
      return ja ? '失敗' : 'Failed'
    case 'cancelled':
      return ja ? 'キャンセル' : 'Cancelled'
    case 'timeout':
      return ja ? '時間切れ' : 'Timed out'
    default:
      return ja ? '状態不明' : 'Status unknown'
  }
}

/** Non-modal result inspector: the parent chat stays usable, including keyboard focus. */
export function ExternalRunDialog({
  id,
  label,
  state,
  locale,
  parentSessionId,
  onOpenParent,
  onClose,
}: {
  id: string
  label: string
  state: ExternalRunsState
  locale: string
  parentSessionId?: string
  onOpenParent?: () => void
  onClose(): void
}) {
  const ja = locale.startsWith('ja')
  const text = (en: string, jp: string) => (ja ? jp : en)
  const titleId = useId()
  const close = useRef<HTMLButtonElement>(null)
  const result = useRef<HTMLPreElement>(null)
  const [raw, setRaw] = useState(false)
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle')
  const copyRequest = useRef(0)
  const parent = parentSessionId ?? state.byId[id]?.parentSessionId
  const scoped = parent ? state.byParent?.[parent] : undefined
  const run = scoped?.byId[id] ?? state.byId[id]
  // Callers predating the per-parent contract still get an explicit aggregate fallback.
  const unavailable = scoped ? scoped.error || scoped.stale : state.unavailable
  const loading = scoped ? scoped.loading && scoped.fetchedAt === null : state.loading && !run
  const durable = scoped?.durable ?? state.durable
  const formatTime = (value: string | number) => {
    const date = new Date(value)
    try {
      return date.toLocaleString(locale)
    } catch {
      return date.toLocaleString()
    }
  }
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    close.current?.focus()
    return () => {
      copyRequest.current++
      if (previous?.isConnected && (document.activeElement === document.body || !document.activeElement?.isConnected))
        previous.focus()
    }
  }, [])
  useEffect(() => {
    void id
    copyRequest.current++
    setCopy('idle')
    setRaw(false)
  }, [id])
  const copyResult = async () => {
    if (!run?.resultText) return
    const request = ++copyRequest.current
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard-unavailable')
      await navigator.clipboard.writeText(run.resultText)
      if (request === copyRequest.current) setCopy('copied')
    } catch {
      if (request !== copyRequest.current) return
      setCopy('failed')
      // A visible, keyboard-selectable fallback; never run execCommand or hide failure.
      if (result.current) {
        result.current.focus()
        const selection = window.getSelection()
        const range = document.createRange()
        range.selectNodeContents(result.current)
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
    }
  }
  return createPortal(
    <section
      className="dshrs-run-dialog"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <header className="dshrs-run-header">
        <div>
          <small>{text('External CLI · one-shot', '外部CLI · 単発実行')}</small>
          <h2 id={titleId}>{label}</h2>
        </div>
        <button
          type="button"
          ref={close}
          onClick={onClose}
          aria-label={text('Close result details', '結果の詳細を閉じる')}
        >
          {text('Close', '閉じる')}
        </button>
      </header>
      <div className="dshrs-run-content">
        <p className="dshrs-run-status" data-state={unavailable ? 'unknown' : run?.status} role="status">
          {loading ? text('Loading…', '読み込み中…') : runStatusLabel(run?.status, ja)}
          {unavailable && run ? text(' · Last known status', ' · 最後に取得した状態') : ''}
        </p>
        {unavailable && (
          <p className="dshrs-run-notice" role="alert">
            {text(
              'Run details could not be refreshed. Showing the last available information; retrying automatically.',
              '実行詳細を更新できません。最後に取得できた情報を表示しています。自動で再試行します。',
            )}
            {scoped?.fetchedAt != null && (
              <small>
                {text('Last successful update: ', '最終取得: ')}
                {formatTime(scoped.fetchedAt)}
              </small>
            )}
          </p>
        )}
        {!run && !loading && !unavailable && (
          <p className="dshrs-run-notice">
            {text(
              'No retained record for this run. It may predate this feature or have expired. Check its parent chat for the returned result.',
              'この実行の記録は残っていません。機能追加前の実行か保存期限・上限を超えた可能性があります。返却先の親チャットを確認してください。',
            )}
          </p>
        )}
        {run && (
          <>
            <p className="dshrs-run-identity">
              {run.roleId}
              <span> · {cliDescriptor(run.cli).displayName}</span>
            </p>
            {run.status === 'running' && !unavailable && (
              <p>
                {text(
                  'Running in the background. The final answer returns to its parent chat. Live CLI tool output is not available here.',
                  'バックグラウンドで実行中です。最終結果は親チャットへ返ります。CLIの途中出力はここには表示されません。',
                )}
              </p>
            )}
            {run.error && (
              <p className="dshrs-run-notice" role="alert">
                {run.error}
              </p>
            )}
            {run.resultText ? (
              <section className="dshrs-run-result">
                <div className="dshrs-run-result-actions">
                  <h3>{run.resultTruncated ? text('Result preview', '結果プレビュー') : text('Result', '結果')}</h3>
                  <button type="button" aria-pressed={raw} onClick={() => setRaw(value => !value)}>
                    {text('Raw text', '原文表示')}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void copyResult()
                    }}
                  >
                    {run.resultTruncated
                      ? text('Copy preview', 'プレビューをコピー')
                      : text('Copy result', '結果をコピー')}
                  </button>
                </div>
                <p className="dshrs-run-copy-state" role="status">
                  {copy === 'copied'
                    ? text('Copied', 'コピーしました')
                    : copy === 'failed'
                      ? text(
                          'Copy failed. Select the result and copy it manually.',
                          'コピーできませんでした。結果を選択して手動でコピーしてください。',
                        )
                      : ''}
                </p>
                {/* biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable plain-text results must be keyboard accessible. */}
                <pre ref={result} tabIndex={0} className={raw ? 'dshrs-run-raw' : 'dshrs-run-readable'}>
                  {run.resultText}
                </pre>
                {run.resultTruncated && (
                  <p className="dshrs-run-notice">
                    {text(
                      'Preview truncated. Copy includes only the visible preview. Check the parent chat for the returned result.',
                      'プレビューは省略されています。コピー対象も表示中の範囲のみです。返却された結果は親チャットを確認してください。',
                    )}
                  </p>
                )}
              </section>
            ) : (
              run.status === 'succeeded' && (
                <p>
                  {text(
                    'No result text was retained. Check the parent chat.',
                    '結果の本文は記録されていません。親チャットを確認してください。',
                  )}
                </p>
              )
            )}
            <details className="dshrs-run-metadata">
              <summary>{text('Execution details', '実行情報')}</summary>
              <dl>
                <dt>{text('Requested model', '指定モデル')}</dt>
                <dd>{run.model ?? text('CLI default', 'CLIの既定値')}</dd>
                <dt>{text('Actual model / effort', '実効モデル / 思考強度')}</dt>
                <dd>{text('Not reported by this record', 'この記録では確認できません')}</dd>
                <dt>{text('Started', '開始')}</dt>
                <dd>{formatTime(run.startedAt)}</dd>
                {run.endedAt && (
                  <>
                    <dt>{text('Ended', '終了')}</dt>
                    <dd>{formatTime(run.endedAt)}</dd>
                  </>
                )}
                <dt>{text('Run ID', '実行ID')}</dt>
                <dd>{run.id}</dd>
              </dl>
              <p>
                {text(
                  'Recent records: up to 100 across the Host, retained for 7 days; result previews may be shortened.',
                  '記録はHost全体で直近100件・7日間まで保持されます。結果は一部省略される場合があります。',
                )}
              </p>
              {!durable && (
                <p>
                  {text(
                    'This snapshot is not confirmed saved. A Host restart may lose it.',
                    'この記録の保存は確認できていません。Hostの再起動で失われる場合があります。',
                  )}
                </p>
              )}
            </details>
          </>
        )}
      </div>
      <footer className="dshrs-run-footer">
        <small>
          {text(
            'One-shot CLI runs cannot receive follow-up messages. Results are returned to their parent chat.',
            '単発CLIには追加指示を送れません。結果の返却先は親チャットです。',
          )}
        </small>
        {onOpenParent && (
          <button type="button" onClick={onOpenParent}>
            {text('Open parent chat', '親チャットを開く')}
          </button>
        )}
      </footer>
    </section>,
    document.body,
  )
}
