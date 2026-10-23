import {
  CLI_COMPATIBILITY_EVIDENCE,
  COMPATIBILITY_SCOPE_FIELDS,
  HISTORICAL_CLI_BASELINES,
  resolveCliCompatibility,
  type CompatibilityEvidence,
  type CompatibilityScope,
} from '../shared/cli-compatibility.ts'

export interface CliCompatibilityProps {
  scope?: Partial<CompatibilityScope>
  evidence?: readonly CompatibilityEvidence[]
  locale?: string
}

/** Informational only. Never changes a permission, starts a test, or fetches a release. */
export function CliCompatibility({ scope, evidence, locale = 'en' }: CliCompatibilityProps) {
  const ja = locale.startsWith('ja')
  const assessment = resolveCliCompatibility(scope, evidence)
  const states = ja
    ? {
        tested: 'この条件で検証済み',
        untested: 'この条件は未検証',
        unknown: '検証条件が不明',
        'known-incompatible': 'この条件で既知の非互換',
      }
    : {
        tested: 'Tested for this exact scope',
        untested: 'Untested for this scope',
        unknown: 'Verification scope unknown',
        'known-incompatible': 'Known incompatibility in this scope',
      }
  const labels = ja
    ? {
        cli: 'CLI',
        cliVersion: '検出バージョン',
        dshVersion: 'DSHバージョン',
        platform: 'OS',
        arch: 'アーキテクチャ',
        preset: '権限プリセット',
        protocol: 'プロトコル',
      }
    : {
        cli: 'CLI',
        cliVersion: 'Detected version',
        dshVersion: 'DSH version',
        platform: 'OS',
        arch: 'Architecture',
        preset: 'Permission preset',
        protocol: 'Protocol',
      }
  const historical = HISTORICAL_CLI_BASELINES.find(item => item.cli === scope?.cli)
  const records =
    assessment.reason === 'missing-scope' || assessment.reason === 'no-exact-evidence'
      ? (evidence ?? CLI_COMPATIBILITY_EVIDENCE).filter(
          item => item.scope.cli === scope?.cli && item.scope.cliVersion === scope?.cliVersion,
        )
      : []
  return (
    <section className="dshrs-cli-compatibility" aria-label={ja ? 'CLI互換性' : 'CLI compatibility'}>
      <p role="status" data-compatibility-state={assessment.state}>
        <strong>{states[assessment.state]}</strong>
      </p>
      <p>
        {ja
          ? 'バージョンの検出だけでは動作・権限境界を検証したことにはなりません。検証結果は表示した条件と実施したチェックに限られます。'
          : 'Version detection alone does not verify operation or permission boundaries. Results apply only to the displayed scope and executed checks.'}
      </p>
      <dl>
        {COMPATIBILITY_SCOPE_FIELDS.map(field => (
          <div key={field}>
            <dt>{labels[field]}</dt>
            <dd>{scope?.[field] || (ja ? '不明' : 'Unknown')}</dd>
          </div>
        ))}
      </dl>
      {historical && (
        <p>
          {ja
            ? `過去の文書上の検証版: ${historical.cliVersion}。検証日・完全な実行条件は未記録のため、今回の条件の検証済み判定には使いません。`
            : `Historically documented version: ${historical.cliVersion}. The test date and full scope are not recorded; this does not establish verification for the current scope.`}
        </p>
      )}
      {records.length > 0 && (
        <div>
          <h5>{ja ? '同じCLIバージョンの実施記録' : 'Recorded runs for this CLI version'}</h5>
          <p>
            {ja
              ? '以下は記録した環境の結果です。現在のホスト・権限設定との一致を示すものではありません。'
              : 'These results describe the recorded environment, not a verified match to this host or its permission settings.'}
          </p>
          {records.map(record => (
            <details key={record.id}>
              <summary>
                {record.recordedAt} — {states[resolveCliCompatibility(record.scope, [record]).state]}
              </summary>
              <p>{record.id}</p>
              <dl>
                {COMPATIBILITY_SCOPE_FIELDS.map(field => (
                  <div key={field}>
                    <dt>{labels[field]}</dt>
                    <dd>{record.scope[field]}</dd>
                  </div>
                ))}
              </dl>
              <ul>
                {record.suites.map(suite => (
                  <li key={suite.id}>
                    {suite.id}: {suite.status} ({suite.cases.length})
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
      {assessment.evidenceIds.length > 0 && (
        <p>
          {ja ? '根拠ID: ' : 'Evidence IDs: '}
          {assessment.evidenceIds.join(', ')}
        </p>
      )}
    </section>
  )
}
