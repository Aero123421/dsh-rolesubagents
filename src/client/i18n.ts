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
    'Turns role-based subagents and the workflow default model on or off for new root conversations. The depth limit and parallelism are set in the official Subagent settings.',

  'management.label': 'Allow AI role management',
  'management.hint':
    'Grants eligible parent sessions permission to administer role configuration for this Host/profile, including ordinary workspace-write parents. Children do not inherit it. It does not allow CLI installation or updates, authentication changes, or changes to this permission itself.',
  'management.immediate':
    'Saved immediately, separately from role edits. The switch shows only the Host-accepted permission.',
  'management.noRevision': 'A current Host settings revision is required to change this permission.',
  'management.saving': 'Saving AI role-management permission…',
  'management.saved': 'AI role-management permission saved.',
  'management.failed': 'Could not confirm the permission change. The switch shows the Host’s current value; try again.',
  'management.conflict':
    'Settings changed before this permission could be saved. The switch shows the Host’s current value; try again.',

  'workflow.heading': 'Workflow model',
  'workflow.hint':
    "Explicit workflow model overrides take priority over this setting, then the parent's model. Clear the provider to fall back to the parent unless the workflow specifies a model. This setting is captured per session; changes apply to new root conversations only.",
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
  'confinement.os-sandbox': "Enforced by {cli}'s sandbox, which also covers its shell commands.",
  'confinement.host-sandbox':
    'Runs the entire {cli} CLI through the Host DSH sandbox, allowing workspace and sandbox temporary writes. Older kernels may provide partial enforcement, reported in the result. Uses private per-run settings/model state and static API-key credentials; browser sign-ins and full global resources require the native preset. This is the same path-based file policy as parent DSH tools: existing hard-link aliases can share writes across roots. Network/process access is not restricted.',
  'confinement.tool-scope': "Enforced by {cli}'s own tool permissions (no operating-system sandbox).",
  'confinement.tool-scope-write':
    "Enforced by {cli}'s own tool permissions (no operating-system sandbox), so a delegation is refused when its working directory contains a symbolic link that leads outside the workspace.",
  'confinement.tool-scope-write-git':
    "Enforced by {cli}'s own tool permissions (no operating-system sandbox), so a delegation is refused when its working directory contains a symbolic link that leads outside the workspace, or lies below the top-level of a git repository.",
  'confinement.none': 'No limits: {cli} may change anything the DSH host user can.',
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
    'Gives Claude Code only its read tools (Read, Glob, Grep, WebFetch, WebSearch), with no shell, in dontAsk mode, so anything that would need approval is refused. Your Claude Code settings are not loaded.',
  'ed.readOnlyHelp.agy': 'Gives Antigravity only its read tools: view files, search, and list folders.',
  'ed.readOnlyHelp.opencode':
    'Denies every OpenCode tool except reading, searching and listing files; .env files stay unreadable.',

  'preset.read-only': 'Read-only',
  'preset.workspace-write': 'Workspace write',
  'preset.host-workspace': 'DSH-confined workspace (private CLI state)',
  'preset.danger-full-access': 'Full access (no sandbox)',
  'preset.acceptEdits': 'Edit files (no shell)',
  'preset.nativeAcceptEdits': 'Native accept-edits (keep settings and extensions)',
  'preset.native': 'Native harness (keep settings and extensions)',
  'confinement.native':
    "Keeps {cli}'s native tools, settings and extensions. The adapter does not select or verify an OS sandbox, so an explicitly full-access parent is required; native CLI restrictions may still apply. It does not enable bypass-permissions. No whole-workspace scan is required.",
  'ed.readOnlyHelp.grok-build':
    'Grok Build provides official OS sandbox profiles, but this adapter has not verified their effective restrictions. Its native preset does not select a sandbox, so read-only roles are currently unsupported.',
  'ed.readOnlyHelp.pi':
    'Pi has no built-in OS permission boundary for arbitrary native extensions. Selecting read tools alone does not confine extension code, so read-only roles are unsupported.',
  'preset.auto': 'Auto (classifier)',
  'preset.bypassPermissions': 'Bypass permissions',
  'preset.edit-files': 'Edit files (no shell)',
  'preset.full-access': 'Full access',
  'access.read-only': 'no file changes',
  'access.workspace-write': 'edits in the workspace',
  'access.full-access': 'no restrictions',
  'access.native': 'requires full-access parent; native CLI checks apply',

  'models.refresh': 'Refresh models',
  'models.refreshing': 'Refreshing models…',
  'models.aliases': 'Built-in Claude aliases, not live model discovery. Availability depends on your Claude account.',
  'models.unsupported':
    'Live model discovery is not supported for this CLI. Enter a model ID manually; connection tests do not discover models.',
  'models.live': 'Source: models returned by the saved CLI connection probe.',
  'models.static':
    'Source: built-in fallback suggestions (if available), not verified live. Model IDs remain editable.',
  'models.explicit':
    'Refresh runs the existing connection probe using saved settings, only when requested. No automatic discovery.',
  'models.unchecked': 'Models have not been checked in this page session.',
  'models.checked': 'Last check (UTC): {time}',
  'models.good': 'Last successful model list (UTC): {time}',
  'models.empty':
    'The check returned no usable model list. Check CLI installation, sign-in and model-list support, then retry. You can still type a model ID.',
  'models.timeout':
    'The CLI model-list command timed out. Check the CLI connection and retry; any last successful list is retained.',
  'models.unavailable':
    'The CLI model-list command failed. Check CLI sign-in and model-list support, then retry; any last successful list is retained.',
  'models.retained': 'Showing the last successful model list; it may be out of date.',

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
  'probe.connection-unavailable':
    'The Web connection service is unavailable or still loading. Retry when connected; this does not mean the CLI is missing.',
  'probe.remote-unavailable':
    'The Host reports that the diagnostic Remote service or method is unavailable. Check plugin compatibility or retry after loading. Role settings and delegation are independent.',
  'probe.endpoint-unavailable':
    'The diagnostic endpoint returned HTTP 404. The Gateway or Remote endpoint may be unavailable; this response cannot distinguish them. Check compatibility and retry.',
  'probe.host-auth':
    'The Host denied access to diagnostics. Check your DSH sign-in or access permissions, not the CLI credentials, then retry.',
  'probe.transport':
    'Diagnostics could not reach the Host reliably. Check the connection and retry; the CLI installation has not been determined.',
  'probe.malformed': 'The Host returned an invalid diagnostic response. Check Web/Host/plugin compatibility and retry.',
  'probe.remote-error':
    'The Host diagnostic service reported an error. Retry or check Host logs. This does not establish that the CLI is missing.',

  'foot.clean': 'No changes',
  'foot.unsaved': 'Unsaved changes',
  'foot.save': 'Save',
  'foot.saving': 'Saving…',
  'foot.discard': 'Discard',
  'foot.saved':
    'Saved. New root conversations use these settings. AI can explicitly use apply_current to update its own roles for future delegations, never existing children. Running sessions keep their workflow default model.',
  'foot.failed': 'Could not save. Check the connection and try again.',
  'foot.role-save-unconfirmed':
    'The Host accepted the save, but the current settings view has not confirmed it. Your draft is retained. Check the latest settings before retrying; the write may already be committed.',
  'foot.expression-backed-role-settings':
    'Executable expressions or other unsupported role settings cannot be safely saved from this page. Edit the native profile configuration instead. Your draft is unchanged.',
  'foot.role-write-safety-unavailable':
    'The Host could not confirm that these role settings are safe to write. Nothing was written by this attempt; check the connection or Host support and try again.',
  'foot.role-write-safety-conflict':
    'Settings changed before role-write safety could be confirmed. Nothing was written by this attempt; review the current settings and try again.',
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
  'issue.runnerModel':
    'The model of "{id}" must be 1–{max} letters, digits or . _ : @ / + - [ ] (not starting with -), or empty for the CLI default.',
  'issue.runnerProviderModel':
    'Role "{id}" on {cli} needs both a provider and a model, each made of letters, digits or . _ : @ / + - [ ].',
  'issue.runnerEffort':
    'The reasoning effort of "{id}" is not one {cli} accepts (letters, digits or . _ : @ / + - [ ] only).',
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
    '新しい親の会話でロール別サブエージェントとワークフローの既定モデルを使うかどうかを切り替えます。深さの上限と並列数は、公式のサブエージェント設定で変更します。',

  'management.label': 'AIによるロール管理を許可',
  'management.hint':
    'このHost／プロファイルのロール設定を管理する権限を、対象の親セッションに与えます。通常のworkspace-writeの親でも利用でき、子には継承しません。CLIの導入・更新、認証設定、この許可自体の変更はできません。',
  'management.immediate': 'ロールの編集とは別に即時保存します。スイッチにはHostが受理した許可だけを表示します。',
  'management.noRevision': 'この許可を変更するには、Hostの現在の設定リビジョンが必要です。',
  'management.saving': 'AIによるロール管理の許可を保存しています…',
  'management.saved': 'AIによるロール管理の許可を保存しました。',
  'management.failed': '許可の変更を確認できませんでした。スイッチはHostの現在値です。再試行してください。',
  'management.conflict':
    '許可を保存する前に設定が変更されました。スイッチはHostの現在値です。確認して再試行してください。',

  'workflow.heading': 'ワークフローのモデル',
  'workflow.hint':
    'ワークフローでの明示的なモデル指定、この設定、親のモデルの順に優先します。プロバイダーを空にすると、明示指定がない限り親のモデルを使います。この設定はセッションごとに保持され、変更は新しい親の会話にのみ適用されます。',
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
  'confinement.os-sandbox': '{cli} のサンドボックスで制限します（シェルコマンドも対象です）。',
  'confinement.host-sandbox':
    '{cli} CLI全体をホストDSHのsandbox内で実行し、ワークスペースとsandboxの一時領域への書き込みを許可します。古いカーネルでは部分施行となり結果に明記します。実行専用の設定・モデル情報と静的APIキーを利用し、ブラウザ認証や完全なグローバル資源はnativeが必要です。親DSHと同じパス単位の権限であり、既存のハードリンクは境界外の同一ファイルと書き込みを共有し得ます。ネットワーク・プロセスは制限しません。',
  'confinement.tool-scope': '{cli} 自身のツール権限で制限します（OS のサンドボックスは使いません）。',
  'confinement.tool-scope-write':
    '{cli} 自身のツール権限で制限します（OS のサンドボックスは使いません）。そのため、作業ディレクトリにワークスペースの外を指すシンボリックリンクがあると、委譲を拒否します。',
  'confinement.tool-scope-write-git':
    '{cli} 自身のツール権限で制限します（OS のサンドボックスは使いません）。そのため、作業ディレクトリにワークスペースの外を指すシンボリックリンクがある場合や、作業ディレクトリが git リポジトリの最上位より下にある場合は、委譲を拒否します。',
  'confinement.none': '制限はありません。{cli} は DSH ホストのユーザーが変更できるものを何でも変更できます。',
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
    'Claude Code に読み取り系のツール（Read・Glob・Grep・WebFetch・WebSearch）だけを渡し、シェルなしの dontAsk モードで実行します。承認が必要な操作はすべて拒否します。Claude Code の設定ファイルは読み込みません。',
  'ed.readOnlyHelp.agy': 'Antigravity には読み取り系のツール（ファイルの表示・検索・フォルダーの一覧）だけを渡します。',
  'ed.readOnlyHelp.opencode':
    'ファイルの読み取り・検索・一覧以外の OpenCode のツールをすべて拒否します。.env ファイルも読めません。',

  'preset.read-only': '読み取り専用',
  'preset.workspace-write': 'ワークスペースへの書き込み',
  'preset.host-workspace': 'DSH制限付きワークスペース（実行専用CLI状態）',
  'preset.danger-full-access': 'フルアクセス（サンドボックスなし）',
  'preset.acceptEdits': 'ファイル編集のみ（シェルなし）',
  'preset.nativeAcceptEdits': 'ネイティブ編集（設定・拡張を維持）',
  'preset.native': 'ネイティブハーネス（設定・拡張を維持）',
  'confinement.native':
    '{cli} 本来のツール・設定・拡張を維持します。アダプターはOSサンドボックスを指定・検証しないため、明示的にフルアクセスにした親が必要です。CLI側の制限が適用される場合もあります。権限確認の一括省略は有効にせず、ワークスペース全体の走査も行いません。',
  'ed.readOnlyHelp.grok-build':
    'Grok Build には公式OSサンドボックスがありますが、このアダプターでは実効制限を未検証です。native はサンドボックスを指定しないため、現在は読み取り専用ロールに未対応です。',
  'ed.readOnlyHelp.pi':
    'Pi は任意のネイティブ拡張を隔離する標準のOS権限境界を持ちません。読み取りツールだけを選んでも拡張コードを制限できないため、読み取り専用ロールに未対応です。',
  'preset.auto': '自動判定',
  'preset.bypassPermissions': '権限確認をすべて省略',
  'preset.edit-files': 'ファイル編集のみ（シェルなし）',
  'preset.full-access': 'フルアクセス',
  'access.read-only': 'ファイルを変更しない',
  'access.workspace-write': 'ワークスペース内を編集',
  'access.full-access': '制限なし',
  'access.native': '親はフルアクセス必須・CLI本来の権限設定に従う',

  'models.refresh': 'モデルを更新',
  'models.refreshing': 'モデルを更新中…',
  'models.aliases': 'Claudeの組み込みエイリアスです。ライブ取得ではなく、利用可否はClaudeアカウントによります。',
  'models.unsupported':
    'このCLIのライブモデル取得には未対応です。モデルIDを直接入力してください。接続テストではモデルを取得しません。',
  'models.live': '取得元: 保存済みCLI設定による接続テスト。',
  'models.static': '取得元: 組み込みの候補（ある場合）。ライブ確認はしていません。モデルIDは直接編集できます。',
  'models.explicit': '更新は明示操作時だけ、保存済み設定で既存の接続テストを実行します。自動取得はしません。',
  'models.unchecked': 'この画面ではまだモデルを確認していません。',
  'models.checked': '最終確認（UTC）: {time}',
  'models.good': 'モデル一覧の最終取得成功（UTC）: {time}',
  'models.empty':
    '利用可能なモデル一覧を取得できませんでした。CLIの導入・認証・一覧取得への対応を確認し再試行してください。IDは直接入力できます。',
  'models.timeout':
    'CLIのモデル一覧コマンドがタイムアウトしました。接続を確認して再試行してください。最後に取得できた一覧は保持しています。',
  'models.unavailable':
    'CLIのモデル一覧コマンドが失敗しました。認証と一覧取得への対応を確認して再試行してください。最後に取得できた一覧は保持しています。',
  'models.retained': '最後に取得できたモデル一覧を表示しています。古い可能性があります。',

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
  'probe.connection-unavailable':
    'Web の接続サービスが未提供、または読み込み中です。接続後に再試行してください。CLI の未検出を意味するものではありません。',
  'probe.remote-unavailable':
    'ホストの診断用 Remote サービスまたはメソッドを利用できません。プラグインの互換性を確認するか、読み込み後に再試行してください。役割設定・委任とは独立した診断です。',
  'probe.endpoint-unavailable':
    '診断先が HTTP 404 を返しました。Gateway または Remote の経路が利用できない可能性がありますが、この応答だけでは区別できません。互換性を確認して再試行してください。',
  'probe.host-auth':
    'ホストへの診断アクセスが拒否されました。CLI の認証ではなく、DSH のサインイン・アクセス権限を確認して再試行してください。',
  'probe.transport':
    'ホストとの診断通信に失敗しました。接続を確認して再試行してください。CLI のインストール状態は未確認です。',
  'probe.malformed': 'ホストの診断応答が不正です。Web・ホスト・プラグインの互換性を確認して再試行してください。',
  'probe.remote-error':
    'ホストの診断サービスがエラーを返しました。再試行するかホストのログを確認してください。CLI がないとは断定できません。',

  'foot.clean': '変更はありません',
  'foot.unsaved': '未保存の変更があります',
  'foot.save': '保存',
  'foot.saving': '保存中…',
  'foot.discard': '破棄',
  'foot.saved':
    '保存しました。設定は新しい親の会話に適用されます。AIが明示的にapply_currentを使うと、自分の今後の委任用ロールだけを更新でき、既存の子は変更しません。実行中セッションのワークフローの既定モデルは変わりません。',
  'foot.failed': '保存できませんでした。接続を確認して、もう一度お試しください。',
  'foot.role-save-unconfirmed':
    'Hostは保存を受け付けましたが、現在の設定表示では反映を確認できていません。入力は保持しています。既に保存済みの可能性があるため、再試行前に最新の設定を確認してください。',
  'foot.expression-backed-role-settings':
    '実行可能な式や、対応外の形式・規模を含むロール設定は、この画面から安全に保存できません。ネイティブのプロファイル設定で編集してください。入力中の内容は保持しています。',
  'foot.role-write-safety-unavailable':
    'Hostがロール設定を書き込んでよいか確認できませんでした。この試行では何も書き込んでいません。接続やHostの対応を確認して再試行してください。',
  'foot.role-write-safety-conflict':
    'ロールの書き込み安全性を確認する前に設定が変更されました。この試行では何も書き込んでいません。現在の設定を確認して再試行してください。',
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
  'issue.runnerModel':
    '「{id}」のモデルは、英数字と . _ : @ / + - [ ] からなる1〜{max}文字（先頭に - は不可）で指定するか、空欄にして CLI の既定を使ってください。',
  'issue.runnerProviderModel':
    '{cli} で動く「{id}」には、プロバイダーとモデルの両方が必要です（英数字と . _ : @ / + - [ ] のみ使えます）。',
  'issue.runnerEffort': '「{id}」の推論の強さは、{cli} で使えない値です（英数字と . _ : @ / + - [ ] のみ使えます）。',
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

/**
 * What enforces a preset, for the permission field's help.
 * @param t - the translator.
 * @param cli - the CLI.
 * @param preset - a preset id.
 * @returns the translated sentence, or '' for an unknown preset.
 */
export function confinementHelp(t: Translator, cli: CliId, preset: string): string {
  const descriptor = cliDescriptor(cli)
  const found = descriptor.permissions.find(entry => entry.id === preset)
  if (found === undefined) return ''
  const name = descriptor.displayName
  if (found.nativeHarness) return t('confinement.native', { cli: name })
  if (found.confinement !== 'tool-scope') return t(`confinement.${found.confinement}`, { cli: name })
  if (found.access !== 'workspace-write') return t('confinement.tool-scope', { cli: name })
  const key =
    descriptor.toolScope === 'git-worktree' ? 'confinement.tool-scope-write-git' : 'confinement.tool-scope-write'
  return t(key, { cli: name })
}

/** Timeout limits for the editor's help text. */
export const TIMEOUT_TEXT = { max: MAX_RUNNER_TIMEOUT_MINUTES, default: DEFAULT_RUNNER_TIMEOUT_MINUTES } as const
