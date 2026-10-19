/**
 * UI chrome strings. `en` is the source of truth for the key set; `ja` is
 * checked against it by its type, so a missing or extra key is a compile error.
 * Role text (ids, descriptions, instructions) is whatever the user typed and is
 * never translated.
 */

import { type AccessLevel, type CliId, cliDescriptor } from '../shared/cli/index.ts'
import {
  DEFAULT_RUNNER_TIMEOUT_MINUTES,
  MAX_DESCRIPTION_LENGTH,
  MAX_ENV_PASSTHROUGH,
  MAX_INSTRUCTIONS_LENGTH,
  MAX_ROLES,
  MAX_RUNNER_TIMEOUT_MINUTES,
  type SettingsProblem,
} from '../shared/roles.ts'
import { MAX_RUNNER_NAME_LENGTH } from '../shared/runner.ts'
import { ID_MAX_LENGTH, type Issue } from './draft.ts'

const en = {
  'master.label': 'Subagents',
  'master.hint':
    'Turns role-based subagents and the workflow default model on or off for new sessions. The depth limit and parallelism are set in the official Subagent settings.',

  'workflow.heading': 'Workflow model',
  'workflow.hint':
    "Explicit workflow model overrides take priority over this setting, then the parent's model. Clear the provider to fall back to the parent unless the workflow specifies a model. This setting is captured per session; changes apply to new sessions only.",
  'issue.workflowModel': 'The workflow model needs both a provider and a model, or both empty.',

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
  'row.cliTitle': 'Runs once in {cli} on the Host, starting fresh',
  'row.cliDefault': 'CLI default',

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
  'ed.runsOn': 'Runs on',
  'ed.runsOnDsh': 'DSH (built-in child)',
  'ed.runsOnHelp': 'DSH runs the child inside this session. A CLI runs it once as a separate program on the Host.',
  'ed.runsOnBuiltin': 'Built-in roles always run on DSH.',
  'ed.cliSettings': '{cli} settings',
  'ed.cliModelHelp':
    "Leave empty to use {cli}'s default model. Suggestions come from Test connection under External CLIs, or a built-in list; any model ID {cli} accepts works.",
  'ed.cliModelOpenCode':
    'OpenCode needs both a provider and a model; it never falls back to its own default model. Test connection under External CLIs lists the models it can use.',
  'ed.cliEffortFree': "A variant name of the model, such as high. Leave empty for the model's default.",
  'ed.permission': 'Permission',
  'ed.permissionHelp':
    'What {cli} may do without asking; a delegated run never stops to ask. A delegation never gets more access than the parent session has.',
  'ed.permissionReadOnly': 'Read-only roles can use only a read-only preset.',
  'ed.permissionOption': '{name} — {access}',
  'ed.timeout': 'Timeout (minutes)',
  'ed.timeoutHelp': 'The run is stopped after this many minutes (1–{max}). Leave empty for {default}.',
  'ed.cliLimits': 'A CLI role works differently from a DSH role:',
  'ed.cliLimitOnce':
    'It runs once. The parent gets its final answer, but cannot send it follow-up messages (send_message), and list_agents does not show it.',
  'ed.cliLimitFresh': 'It always starts fresh: it cannot fork the parent conversation or use an agent preset.',
  'ed.cliLimitInstalled':
    '{cli} must be installed and signed in on the Host, or get its API key from a forwarded variable (External CLIs).',
  'ed.cliLimitCancel': 'Stopping it does not undo file changes it already made.',
  'ed.readOnlyHelp.codex': 'Runs Codex in its read-only sandbox, so it cannot change files.',
  'ed.readOnlyHelp.claude-code':
    'Runs Claude Code without its write tools (Write, Edit, NotebookEdit) and in dontAsk mode, so anything that would need approval is refused.',
  'ed.readOnlyHelp.agy': 'Gives Antigravity only its read tools: view files, search, and list folders.',
  'ed.readOnlyHelp.opencode':
    'Denies every OpenCode tool except reading, searching and listing files; .env files stay unreadable.',

  'preset.read-only': 'Read-only',
  'preset.workspace-write': 'Workspace write',
  'preset.danger-full-access': 'Full access (no sandbox)',
  'preset.acceptEdits': 'Accept edits',
  'preset.auto': 'Auto (classifier)',
  'preset.bypassPermissions': 'Bypass permissions',
  'preset.edit-files': 'Edit files (no shell)',
  'preset.full-access': 'Full access',
  'access.read-only': 'no file changes',
  'access.workspace-write': 'edits in the workspace',
  'access.full-access': 'no restrictions',

  'clis.heading': 'External CLIs',
  'clis.hint':
    'Settings shared by every role that runs on a CLI. API keys are never stored here: sign in with each CLI on the Host, or forward the name of an environment variable that holds the key.',
  'clis.used': 'Used by {count} role(s)',
  'clis.executable': 'Executable',
  'clis.executableHelp':
    'An absolute path, or a command name looked up on the Host\'s PATH. Leave empty for "{default}".',
  'clis.env': 'Forwarded environment variables',
  'clis.envHelp':
    "Names only, separated by commas or spaces. Their values are read from the Host's environment when {cli} starts and are never stored.",
  'clis.envPlaceholder': 'e.g. MY_API_KEY',
  'clis.test': 'Test connection',
  'clis.testLabel': 'Test connection to {cli}',
  'clis.testing': 'Testing…',
  'clis.testSaved': 'The test uses the saved settings. Save first to test your changes.',
  'clis.unavailable': 'The connection test is not available on this Host.',
  'probe.found': 'Found: {path}',
  'probe.version': 'Version {version}',
  'probe.authOk': 'Signed in',
  'probe.authMissing': 'Not signed in. Sign in with {cli} on the Host, or forward its API-key variable.',
  'probe.authUnknown': 'Sign-in state unknown',
  'probe.models': '{count} models listed',
  'probe.notFound': '{cli} was not found on the Host. Install it, or set its path above.',
  'probe.noSubprocess': 'This Host cannot start programs for plugins, so CLI roles cannot run here.',
  'probe.checksFailed': 'The version and sign-in checks did not answer.',
  'probe.error': 'The test could not run. Check the connection and try again.',

  'foot.clean': 'No changes',
  'foot.unsaved': 'Unsaved changes',
  'foot.save': 'Save',
  'foot.saving': 'Saving…',
  'foot.discard': 'Discard',
  'foot.saved': 'Saved. Changes apply to new sessions; running sessions keep their roles and workflow default model.',
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
    'Fork role "{id}" must inherit either all completed turns or the task only. An invalid value is kept as task only and does not copy the parent conversation.',
  'issue.spawnForkScope': 'Role "{id}" is not a fork, so its inherited-context option is removed.',
  'issue.builtin': 'The built-in roles general and fork must stay in the list, once each, with their fixed context.',
  'issue.builtinRunner': 'Built-in role "{id}" always runs on DSH.',
  'issue.runner': 'The CLI of "{id}" is not supported. Choose another one under Runs on.',
  'issue.runnerContext': 'Role "{id}" runs on {cli}, which always starts fresh, so it cannot be a fork.',
  'issue.runnerDshModel': 'Role "{id}" runs on {cli}, which has its own model setting; the DSH model is removed.',
  'issue.runnerPreset': 'Role "{id}" runs on {cli}, which cannot use an agent preset.',
  'issue.runnerModel': 'The model of "{id}" must be 1–{max} characters, or empty for the CLI default.',
  'issue.runnerProviderModel': 'Role "{id}" on {cli} needs both a provider and a model.',
  'issue.runnerEffort': 'The reasoning effort of "{id}" is not one {cli} accepts.',
  'issue.runnerPermission': 'The permission of "{id}" is not one of the {cli} presets.',
  'issue.runnerReadOnly': 'Role "{id}" is read-only, so it needs a read-only permission.',
  'issue.runnerTimeout': 'The timeout of "{id}" must be a whole number of minutes from 1 to {max}.',
  'issue.cliExecutable': 'The executable of {cli} must be an absolute path or a command name without folders.',
  'issue.cliEnv':
    'Forwarded variables of {cli} must be at most {max} names like MY_API_KEY: letters, digits and _, not starting with a digit.',
  'issue.cliSettings': 'The external CLI settings are not valid.',
} as const

/** Every UI string key. */
export type Key = keyof typeof en

const ja: Record<Key, string> = {
  'master.label': 'サブエージェント',
  'master.hint':
    '新しいセッションでロール別サブエージェントとワークフローの既定モデルを使うかどうかを切り替えます。深さの上限と並列数は、公式のサブエージェント設定で変更します。',

  'workflow.heading': 'ワークフローのモデル',
  'workflow.hint':
    'ワークフローでの明示的なモデル指定、この設定、親のモデルの順に優先します。プロバイダーを空にすると、明示指定がない限り親のモデルを使います。この設定はセッションごとに保持され、変更は新しいセッションにのみ適用されます。',
  'issue.workflowModel': 'ワークフローのモデルは、プロバイダーとモデルの両方を指定するか、両方を空にしてください。',

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
  'row.cliTitle': 'ホスト上の {cli} で1回だけ実行（空の会話から開始）',
  'row.cliDefault': 'CLI の既定',

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
  'ed.runsOn': '実行先',
  'ed.runsOnDsh': 'DSH（標準の子エージェント）',
  'ed.runsOnHelp':
    'DSH はこのセッションの中で子を動かします。CLI を選ぶと、ホスト上の別のプログラムとして1回だけ実行します。',
  'ed.runsOnBuiltin': '組み込みロールは常に DSH で動きます。',
  'ed.cliSettings': '{cli} の設定',
  'ed.cliModelHelp':
    '空欄なら {cli} の既定のモデルを使います。候補は「外部 CLI」の接続テストの結果か、組み込みの一覧から表示します。{cli} が受け付けるモデルIDなら何でも指定できます。',
  'ed.cliModelOpenCode':
    'OpenCode ではプロバイダーとモデルの両方が必要です（OpenCode 自身の既定モデルには切り替えません）。使えるモデルは「外部 CLI」の接続テストで一覧できます。',
  'ed.cliEffortFree': 'モデルのバリアント名（例: high）です。空欄ならモデルの既定を使います。',
  'ed.permission': '権限',
  'ed.permissionHelp':
    '{cli} が確認なしで行えることです。委譲した実行中に確認を求めることはありません。親のセッションより強い権限で動くこともありません。',
  'ed.permissionReadOnly': '読み取り専用のロールでは、読み取り専用のプリセットだけを選べます。',
  'ed.permissionOption': '{name} — {access}',
  'ed.timeout': 'タイムアウト（分）',
  'ed.timeoutHelp': 'この時間（1〜{max}分）を過ぎると実行を止めます。空欄なら{default}分です。',
  'ed.cliLimits': 'CLI のロールは、DSH のロールと次の点が異なります:',
  'ed.cliLimitOnce':
    '1回だけ実行されます。親は最終回答を受け取れますが、追加のメッセージ（send_message）は送れず、list_agents にも表示されません。',
  'ed.cliLimitFresh': '常に空の会話から始まります。親の会話のフォークやエージェントプリセットは使えません。',
  'ed.cliLimitInstalled':
    '{cli} がホストにインストールされ、サインイン済みである必要があります（または「外部 CLI」で API キーの環境変数を引き渡してください）。',
  'ed.cliLimitCancel': '途中で止めても、すでに変更されたファイルは元に戻りません。',
  'ed.readOnlyHelp.codex': 'Codex を読み取り専用のサンドボックスで実行し、ファイルを変更できないようにします。',
  'ed.readOnlyHelp.claude-code':
    'Claude Code を書き込み系ツール（Write・Edit・NotebookEdit）なしの dontAsk モードで実行し、承認が必要な操作はすべて拒否します。',
  'ed.readOnlyHelp.agy': 'Antigravity には読み取り系のツール（ファイルの表示・検索・フォルダーの一覧）だけを渡します。',
  'ed.readOnlyHelp.opencode':
    'ファイルの読み取り・検索・一覧以外の OpenCode のツールをすべて拒否します。.env ファイルも読めません。',

  'preset.read-only': '読み取り専用',
  'preset.workspace-write': 'ワークスペースへの書き込み',
  'preset.danger-full-access': 'フルアクセス（サンドボックスなし）',
  'preset.acceptEdits': '編集を自動承認',
  'preset.auto': '自動判定',
  'preset.bypassPermissions': '権限確認をすべて省略',
  'preset.edit-files': 'ファイル編集のみ（シェルなし）',
  'preset.full-access': 'フルアクセス',
  'access.read-only': 'ファイルを変更しない',
  'access.workspace-write': 'ワークスペース内を編集',
  'access.full-access': '制限なし',

  'clis.heading': '外部 CLI',
  'clis.hint':
    'CLI で動くすべてのロールに共通の設定です。API キーはここには保存しません。ホスト上で各 CLI にサインインするか、キーを持つ環境変数の名前を引き渡してください。',
  'clis.used': '{count}個のロールが使用中',
  'clis.executable': '実行ファイル',
  'clis.executableHelp': '絶対パス、またはホストの PATH から探すコマンド名です。空欄なら「{default}」を使います。',
  'clis.env': '引き渡す環境変数',
  'clis.envHelp':
    '名前だけを、カンマかスペースで区切って入力します。値は {cli} の起動時にホストの環境から読み取り、保存はしません。',
  'clis.envPlaceholder': '例: MY_API_KEY',
  'clis.test': '接続をテスト',
  'clis.testLabel': '{cli} への接続をテスト',
  'clis.testing': 'テスト中…',
  'clis.testSaved': 'テストは保存済みの設定で行います。変更を試すには、先に保存してください。',
  'clis.unavailable': 'このホストでは接続テストを利用できません。',
  'probe.found': '検出: {path}',
  'probe.version': 'バージョン {version}',
  'probe.authOk': 'サインイン済み',
  'probe.authMissing': '未サインインです。ホストで {cli} にサインインするか、API キーの環境変数を引き渡してください。',
  'probe.authUnknown': 'サインイン状態は不明',
  'probe.models': 'モデル{count}件',
  'probe.notFound':
    'ホストで {cli} が見つかりませんでした。インストールするか、上の「実行ファイル」でパスを指定してください。',
  'probe.noSubprocess': 'このホストではプラグインからプログラムを起動できないため、CLI のロールは実行できません。',
  'probe.checksFailed': 'バージョンとサインイン状態の確認に応答がありませんでした。',
  'probe.error': 'テストを実行できませんでした。接続を確認して、もう一度お試しください。',

  'foot.clean': '変更はありません',
  'foot.unsaved': '未保存の変更があります',
  'foot.save': '保存',
  'foot.saving': '保存中…',
  'foot.discard': '破棄',
  'foot.saved':
    '保存しました。変更は新しいセッションに適用され、実行中のセッションは今のロールとワークフローの既定モデルのままです。',
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
    'フォークのロール「{id}」が引き継げるのは、完了済みのやり取り全部か、タスクだけか、どちらかです。それ以外の値はタスクのみとして扱い、親の会話はコピーしません。',
  'issue.spawnForkScope': 'ロール「{id}」はフォークではないので、引き継ぐ文脈の指定は外します。',
  'issue.builtin': '組み込みロール general と fork は、固定のコンテキストで1つずつ残す必要があります。',
  'issue.builtinRunner': '組み込みロール「{id}」は常に DSH で動きます。',
  'issue.runner': '「{id}」の CLI はサポートされていません。「実行先」で選び直してください。',
  'issue.runnerContext': 'ロール「{id}」は {cli} で動き、常に空の会話から始まるため、フォークにはできません。',
  'issue.runnerDshModel':
    'ロール「{id}」は {cli} で動き、モデルは {cli} 側で指定するため、DSH のモデル指定は外します。',
  'issue.runnerPreset': 'ロール「{id}」は {cli} で動くため、エージェントプリセットは使えません。',
  'issue.runnerModel': '「{id}」のモデルは1〜{max}文字で指定するか、空欄にして CLI の既定を使ってください。',
  'issue.runnerProviderModel': '{cli} で動く「{id}」には、プロバイダーとモデルの両方が必要です。',
  'issue.runnerEffort': '「{id}」の推論の強さは、{cli} で使えない値です。',
  'issue.runnerPermission': '「{id}」の権限は、{cli} のプリセットにない値です。',
  'issue.runnerReadOnly': 'ロール「{id}」は読み取り専用なので、読み取り専用の権限を選んでください。',
  'issue.runnerTimeout': '「{id}」のタイムアウトは、1〜{max}の整数（分）で指定してください。',
  'issue.cliExecutable': '{cli} の実行ファイルは、絶対パスか、フォルダーを含まないコマンド名で指定してください。',
  'issue.cliEnv':
    '{cli} に引き渡す環境変数は、MY_API_KEY のように英字・数字・_ からなり数字で始まらない名前を、{max}個まで指定してください。',
  'issue.cliSettings': '外部 CLI の設定が正しくありません。',
}

/** Both dictionaries, for the completeness check in the tests. */
export const DICTIONARIES: Readonly<Record<'en' | 'ja', Readonly<Record<Key, string>>>> = { en, ja }

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
  'invalid-workflow-model': 'issue.workflowModel',
  'fork-model-ignored': 'issue.forkModel',
  'fork-preset-ignored': 'issue.forkPreset',
  'invalid-fork-scope': 'issue.forkScope',
  'spawn-fork-scope-ignored': 'issue.spawnForkScope',
  'invalid-preset': 'issue.preset',
  'builtin-context-fixed': 'issue.builtin',
  'builtin-missing': 'issue.builtin',
  'builtin-duplicate': 'issue.builtin',
  'builtin-runner-ignored': 'issue.builtinRunner',
  'runner-context-forced': 'issue.runnerContext',
  'runner-model-ignored': 'issue.runnerDshModel',
  'runner-preset-ignored': 'issue.runnerPreset',
  'invalid-runner': 'issue.runner',
  'invalid-runner-model': 'issue.runnerModel',
  'invalid-runner-effort': 'issue.runnerEffort',
  'invalid-runner-permission': 'issue.runnerPermission',
  'runner-readonly-permission': 'issue.runnerReadOnly',
  'invalid-runner-timeout': 'issue.runnerTimeout',
  'invalid-cli-settings': 'issue.cliSettings',
}

function issueKey(issue: Issue): Key {
  if (issue.code === 'invalid-id' && (issue.roleId ?? '') === '') return 'issue.emptyId'
  if (issue.code === 'invalid-runner-model' && issue.cli !== undefined && cliDescriptor(issue.cli).needsProvider) {
    return 'issue.runnerProviderModel'
  }
  if (issue.code === 'invalid-cli-settings' && issue.field === 'executable') return 'issue.cliExecutable'
  if (issue.code === 'invalid-cli-settings' && issue.field === 'env') return 'issue.cliEnv'
  return ISSUE_KEYS[issue.code]
}

const ISSUE_LIMITS: Partial<Record<SettingsProblem['code'], number>> = {
  'description-too-long': MAX_DESCRIPTION_LENGTH,
  'instructions-too-long': MAX_INSTRUCTIONS_LENGTH,
  'too-many-roles': MAX_ROLES,
  'invalid-runner-model': MAX_RUNNER_NAME_LENGTH,
  'invalid-runner-timeout': MAX_RUNNER_TIMEOUT_MINUTES,
  'invalid-cli-settings': MAX_ENV_PASSTHROUGH,
}

/**
 * The sentence that tells the user what to fix.
 * @param issue - a validation issue.
 * @param t - the translator.
 * @returns localized text naming the role, the CLI and the limit involved.
 */
export function issueText(issue: Issue, t: Translator): string {
  const id = issue.roleId ?? ''
  const cli = issue.cli === undefined ? 'CLI' : cliDescriptor(issue.cli).displayName
  const max = ISSUE_LIMITS[issue.code] ?? ID_MAX_LENGTH
  return t(issueKey(issue), { id, max, cli })
}

/** Whether a string is a UI key. */
function isKey(key: string): key is Key {
  return Object.hasOwn(en, key)
}

/**
 * Display name of a CLI permission preset.
 * @param t - the translator.
 * @param preset - a preset id (CLI-native).
 * @returns its translated name, or the id itself for a preset without one.
 */
export function presetName(t: Translator, preset: string): string {
  const key = `preset.${preset}`
  return isKey(key) ? t(key) : preset
}

/**
 * What an access level allows, in a few words.
 * @param t - the translator.
 * @param access - the level.
 * @returns the translated label.
 */
export function accessName(t: Translator, access: AccessLevel): string {
  return t(`access.${access}`)
}

/**
 * How Read-only is enforced on one CLI.
 * @param t - the translator.
 * @param cli - the CLI.
 * @returns the translated help text.
 */
export function readOnlyHelp(t: Translator, cli: CliId): string {
  return t(`ed.readOnlyHelp.${cli}`)
}

/** Timeout limits for the editor's help text. */
export const TIMEOUT_TEXT = { max: MAX_RUNNER_TIMEOUT_MINUTES, default: DEFAULT_RUNNER_TIMEOUT_MINUTES } as const
