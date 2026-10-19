import { describe, expect, it } from 'vitest'
import type { Issue } from '../src/client/draft.ts'
import {
  accessName,
  DICTIONARIES,
  issueText,
  languageOf,
  presetName,
  readOnlyHelp,
  translator,
} from '../src/client/i18n.ts'
import { CLI_DESCRIPTORS, CLI_IDS } from '../src/shared/cli/index.ts'
import type { SettingsProblem } from '../src/shared/roles.ts'

const CODES: SettingsProblem['code'][] = [
  'not-an-object',
  'invalid-id',
  'duplicate-id',
  'too-many-roles',
  'description-too-long',
  'instructions-too-long',
  'invalid-model',
  'invalid-workflow-model',
  'fork-model-ignored',
  'fork-preset-ignored',
  'invalid-fork-scope',
  'spawn-fork-scope-ignored',
  'invalid-preset',
  'builtin-context-fixed',
  'builtin-missing',
  'builtin-duplicate',
  'builtin-runner-ignored',
  'runner-context-forced',
  'runner-model-ignored',
  'runner-preset-ignored',
  'invalid-runner',
  'invalid-runner-model',
  'invalid-runner-effort',
  'invalid-runner-permission',
  'runner-readonly-permission',
  'invalid-runner-timeout',
  'invalid-cli-settings',
]

const RUNNER_CODES = CODES.filter(code => code.includes('runner'))

describe('translator', () => {
  it('picks Japanese for ja locales and English for everything else', () => {
    expect(languageOf('ja')).toBe('ja')
    expect(languageOf('ja-JP')).toBe('ja')
    expect(languageOf('JA')).toBe('ja')
    expect(languageOf('en')).toBe('en')
    expect(languageOf('zh')).toBe('en')
    expect(languageOf('')).toBe('en')
    expect(translator('ja')('foot.save')).toBe('保存')
    expect(translator('en')('foot.save')).toBe('Save')
    expect(translator('fr')('foot.save')).toBe('Save')
  })

  it('fills placeholders and leaves unknown ones visible', () => {
    expect(translator('en')('roles.count', { count: 3, max: 32 })).toBe('3 of 32 roles')
    expect(translator('ja')('row.enable', { id: 'worker' })).toBe('ロール worker を有効にする')
    expect(translator('en')('row.enable')).toBe('Enable role {id}')
  })

  it('states the save outcome in both languages', () => {
    expect(translator('en')('foot.saved')).toBe(
      'Saved. Changes apply to new sessions; running sessions keep their roles and workflow default model.',
    )
    expect(translator('ja')('foot.saved')).toContain('新しいセッション')
  })
})

describe('issueText', () => {
  it.each(['en', 'ja'])('words every problem code in %s with nothing left unfilled', locale => {
    const t = translator(locale)
    for (const code of CODES) {
      const issue: Issue = { code, uid: 1, roleId: 'worker' }
      const text = issueText(issue, t)
      expect(text.length).toBeGreaterThan(0)
      expect(text).not.toMatch(/\{\w+\}/)
    }
  })

  it.each(['en', 'ja'])('gives every external-CLI problem its own text in %s', locale => {
    const t = translator(locale)
    const dshModel = issueText({ code: 'invalid-model', roleId: 'worker' }, t)
    const texts = new Set<string>()
    for (const code of RUNNER_CODES) {
      const text = issueText({ code, uid: 1, roleId: 'worker', cli: 'codex' }, t)
      expect(text).not.toBe(dshModel)
      expect(text).not.toMatch(/\{\w+\}/)
      texts.add(text)
    }
    expect(texts.size).toBe(RUNNER_CODES.length)
    const cliTexts = [undefined, 'executable', 'env'].map(field =>
      issueText({ code: 'invalid-cli-settings', cli: 'agy', ...(field === undefined ? {} : { field }) } as Issue, t),
    )
    expect(new Set(cliTexts).size).toBe(3)
    for (const text of cliTexts) expect(text).not.toMatch(/\{\w+\}/)
  })

  it('names the CLI and the limits of external-CLI problems', () => {
    const t = translator('en')
    expect(issueText({ code: 'invalid-runner-model', roleId: 'w', cli: 'opencode' }, t)).toBe(
      'Role "w" on OpenCode needs both a provider and a model.',
    )
    expect(issueText({ code: 'invalid-runner-model', roleId: 'w', cli: 'codex' }, t)).toContain('1–128 characters')
    expect(issueText({ code: 'invalid-runner-timeout', roleId: 'w', cli: 'codex' }, t)).toContain('1 to 1440')
    expect(issueText({ code: 'runner-context-forced', roleId: 'w', cli: 'claude-code' }, t)).toContain('Claude Code')
    expect(issueText({ code: 'invalid-cli-settings', field: 'executable', cli: 'agy' }, t)).toContain('Antigravity')
    expect(issueText({ code: 'invalid-cli-settings', field: 'env', cli: 'codex' }, t)).toContain('at most 32 names')
    expect(issueText({ code: 'invalid-runner-model', roleId: 'w', cli: 'opencode' }, translator('ja'))).toBe(
      'OpenCode で動く「w」には、プロバイダーとモデルの両方が必要です。',
    )
  })

  it('names the role and the limit, and treats an empty id on its own', () => {
    const t = translator('en')
    expect(issueText({ code: 'description-too-long', roleId: 'worker' }, t)).toBe(
      'The description of "worker" is over 1000 characters.',
    )
    expect(issueText({ code: 'instructions-too-long', roleId: 'worker' }, t)).toContain('8000')
    expect(issueText({ code: 'too-many-roles' }, t)).toContain('32')
    expect(issueText({ code: 'invalid-id', roleId: 'Bad Id' }, t)).toContain('"Bad Id"')
    expect(issueText({ code: 'invalid-id', roleId: '' }, t)).toContain('has no ID')
  })
})

describe('dictionaries', () => {
  it('has a Japanese text for every key, and no key without an English one', () => {
    const en = Object.keys(DICTIONARIES.en).sort()
    expect(Object.keys(DICTIONARIES.ja).sort()).toEqual(en)
    for (const key of en) expect((DICTIONARIES.ja as Record<string, string>)[key]?.length).toBeGreaterThan(0)
  })

  it('names every permission preset, access level and read-only mapping of every CLI', () => {
    for (const locale of ['en', 'ja']) {
      const t = translator(locale)
      for (const id of CLI_IDS) {
        expect(readOnlyHelp(t, id).length).toBeGreaterThan(20)
        for (const preset of CLI_DESCRIPTORS[id].permissions) {
          expect(presetName(t, preset.id)).not.toBe(preset.id)
          expect(accessName(t, preset.access).length).toBeGreaterThan(0)
        }
      }
    }
    const en = translator('en')
    const ja = translator('ja')
    expect(presetName(en, 'workspace-write')).toBe('Workspace write')
    expect(presetName(ja, 'workspace-write')).toBe('ワークスペースへの書き込み')
    expect(presetName(en, 'acceptEdits')).toBe('Accept edits')
    expect(presetName(ja, 'acceptEdits')).toBe('編集を自動承認')
    expect(presetName(ja, 'auto')).toBe('自動判定')
    expect(presetName(ja, 'bypassPermissions')).toBe('権限確認をすべて省略')
    expect(presetName(en, 'edit-files')).toBe('Edit files (no shell)')
    expect(presetName(ja, 'edit-files')).toBe('ファイル編集のみ（シェルなし）')
    expect(presetName(ja, 'full-access')).toBe('フルアクセス')
    expect(presetName(en, 'danger-full-access')).toBe('Full access (no sandbox)')
    expect(presetName(ja, 'danger-full-access')).toBe('フルアクセス（サンドボックスなし）')
    expect(presetName(en, 'custom-mode')).toBe('custom-mode')
    expect(readOnlyHelp(en, 'claude-code')).toContain('dontAsk')
  })
})
