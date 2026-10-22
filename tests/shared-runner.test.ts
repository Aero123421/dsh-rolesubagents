import { describe, expect, it } from 'vitest'
import {
  ACCESS_ORDER,
  type AccessLevel,
  CLI_DESCRIPTORS,
  CLI_IDS,
  cliDescriptor,
  isCliId,
  presetAccess,
} from '../src/shared/cli/index.ts'
import {
  DEFAULT_ROLES,
  DEFAULT_RUNNER_TIMEOUT_MINUTES,
  EXTERNAL_ONE_SHOT_CONTEXT,
  EXTERNAL_READ_ONLY_CONTEXT,
  isRunnerRole,
  normalizeSettings,
  type RoleDefinition,
  roleContextText,
  roleListLine,
  runnerTimeoutMs,
  type SettingsProblem,
} from '../src/shared/roles.ts'
import { isUsableExecutable } from '../src/shared/runner.ts'

const GENERAL = DEFAULT_ROLES[0] as RoleDefinition
const FORK = DEFAULT_ROLES[1] as RoleDefinition

function custom(patch: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'ext',
    enabled: true,
    description: 'External role.',
    instructions: 'Do the thing.',
    context: 'spawn',
    readOnly: false,
    ...patch,
  }
}

/** Normalize one custom role next to the built-ins. */
function one(patch: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const { settings, problems } = normalizeSettings({ enabled: true, roles: [GENERAL, FORK, custom(patch)], ...extra })
  return { role: settings.roles.find(entry => entry.id === 'ext'), problems, settings }
}

const codes = (problems: SettingsProblem[]) => problems.map(problem => problem.code)

function expectIdempotent(input: unknown): void {
  const first = normalizeSettings(input).settings
  const second = normalizeSettings(first)
  expect(second.problems).toEqual([])
  expect(second.settings).toEqual(first)
}

describe('CLI descriptors', () => {
  it('lists the same CLIs in the id list and the registry', () => {
    expect(Object.keys(CLI_DESCRIPTORS)).toEqual([...CLI_IDS])
    for (const id of CLI_IDS) expect(cliDescriptor(id).id).toBe(id)
  })

  it.each(CLI_IDS)('%s is internally consistent', id => {
    const descriptor = cliDescriptor(id)
    const ids = descriptor.permissions.map(preset => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain(descriptor.defaultPermission)
    expect(presetAccess(descriptor, descriptor.defaultPermission)).toBe(
      id === 'grok-build' || id === 'pi' ? 'full-access' : 'workspace-write',
    )
    for (const level of Object.keys(ACCESS_ORDER) as AccessLevel[]) {
      const preset = descriptor.presetForAccess[level]
      if (preset !== undefined) expect(presetAccess(descriptor, preset)).toBe(level)
      else expect(descriptor.permissions.some(p => p.access === level)).toBe(false)
    }
    expect(new Set(descriptor.efforts).size).toBe(descriptor.efforts.length)
    if (descriptor.efforts.length === 0) expect(descriptor.effortFreeText).toBe(true)
    expect(descriptor.displayName).not.toBe('')
    expect(descriptor.executable).toMatch(/^[a-z]+$/)
    expect(Object.isFrozen(descriptor)).toBe(true)
  })

  it('carries the verified preset and effort data', () => {
    const presets = (id: (typeof CLI_IDS)[number]) => cliDescriptor(id).permissions.map(p => `${p.id}:${p.access}`)
    expect(presets('codex')).toEqual([
      'read-only:read-only',
      'workspace-write:workspace-write',
      'danger-full-access:full-access',
    ])
    expect(presets('claude-code')).toEqual([
      'read-only:read-only',
      'acceptEdits:workspace-write',
      'nativeAcceptEdits:full-access',
      'auto:full-access',
      'bypassPermissions:full-access',
    ])
    expect(presets('agy')).toEqual(['read-only:read-only', 'edit-files:workspace-write', 'full-access:full-access'])
    expect(presets('opencode')).toEqual([
      'read-only:read-only',
      'edit-files:workspace-write',
      'full-access:full-access',
    ])
    expect(cliDescriptor('codex').efforts).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(cliDescriptor('codex').efforts).not.toContain('ultra')
    expect(cliDescriptor('claude-code').efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(cliDescriptor('agy').efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(cliDescriptor('claude-code').modelSuggestions).toEqual(['default', 'opus', 'sonnet', 'haiku', 'fable'])
    expect(cliDescriptor('opencode').needsProvider).toBe(true)
    expect(cliDescriptor('opencode').modelSuggestions).toEqual([])
  })

  it('recognizes CLI ids', () => {
    expect(isCliId('codex')).toBe(true)
    expect(isCliId('dsh')).toBe(false)
    expect(isCliId(undefined)).toBe(false)
  })
})

describe('normalizeSettings: runners', () => {
  it('keeps a valid runner and orders its fields', () => {
    const { role, problems } = one({
      runner: { timeoutMinutes: 5, permission: 'read-only', effort: 'high', model: ' gpt-6-sol ', cli: 'codex' },
    })
    expect(problems).toEqual([])
    expect(role?.runner).toEqual({
      cli: 'codex',
      model: 'gpt-6-sol',
      effort: 'high',
      permission: 'read-only',
      timeoutMinutes: 5,
    })
    expect(Object.keys(role?.runner ?? {})).toEqual(['cli', 'model', 'effort', 'permission', 'timeoutMinutes'])
  })

  it('ignores a runner on a built-in role', () => {
    const { settings, problems } = normalizeSettings({
      roles: [{ ...GENERAL, runner: { cli: 'codex', permission: 'read-only' } }, FORK],
    })
    expect(codes(problems)).toEqual(['builtin-runner-ignored'])
    expect(settings.roles[0]?.runner).toBeUndefined()
  })

  it.each([
    ['a string', 'codex'],
    ['an unknown cli', { cli: 'gemini', permission: 'read-only' }],
    ['an array', ['codex']],
  ])('drops %s runner and keeps the role on DSH', (_label, runner) => {
    const { role, problems } = one({ runner, model: { provider: 'p', model: 'm' } })
    expect(codes(problems)).toEqual(['invalid-runner'])
    expect(role?.runner).toBeUndefined()
    // The DSH fields stay validated as before.
    expect(role?.model).toEqual({ provider: 'p', model: 'm' })
  })

  it('treats a null runner as absent', () => {
    expect(one({ runner: null }).problems).toEqual([])
  })

  it('forces a runner role to start fresh', () => {
    const fork = one({ context: 'fork', forkScope: 'full', runner: { cli: 'codex', permission: 'read-only' } })
    expect(codes(fork.problems)).toEqual(['runner-context-forced'])
    expect(fork.role?.context).toBe('spawn')
    expect(fork.role?.forkScope).toBeUndefined()
    const scope = one({ forkScope: 'task', runner: { cli: 'codex', permission: 'read-only' } })
    expect(codes(scope.problems)).toEqual(['runner-context-forced'])
  })

  it('drops the DSH model and agent preset of a runner role', () => {
    const { role, problems } = one({
      model: { provider: 'p', model: 'm' },
      agentPreset: 'preset',
      runner: { cli: 'codex', permission: 'read-only' },
    })
    expect(codes(problems)).toEqual(['runner-model-ignored', 'runner-preset-ignored'])
    expect(role?.model).toBeUndefined()
    expect(role?.agentPreset).toBeUndefined()
  })

  it.each([
    ['an empty-after-trim model', { model: '   ' }],
    ['a too long model', { model: 'x'.repeat(129) }],
    ['a non-string model', { model: 42 }],
    ['a provider on a CLI without providers', { model: 'opus', provider: 'anthropic' }],
    ['a model with an OpenCode file reference', { model: '{file:~/.ssh/id_rsa}' }],
    ['a model with an env reference', { model: '{env:HOME}' }],
    ['a model with whitespace inside', { model: 'claude opus' }],
    ['a model with a dollar sign', { model: '$HOME' }],
    ['a model with quotes', { model: 'a"b' }],
    ['a model with a backslash', { model: 'a\\b' }],
    ['a model that looks like an option', { model: '--dangerously-skip-permissions' }],
  ])('clears %s', (_label, fields) => {
    const { role, problems } = one({ runner: { cli: 'claude-code', permission: 'acceptEdits', ...fields } })
    expect(codes(problems)).toEqual(['invalid-runner-model'])
    expect(role?.runner?.model).toBeUndefined()
    expect(role?.runner?.provider).toBeUndefined()
    expect(role?.enabled).toBe(true)
  })

  it.each([
    'sonnet[1m]',
    'claude-opus-5-5',
    'gpt-5.5',
    'us.anthropic.claude-sonnet-5:0',
    'qwen2.5:7b-instruct-q4_K_M',
    'org@v1+beta',
  ])('keeps the model id %s', model => {
    const { role, problems } = one({ runner: { cli: 'claude-code', permission: 'acceptEdits', model } })
    expect(problems).toEqual([])
    expect(role?.runner?.model).toBe(model)
  })

  it('refuses OpenCode config substitutions in provider, model and effort', () => {
    const base = { cli: 'opencode', provider: 'p', model: 'm', permission: 'edit-files' }
    for (const field of ['provider', 'model'] as const) {
      const { role, problems } = one({ runner: { ...base, [field]: '{file:~/.ssh/id_rsa}' } })
      expect(codes(problems)).toEqual(['invalid-runner-model'])
      expect(role?.enabled).toBe(false)
      expect(role?.runner?.model).toBeUndefined()
      expect(role?.runner?.provider).toBeUndefined()
    }
    for (const effort of ['{env:OPENAI_API_KEY}', 'high max', '-x']) {
      const { role, problems } = one({ runner: { ...base, effort } })
      expect(codes(problems)).toEqual(['invalid-runner-effort'])
      expect(role?.runner?.effort).toBeUndefined()
      expect(role?.enabled).toBe(true)
    }
    expectIdempotent({ roles: [GENERAL, FORK, custom({ runner: { ...base, model: '{file:/etc/passwd}' } })] })
  })

  it('requires provider and model together for OpenCode and switches the role off otherwise', () => {
    const ok = one({ runner: { cli: 'opencode', provider: 'anthropic', model: 'claude', permission: 'edit-files' } })
    expect(ok.problems).toEqual([])
    expect(ok.role?.runner).toMatchObject({ provider: 'anthropic', model: 'claude' })
    for (const runner of [
      { cli: 'opencode', permission: 'edit-files' },
      { cli: 'opencode', model: 'claude', permission: 'edit-files' },
      { cli: 'opencode', provider: 'anthropic', permission: 'edit-files' },
    ]) {
      const { role, problems } = one({ runner })
      expect(codes(problems)).toEqual(['invalid-runner-model'])
      expect(role?.enabled).toBe(false)
      expect(role?.runner?.model).toBeUndefined()
      expect(role?.runner?.provider).toBeUndefined()
      expectIdempotent({ roles: [GENERAL, FORK, custom({ runner })] })
    }
    // Already switched off: nothing to report.
    expect(one({ enabled: false, runner: { cli: 'opencode', permission: 'edit-files' } }).problems).toEqual([])
  })

  it('validates efforts against the CLI', () => {
    expect(codes(one({ runner: { cli: 'codex', permission: 'read-only', effort: 'ultra' } }).problems)).toEqual([
      'invalid-runner-effort',
    ])
    expect(one({ runner: { cli: 'codex', permission: 'read-only', effort: '' } }).role?.runner?.effort).toBeUndefined()
    const free = one({
      runner: { cli: 'opencode', provider: 'p', model: 'm', permission: 'edit-files', effort: 'thinking-max' },
    })
    expect(free.problems).toEqual([])
    expect(free.role?.runner?.effort).toBe('thinking-max')
    expect(
      codes(
        one({ runner: { cli: 'opencode', provider: 'p', model: 'm', permission: 'edit-files', effort: 7 } }).problems,
      ),
    ).toEqual(['invalid-runner-effort'])
  })

  it('repairs an unknown permission to the CLI default', () => {
    const { role, problems } = one({ runner: { cli: 'agy', permission: 'danger-full-access' } })
    expect(codes(problems)).toEqual(['invalid-runner-permission'])
    expect(role?.runner?.permission).toBe('edit-files')
  })

  it('keeps a read-only role on a read-only preset', () => {
    const { role, problems } = one({ readOnly: true, runner: { cli: 'claude-code', permission: 'bypassPermissions' } })
    expect(codes(problems)).toEqual(['runner-readonly-permission'])
    expect(role?.runner?.permission).toBe('read-only')
    const missing = one({ readOnly: true, runner: { cli: 'codex' } })
    expect(codes(missing.problems)).toEqual(['invalid-runner-permission', 'runner-readonly-permission'])
    expect(missing.role?.runner?.permission).toBe('read-only')
  })

  it.each([0, 1441, 2.5, '30', Number.NaN])('clears the invalid timeout %s', timeoutMinutes => {
    const { role, problems } = one({ runner: { cli: 'codex', permission: 'read-only', timeoutMinutes } })
    expect(codes(problems)).toEqual(['invalid-runner-timeout'])
    expect(role?.runner?.timeoutMinutes).toBeUndefined()
  })

  it('computes the timeout in milliseconds', () => {
    expect(runnerTimeoutMs({ cli: 'codex', permission: 'read-only' })).toBe(DEFAULT_RUNNER_TIMEOUT_MINUTES * 60_000)
    expect(runnerTimeoutMs({ cli: 'codex', permission: 'read-only', timeoutMinutes: 2 })).toBe(120_000)
  })

  it('is idempotent for every repaired runner shape', () => {
    const runners: unknown[] = [
      { cli: 'codex', permission: 'nope', effort: 'ultra', timeoutMinutes: 0, model: '' },
      { cli: 'claude-code', provider: 'x', model: 'opus' },
      { cli: 'agy', permission: 'full-access', model: 'gemini-3.1-pro', effort: 'max', timeoutMinutes: 1440 },
      { cli: 'opencode', provider: 'p', model: 'm', permission: 'full-access', effort: 'variant' },
      'nonsense',
    ]
    for (const runner of runners) {
      expectIdempotent({
        roles: [GENERAL, FORK, custom({ runner, context: 'fork', model: { provider: 'p', model: 'm' } })],
      })
      expectIdempotent({ roles: [GENERAL, FORK, custom({ runner, readOnly: true, agentPreset: 'x' })] })
    }
  })
})

describe('normalizeSettings: clis', () => {
  it('keeps valid CLI settings in a stable order and drops empty entries', () => {
    const { settings, problems } = normalizeSettings({
      clis: {
        opencode: {},
        agy: { executable: ' /opt/cli-tools/bin/agy ' },
        codex: { envPassthrough: ['CODEX_API_KEY', 'CODEX_API_KEY', 'OTHER'] },
      },
    })
    expect(problems).toEqual([])
    expect(settings.clis).toEqual({
      codex: { envPassthrough: ['CODEX_API_KEY', 'OTHER'] },
      agy: { executable: '/opt/cli-tools/bin/agy' },
    })
    expect(Object.keys(settings.clis ?? {})).toEqual(['codex', 'agy'])
  })

  it.each([
    ['not an object', 'codex'],
    ['an unknown CLI', { gemini: { executable: 'gemini' } }],
    ['a non-object entry', { codex: 'codex' }],
    ['a relative executable', { codex: { executable: 'bin/codex' } }],
    ['a non-string executable', { codex: { executable: 7 } }],
    ['a bad variable name', { codex: { envPassthrough: ['NOT-OK'] } }],
    ['too many variables', { codex: { envPassthrough: Array.from({ length: 33 }, (_, i) => `V${i}`) } }],
    ['a non-array variable list', { codex: { envPassthrough: 'CODEX_API_KEY' } }],
  ])('reports %s as invalid-cli-settings', (_label, clis) => {
    const { settings, problems } = normalizeSettings({ clis })
    expect(codes(problems)).toEqual(['invalid-cli-settings'])
    expect(settings.clis).toBeUndefined()
    expectIdempotent({ clis })
  })

  it('accepts absolute POSIX and Windows paths and bare names only', () => {
    for (const ok of ['codex', '/usr/bin/codex', 'C:\\tools\\codex.exe', 'C:/tools/codex.exe', '\\\\server\\codex']) {
      expect(isUsableExecutable(ok)).toBe(true)
    }
    for (const bad of ['./codex', 'bin/codex', 'a\\b', 'co\ndex', 'x'.repeat(4097)]) {
      expect(isUsableExecutable(bad)).toBe(false)
    }
  })

  it('omits clis when none are stored', () => {
    expect('clis' in normalizeSettings({ clis: null }).settings).toBe(false)
    expect('clis' in normalizeSettings({ clis: {} }).settings).toBe(false)
  })
})

describe('legacy 0.1.x settings', () => {
  it('load unchanged and without problems', () => {
    const legacy = {
      enabled: true,
      roles: [
        ...DEFAULT_ROLES.map(role => ({ ...role })),
        {
          id: 'modelled',
          enabled: false,
          description: 'd',
          instructions: 'i',
          context: 'spawn',
          model: { provider: 'p', model: 'm', reasoningEffort: 'high' },
          agentPreset: 'preset',
          readOnly: true,
        },
        {
          id: 'tasky',
          enabled: true,
          description: '',
          instructions: '',
          context: 'fork',
          forkScope: 'task',
          readOnly: false,
        },
      ],
      workflowModel: { provider: 'p', model: 'm' },
    }
    const { settings, problems } = normalizeSettings(JSON.parse(JSON.stringify(legacy)))
    expect(problems).toEqual([])
    expect(settings).toEqual(legacy)
  })
})

describe('runner text helpers', () => {
  const runnerRole = (patch: Partial<RoleDefinition> = {}): RoleDefinition => ({
    id: 'coder',
    enabled: true,
    description: 'Writes code.',
    instructions: 'Be careful.',
    context: 'spawn',
    readOnly: false,
    runner: { cli: 'claude-code', permission: 'acceptEdits' },
    ...patch,
  })

  it('marks runner roles in their tool-description line', () => {
    expect(roleListLine(runnerRole())).toBe(
      '- coder: Writes code. (runs once in Claude Code; cannot receive send_message)',
    )
    expect(roleListLine(runnerRole({ readOnly: true, runner: { cli: 'agy', permission: 'read-only' } }))).toBe(
      '- coder: Writes code. (runs once in Antigravity, read-only; cannot receive send_message)',
    )
  })

  it('builds the CLI instructions text without DSH-only sentences', () => {
    expect(roleContextText(runnerRole())).toBe(`Your role: coder.\nBe careful.\n${EXTERNAL_ONE_SHOT_CONTEXT}`)
    expect(roleContextText(runnerRole({ readOnly: true, instructions: '  ' }))).toBe(
      `Your role: coder.\n${EXTERNAL_READ_ONLY_CONTEXT}\n${EXTERNAL_ONE_SHOT_CONTEXT}`,
    )
    expect(isRunnerRole(runnerRole())).toBe(true)
    expect(isRunnerRole(GENERAL)).toBe(false)
  })
})
