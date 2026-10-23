import { describe, expect, it } from 'vitest'
import { effectivePermission } from '../src/host/external/policy.ts'
import { claudeCodeAdapter } from '../src/host/cli/claude-code/index.ts'
import { CLAUDE_CODE } from '../src/shared/cli/claude-code.ts'
import { cliDescriptor } from '../src/shared/cli/index.ts'
import { normalizeRunner } from '../src/shared/runner.ts'

describe('explicit native harness permissions', () => {
  it.each(['grok-build', 'pi'] as const)(
    'defaults %s to the DSH-confined workspace path without widening the parent',
    cli => {
      const descriptor = cliDescriptor(cli)
      expect(descriptor.defaultPermission).toBe('workspace-write')
      expect(
        effectivePermission(descriptor, { cli, permission: descriptor.defaultPermission }, 'workspace-write'),
      ).toEqual({ preset: 'workspace-write', access: 'workspace-write', lowered: false })
      expect(descriptor.permissions.find(p => p.id === descriptor.defaultPermission)?.confinement).toBe('host-sandbox')
      expect(() => effectivePermission(descriptor, { cli, permission: 'workspace-write' }, 'read-only')).toThrow()
    },
  )
  it.each(['grok-build', 'pi'] as const)('refuses %s under restricted parents, instead of inventing a sandbox', cli => {
    const descriptor = cliDescriptor(cli)
    for (const ceiling of ['read-only', 'workspace-write'] as const) {
      expect(() => effectivePermission(descriptor, { cli, permission: 'native' }, ceiling)).toThrow(
        /cannot|does not provide/,
      )
    }
    expect(effectivePermission(descriptor, { cli, permission: 'native' }, 'full-access')).toEqual({
      preset: 'native',
      access: 'full-access',
      lowered: false,
    })
  })

  it.each(['grok-build', 'pi'] as const)(
    'disables an unsupported read-only %s role while retaining its settings',
    cli => {
      const problems: string[] = []
      const result = normalizeRunner(
        { cli, permission: 'native' },
        { id: 'native', enabled: true, readOnly: true },
        (_code, message) => problems.push(message),
      )
      expect(result.disable).toBe(true)
      expect(result.runner?.permission).toBe('native')
      expect(problems.join(' ')).toMatch(/no verified read-only preset/)
    },
  )

  it('does not elevate or silently replace explicitly chosen native Claude permissions', () => {
    for (const ceiling of ['read-only', 'workspace-write'] as const) {
      expect(() =>
        effectivePermission(CLAUDE_CODE, { cli: 'claude-code', permission: 'nativeAcceptEdits' }, ceiling),
      ).toThrow(/native harness cannot guarantee/)
    }
    expect(
      effectivePermission(CLAUDE_CODE, { cli: 'claude-code', permission: 'nativeAcceptEdits' }, 'full-access').preset,
    ).toBe('nativeAcceptEdits')
    expect(CLAUDE_CODE.defaultPermission).toBe('acceptEdits')
  })

  it('uses native acceptEdits, not bypassPermissions or blanket settings/MCP/tool restrictions', () => {
    const plan = claudeCodeAdapter.plan(
      {
        runner: { cli: 'claude-code', permission: 'nativeAcceptEdits' },
        preset: 'nativeAcceptEdits',
        access: 'full-access',
        instructions: '',
        task: 'edit a file',
        cwd: '/work',
      },
      'test',
    )
    expect(plan.argv).toContain('acceptEdits')
    for (const flag of ['bypassPermissions', '--strict-mcp-config', '--setting-sources', '--tools'])
      expect(plan.argv).not.toContain(flag)
    expect(plan.envRemovePrefixes).toEqual([])
  })
})
