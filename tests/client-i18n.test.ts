import { describe, expect, it } from 'vitest'
import type { Issue } from '../src/client/draft.ts'
import { issueText, languageOf, translator } from '../src/client/i18n.ts'
import type { SettingsProblem } from '../src/shared/roles.ts'

const CODES: SettingsProblem['code'][] = [
  'not-an-object',
  'invalid-id',
  'duplicate-id',
  'too-many-roles',
  'description-too-long',
  'instructions-too-long',
  'invalid-model',
  'fork-model-ignored',
  'fork-preset-ignored',
  'invalid-fork-scope',
  'spawn-fork-scope-ignored',
  'invalid-preset',
  'builtin-context-fixed',
  'builtin-missing',
  'builtin-duplicate',
]

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
      'Saved. Changes apply to new sessions; running sessions keep their roles.',
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
