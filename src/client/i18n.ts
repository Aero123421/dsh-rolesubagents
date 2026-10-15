/**
 * UI chrome strings. `en` is the source of truth for the key set; `ja` is
 * checked against it by its type, so a missing or extra key is a compile error.
 * Role text (ids, descriptions, instructions) is whatever the user typed and is
 * never translated.
 */

import { MAX_DESCRIPTION_LENGTH, MAX_INSTRUCTIONS_LENGTH, MAX_ROLES, type SettingsProblem } from '../shared/roles.ts'
import { ID_MAX_LENGTH, type Issue } from './draft.ts'

const en = {
  'master.label': 'Subagents',
  'master.hint':
    'Turns role-based subagents on or off for new sessions. The depth limit and parallelism are set in the official Subagent settings.',

  'roles.heading': 'Roles',
  'roles.hint': 'The parent picks a role by its ID. This order is the order the parent sees.',
  'roles.count': '{count} of {max} roles',
  'roles.new': 'New role',
  'roles.template': 'Template',
  'roles.addTemplate': 'Add from template',
  'roles.full': 'The limit of {max} roles is reached.',

  'row.enable': 'Enable role {id}',
  'row.builtin': 'Built-in',
  'row.fresh': 'Fresh',
  'row.freshTitle': 'The child starts with an empty conversation',
  'row.fork': 'Fork',
  'row.forkTitle': "The child inherits the parent's completed turns",
  'row.taskOnly': 'Task only',
  'row.model': 'Model: {model}',
  'row.modelParent': "parent's model",
  'row.readOnly': 'Read-only',
  'row.preset': 'Preset: {preset}',
  'row.edit': 'Edit',
  'row.close': 'Close',
  'row.editLabel': 'Edit role {id}',
  'row.closeLabel': 'Close editor of role {id}',
  'row.duplicate': 'Duplicate',
  'row.duplicateLabel': 'Duplicate role {id}',
  'row.delete': 'Delete',
  'row.deleteLabel': 'Delete role {id}',
  'row.up': 'Up',
  'row.upLabel': 'Move role {id} up',
  'row.down': 'Down',
  'row.downLabel': 'Move role {id} down',
  'row.needsFix': 'Needs a fix',

  'ed.id': 'Role ID',
  'ed.idHelp':
    'The name the parent uses to pick this role: lowercase letters, digits, - and _, starting with a letter, up to {max} characters.',
  'ed.idFixed': 'The ID of a built-in role cannot be changed.',
  'ed.description': 'Description for the parent',
  'ed.descriptionHelp': 'Shown to the parent in the tool description: what the role is for and how to brief it.',
  'ed.instructions': 'Instructions for the child',
  'ed.instructionsHelp': 'Given only to the child, as runtime context. Leave empty to add nothing.',
  'ed.remaining': '{count} characters left',
  'ed.over': '{count} characters over the limit',
  'ed.context': 'Context',
  'ed.contextSpawn': 'Fresh (spawn): the child starts with an empty conversation',
  'ed.contextFork': "Fork: the child inherits the parent's completed turns",
  'ed.contextFixed': 'The context of a built-in role is fixed.',
  'ed.forkScope': 'Inherited context',
  'ed.forkScopeFull': 'All completed turns',
  'ed.forkScopeTask': 'Task only',
  'ed.forkScopeWarn':
    'Full inheritance copies the parent\'s completed turns, including tool results. A prompt injection in that history is copied into the child. Choose "Task only" to pass only the delegation prompt.',
  'ed.forkScopeTaskHelp':
    'The child starts fresh and does not see this conversation. Put everything it needs in the prompt.',
  'ed.model': 'Child model',
  'ed.provider': 'Provider',
  'ed.modelId': 'Model',
  'ed.effort': 'Reasoning effort',
  'ed.parentModel': "Parent's model",
  'ed.selectModel': 'Select a model',
  'ed.effortDefault': 'Model default',
  'ed.unlisted': '{value} (not listed)',
  'ed.modelForkNote': "Fork roles always use the parent's model, so the inherited conversation stays cached.",
  'ed.modelParentNote': "Leave the provider empty to use the parent's model.",
  'ed.catalogLoading': 'Loading models…',
  'ed.catalogFailed': 'The model list is unavailable. Type the IDs instead.',
  'ed.catalogPartial': 'Some providers could not be listed.',
  'ed.retry': 'Retry',
  'ed.preset': 'Agent preset',
  'ed.presetNone': 'None',
  'ed.presetHelp':
    "A preset replaces the child's system prompt and tools, and the child no longer shares the parent's cache.",
  'ed.presetFork': 'Fork roles cannot use an agent preset.',
  'ed.presetNoneAvailable': 'This Host has no agent presets.',
  'ed.readOnly': 'Read-only',
  'ed.readOnlyLabel': 'Block file writes for this role',
  'ed.readOnlyHelp':
    'Pins the file sandbox to read-only and blocks write-like MCP and plugin tools. Tools are classified by name; the README lists what still runs.',
  'ed.preview': 'Preview',
  'ed.previewParent': 'What the parent sees',
  'ed.previewChild': 'What the child gets',
  'ed.previewChildNone': "Nothing is added to the child's context.",

  'foot.clean': 'No changes',
  'foot.unsaved': 'Unsaved changes',
  'foot.save': 'Save',
  'foot.saving': 'Saving…',
  'foot.discard': 'Discard',
  'foot.saved': 'Saved. Changes apply to new sessions; running sessions keep their roles.',
  'foot.failed': 'Could not save. Check the connection and try again.',
  'foot.conflict': 'The settings changed on the Host after you started editing, so nothing was saved.',
  'foot.reload': 'Reload latest settings',
  'foot.fix': 'Fix these before saving:',

  'state.loading': 'Loading settings…',
  'state.unavailable':
    'Role settings are not available. The dsh-rolesubagents Host plugin may be switched off or still starting.',
  'state.readOnly': 'Settings are read-only on this Host.',
  'state.repaired':
    'The stored settings had {count} problem(s) and are shown repaired. Saving writes the repaired version.',

  'issue.invalidId':
    'Role ID "{id}" is not valid. Use lowercase letters, digits, - or _, starting with a letter (max {max}).',
  'issue.emptyId': 'A role has no ID. Use lowercase letters, digits, - or _, starting with a letter (max {max}).',
  'issue.duplicateId': 'Role ID "{id}" is used more than once.',
  'issue.tooMany': 'At most {max} roles can be kept.',
  'issue.description': 'The description of "{id}" is over {max} characters.',
  'issue.instructions': 'The instructions of "{id}" are over {max} characters.',
  'issue.model': 'The model of "{id}" needs both a provider and a model, or both empty.',
  'issue.forkModel': 'Fork role "{id}" always uses the parent\'s model.',
  'issue.preset': 'The agent preset of "{id}" is not a valid ID.',
  'issue.forkPreset': 'Fork role "{id}" cannot use an agent preset.',
  'issue.forkScope':
    'Fork role "{id}" must inherit either all completed turns or the task only. It is switched off and does not inherit history.',
  'issue.spawnForkScope': 'Role "{id}" is not a fork, so its inherited-context option is removed.',
  'issue.builtin': 'The built-in roles general and fork must stay in the list, once each, with their fixed context.',
} as const

/** Every UI string key. */
export type Key = keyof typeof en

const ja: Record<Key, string> = {
  'master.label': 'サブエージェント',
  'master.hint':
    '新しいセッションでロール別サブエージェントを使うかどうかを切り替えます。深さの上限と並列数は、公式のサブエージェント設定で変更します。',

  'roles.heading': 'ロール',
  'roles.hint': '親エージェントはIDでロールを選びます。ここでの並び順がそのまま親に表示されます。',
  'roles.count': '{count} / {max} ロール',
  'roles.new': '新しいロール',
  'roles.template': 'テンプレート',
  'roles.addTemplate': 'テンプレートから追加',
  'roles.full': 'ロール数の上限（{max}）に達しています。',

  'row.enable': 'ロール {id} を有効にする',
  'row.builtin': '組み込み',
  'row.fresh': '新規',
  'row.freshTitle': '子は空の会話から始まります',
  'row.fork': 'フォーク',
  'row.forkTitle': '子は親の完了済みのやり取りを引き継ぎます',
  'row.taskOnly': 'タスクのみ',
  'row.model': 'モデル: {model}',
  'row.modelParent': '親と同じモデル',
  'row.readOnly': '読み取り専用',
  'row.preset': 'プリセット: {preset}',
  'row.edit': '編集',
  'row.close': '閉じる',
  'row.editLabel': 'ロール {id} を編集',
  'row.closeLabel': 'ロール {id} の編集を閉じる',
  'row.duplicate': '複製',
  'row.duplicateLabel': 'ロール {id} を複製',
  'row.delete': '削除',
  'row.deleteLabel': 'ロール {id} を削除',
  'row.up': '上へ',
  'row.upLabel': 'ロール {id} を上へ移動',
  'row.down': '下へ',
  'row.downLabel': 'ロール {id} を下へ移動',
  'row.needsFix': '要修正',

  'ed.id': 'ロールID',
  'ed.idHelp': '親がこのロールを選ぶときの名前です。小文字・数字・ - ・ _ が使え、先頭は英小文字、最大{max}文字です。',
  'ed.idFixed': '組み込みロールのIDは変更できません。',
  'ed.description': '親向けの説明',
  'ed.descriptionHelp': '親エージェントのツール説明に表示されます。ロールの用途と、依頼のしかたを書いてください。',
  'ed.instructions': '子への指示',
  'ed.instructionsHelp': '子エージェントだけに実行時コンテキストとして渡されます。空欄なら何も追加しません。',
  'ed.remaining': '残り{count}文字',
  'ed.over': '上限を{count}文字超えています',
  'ed.context': 'コンテキスト',
  'ed.contextSpawn': '新規（spawn）: 子は空の会話から始まります',
  'ed.contextFork': 'フォーク（fork）: 子は親の完了済みのやり取りを引き継ぎます',
  'ed.contextFixed': '組み込みロールのコンテキストは固定です。',
  'ed.forkScope': '引き継ぐ文脈',
  'ed.forkScopeFull': '完了済みのやり取りすべて',
  'ed.forkScopeTask': 'タスクのみ',
  'ed.forkScopeWarn':
    'すべて引き継ぐと、親の完了済みのやり取り（ツール結果を含む）が子にコピーされます。その履歴に紛れたプロンプト注入も子に届きます。委譲プロンプトだけを渡すときは「タスクのみ」を選んでください。',
  'ed.forkScopeTaskHelp': '子は空の会話から始まり、この会話は見えません。必要な内容はプロンプトに書いてください。',
  'ed.model': '子のモデル',
  'ed.provider': 'プロバイダー',
  'ed.modelId': 'モデル',
  'ed.effort': '推論の強さ',
  'ed.parentModel': '親と同じモデル',
  'ed.selectModel': 'モデルを選択',
  'ed.effortDefault': 'モデルの既定',
  'ed.unlisted': '{value}（一覧にありません）',
  'ed.modelForkNote': 'フォークのロールは常に親のモデルを使います。引き継いだ会話のキャッシュを保つためです。',
  'ed.modelParentNote': 'プロバイダーを空にすると、親と同じモデルを使います。',
  'ed.catalogLoading': 'モデルを読み込み中…',
  'ed.catalogFailed': 'モデル一覧を利用できません。IDを直接入力してください。',
  'ed.catalogPartial': '一部のプロバイダーは一覧に表示できませんでした。',
  'ed.retry': '再試行',
  'ed.preset': 'エージェントプリセット',
  'ed.presetNone': '使用しない',
  'ed.presetHelp':
    'プリセットを使うと、子のシステムプロンプトとツールがプリセットのものに置き換わり、親とキャッシュを共有しなくなります。',
  'ed.presetFork': 'フォークのロールではエージェントプリセットを使えません。',
  'ed.presetNoneAvailable': 'このホストには利用できるエージェントプリセットがありません。',
  'ed.readOnly': '読み取り専用',
  'ed.readOnlyLabel': 'このロールではファイルへの書き込みを禁止する',
  'ed.readOnlyHelp':
    'ファイルサンドボックスを読み取り専用に固定し、書き込み系の MCP ツールと他プラグインのツールを止めます。判定はツール名によります。止まりきらない範囲は README に書いてあります。',
  'ed.preview': 'プレビュー',
  'ed.previewParent': '親に見える内容',
  'ed.previewChild': '子に渡される内容',
  'ed.previewChildNone': '子のコンテキストには何も追加されません。',

  'foot.clean': '変更はありません',
  'foot.unsaved': '未保存の変更があります',
  'foot.save': '保存',
  'foot.saving': '保存中…',
  'foot.discard': '破棄',
  'foot.saved': '保存しました。変更は新しいセッションに適用され、実行中のセッションは今のロールのままです。',
  'foot.failed': '保存できませんでした。接続を確認して、もう一度お試しください。',
  'foot.conflict': '編集を始めたあとにホスト側の設定が変更されたため、保存しませんでした。',
  'foot.reload': '最新の設定を読み込む',
  'foot.fix': '保存する前に次を修正してください:',

  'state.loading': '設定を読み込み中…',
  'state.unavailable':
    'ロール設定を利用できません。dsh-rolesubagents のホストプラグインが無効か、起動中の可能性があります。',
  'state.readOnly': 'このホストでは設定を変更できません（読み取り専用）。',
  'state.repaired':
    '保存済みの設定に{count}件の問題があったため、修復した状態で表示しています。保存すると修復後の内容が書き込まれます。',

  'issue.invalidId': 'ロールID「{id}」は使えません。小文字・数字・ - ・ _ が使え、先頭は英小文字、最大{max}文字です。',
  'issue.emptyId': 'IDのないロールがあります。小文字・数字・ - ・ _ が使え、先頭は英小文字、最大{max}文字です。',
  'issue.duplicateId': 'ロールID「{id}」が重複しています。',
  'issue.tooMany': 'ロールは最大{max}個までです。',
  'issue.description': '「{id}」の説明が{max}文字を超えています。',
  'issue.instructions': '「{id}」の指示が{max}文字を超えています。',
  'issue.model': '「{id}」のモデルは、プロバイダーとモデルの両方を指定するか、両方を空にしてください。',
  'issue.forkModel': 'フォークのロール「{id}」は常に親のモデルを使います。',
  'issue.preset': '「{id}」のエージェントプリセットIDが正しくありません。',
  'issue.forkPreset': 'フォークのロール「{id}」ではエージェントプリセットを使えません。',
  'issue.forkScope':
    'フォークのロール「{id}」が引き継げるのは、完了済みのやり取り全部か、タスクだけか、どちらかです。このロールはオフになり、履歴は引き継ぎません。',
  'issue.spawnForkScope': 'ロール「{id}」はフォークではないので、引き継ぐ文脈の指定は外します。',
  'issue.builtin': '組み込みロール general と fork は、固定のコンテキストで1つずつ残す必要があります。',
}

/** Translate a key, filling `{name}` placeholders from `params`. */
export type Translator = (key: Key, params?: Readonly<Record<string, string | number>>) => string

/** The dictionary language DSH's active locale maps to: Japanese for `ja*`, English otherwise. */
export function languageOf(locale: string): 'en' | 'ja' {
  return locale.toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

/**
 * Build a translator for a DSH locale id.
 * @param locale - DSH's active locale (`ja`, `en`, `zh`…).
 * @returns a translator that falls back to English for an unknown locale or key.
 */
export function translator(locale: string): Translator {
  const dictionary: Readonly<Record<string, string>> = languageOf(locale) === 'ja' ? ja : en
  return (key, params) =>
    (dictionary[key] ?? en[key]).replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match))
}

const ISSUE_KEYS: Record<SettingsProblem['code'], Key> = {
  'not-an-object': 'issue.builtin',
  'invalid-id': 'issue.invalidId',
  'duplicate-id': 'issue.duplicateId',
  'too-many-roles': 'issue.tooMany',
  'description-too-long': 'issue.description',
  'instructions-too-long': 'issue.instructions',
  'invalid-model': 'issue.model',
  'fork-model-ignored': 'issue.forkModel',
  'fork-preset-ignored': 'issue.forkPreset',
  'invalid-fork-scope': 'issue.forkScope',
  'spawn-fork-scope-ignored': 'issue.spawnForkScope',
  'invalid-preset': 'issue.preset',
  'builtin-context-fixed': 'issue.builtin',
  'builtin-missing': 'issue.builtin',
  'builtin-duplicate': 'issue.builtin',
}

/**
 * The sentence that tells the user what to fix.
 * @param issue - a validation issue.
 * @param t - the translator.
 * @returns localized text naming the role and the limit involved.
 */
export function issueText(issue: Issue, t: Translator): string {
  const id = issue.roleId ?? ''
  const max =
    issue.code === 'description-too-long'
      ? MAX_DESCRIPTION_LENGTH
      : issue.code === 'instructions-too-long'
        ? MAX_INSTRUCTIONS_LENGTH
        : issue.code === 'too-many-roles'
          ? MAX_ROLES
          : ID_MAX_LENGTH
  return t(issue.code === 'invalid-id' && id === '' ? 'issue.emptyId' : ISSUE_KEYS[issue.code], { id, max })
}
