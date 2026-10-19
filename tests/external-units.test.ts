import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { formatDiagnostic, limitDiagnostic, MAX_DIAGNOSTIC_BYTES, safeFacts } from '../src/host/external/diagnostic.ts'
import { composeEnv, definedEntries, FIXED_REMOVALS } from '../src/host/external/env.ts'
import { ByteTail, LineSplitter } from '../src/host/external/lines.ts'
import {
  accessCeiling,
  accessOfSandboxMode,
  assertCwdAllowed,
  assertExplicitCwdCheckable,
  assertDepth,
  assertUsableCwd,
  effectivePermission,
  isInside,
} from '../src/host/external/policy.ts'
import { CLI_ADAPTERS } from '../src/host/external/registry.ts'
import { FAILURE_CATEGORIES } from '../src/host/external/types.ts'
import { type AccessLevel, CLI_IDS, cliDescriptor } from '../src/shared/cli/index.ts'
import { fakeAgent, fakeSession } from './host-fakes.ts'

describe('adapter registry', () => {
  it.each(CLI_IDS)('%s has an adapter carrying its own descriptor', id => {
    expect(CLI_ADAPTERS[id].descriptor).toBe(cliDescriptor(id))
  })

  it.each(CLI_IDS)('%s plans a read-only run without throwing', id => {
    const descriptor = cliDescriptor(id)
    const runner = {
      cli: id,
      permission: descriptor.presetForAccess['read-only'],
      ...(descriptor.needsProvider ? { provider: 'p', model: 'm' } : {}),
    }
    const input = {
      runner,
      preset: runner.permission,
      access: 'read-only' as const,
      instructions: 'Your role: r.',
      task: 't',
      cwd: '/',
    }
    const plan = CLI_ADAPTERS[id].plan(input, 'n0n0n0n0n0n0')
    expect(plan.argv.length).toBeGreaterThan(0)
    expect(plan.cancelGraceMs).toBeGreaterThanOrEqual(0)
  })
})

describe('access ceiling', () => {
  const parent = (depth?: number) =>
    fakeAgent('p', fakeSession('s', depth === undefined ? {} : { delegationDepth: depth }))

  it.each([
    ['read-only', 'read-only'],
    ['workspace-write', 'workspace-write'],
    ['danger-full-access', 'full-access'],
    ['auto', 'workspace-write'],
    [undefined, 'workspace-write'],
  ])('maps sandbox mode %s to %s', (mode, level) => {
    expect(accessOfSandboxMode(mode)).toBe(level)
  })

  it('uses the parent session policy, read-only parents, and a missing or broken service', () => {
    const agent = parent()
    const resolve = vi.fn(() => ({ mode: 'danger-full-access', workspaceRoot: '/ws' }))
    expect(accessCeiling(agent, false, { resolve })).toEqual({ access: 'full-access', workspaceRoot: '/ws' })
    expect(resolve).toHaveBeenCalledWith({ session: agent.session })
    expect(accessCeiling(agent, true, { resolve })).toEqual({ access: 'read-only', workspaceRoot: '/ws' })
    expect(accessCeiling(agent, false, undefined)).toEqual({ access: 'workspace-write' })
    const broken = {
      resolve: () => {
        throw new Error('boom')
      },
    }
    expect(accessCeiling(agent, false, broken)).toEqual({ access: 'workspace-write' })
  })

  const levels: AccessLevel[] = ['read-only', 'workspace-write', 'full-access']
  it.each(CLI_IDS)('%s presets are lowered to the ceiling and never widened', id => {
    const descriptor = cliDescriptor(id)
    for (const preset of descriptor.permissions) {
      for (const ceiling of levels) {
        const result = effectivePermission(descriptor, { cli: id, permission: preset.id }, ceiling)
        const order = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 }
        if (order[preset.access] <= order[ceiling]) {
          expect(result).toEqual({ preset: preset.id, access: preset.access, lowered: false })
        } else {
          expect(result).toEqual({ preset: descriptor.presetForAccess[ceiling], access: ceiling, lowered: true })
        }
      }
    }
    expect(() => effectivePermission(descriptor, { cli: id, permission: 'bogus' }, 'full-access')).toThrow(/unknown/)
  })

  it('refuses a delegation beyond the depth limit', () => {
    expect(() => assertDepth(parent(), undefined)).not.toThrow()
    expect(() => assertDepth(parent(0), 1)).not.toThrow()
    expect(() => assertDepth(parent(1), 1)).toThrow(/delegation depth limit reached \(current 1, maximum 1\)/)
  })
})

describe('working directory checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'rolesubagents-policy-'))
  const workspace = join(root, 'ws')
  mkdirSync(join(workspace, 'sub'), { recursive: true })
  mkdirSync(join(root, 'outside'))
  mkdirSync(join(root, 'ws-sibling'))
  symlinkSync(join(root, 'outside'), join(workspace, 'escape'))

  it('accepts only absolute, existing directories', () => {
    expect(assertUsableCwd(workspace)).toBe(workspace)
    expect(() => assertUsableCwd('relative')).toThrow(/absolute path/)
    expect(() => assertUsableCwd(join(root, 'missing'))).toThrow(/not an accessible directory/)
  })

  it('contains the child below full access, resolving symbolic links', () => {
    expect(isInside(workspace, workspace)).toBe(true)
    expect(isInside(workspace, join(workspace, 'sub'))).toBe(true)
    expect(isInside(workspace, join(root, 'ws-sibling'))).toBe(false)
    expect(isInside(workspace, join(workspace, 'escape'))).toBe(false)
    expect(() => assertCwdAllowed(join(root, 'outside'), 'workspace-write', workspace)).toThrow(/outside the parent/)
    expect(() => assertCwdAllowed(join(root, 'outside'), 'read-only', workspace)).toThrow(/outside the parent/)
    expect(() => assertCwdAllowed(join(root, 'outside'), 'full-access', workspace)).not.toThrow()
    expect(() => assertCwdAllowed(join(root, 'outside'), 'workspace-write', undefined)).not.toThrow()
  })

  it('refuses an explicit cwd that cannot be checked (unknown workspace root) unless read-only or full access', () => {
    const unknown = /the parent's workspace is unknown/
    expect(() => assertExplicitCwdCheckable('/x', 'workspace-write', undefined)).toThrow(unknown)
    expect(() => assertExplicitCwdCheckable('/x', 'read-only', undefined)).not.toThrow()
    expect(() => assertExplicitCwdCheckable('/x', 'full-access', undefined)).not.toThrow()
    expect(() => assertExplicitCwdCheckable(undefined, 'workspace-write', undefined)).not.toThrow()
    expect(() => assertExplicitCwdCheckable('/x', 'workspace-write', workspace)).not.toThrow()
  })
})

describe('environment composition', () => {
  const hostEnv = {
    PATH: '/bin',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_USE_BEDROCK: '1',
    MY_KEY: 'secret',
    OVERRIDE: 'host',
  }

  it('removes nested-agent markers and prefixed variables, applies the overlay, then forwards names', () => {
    const env = composeEnv({
      overlay: { ADDED: 'x', OVERRIDE: 'plan', PATH: undefined },
      removePrefixes: ['CLAUDE_CODE_', ''],
      passthrough: ['MY_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'OVERRIDE', 'MISSING'],
      hostEnv,
    })
    for (const name of FIXED_REMOVALS) expect(name in env && env[name] === undefined).toBe(true)
    expect(env).toMatchObject({
      CLAUDE_CODE_ENTRYPOINT: undefined,
      CLAUDE_CODE_USE_BEDROCK: '1',
      MY_KEY: 'secret',
      ADDED: 'x',
      OVERRIDE: 'plan',
      PATH: undefined,
    })
    expect('MISSING' in env).toBe(false)
    expect(definedEntries(env)).toEqual({
      CLAUDE_CODE_USE_BEDROCK: '1',
      MY_KEY: 'secret',
      ADDED: 'x',
      OVERRIDE: 'plan',
    })
  })

  it('forwards a variable the plan removes', () => {
    const env = composeEnv({ overlay: { MY_KEY: undefined }, passthrough: ['MY_KEY'], hostEnv })
    expect(env.MY_KEY).toBe('secret')
  })
})

describe('diagnostics', () => {
  it('uses only fixed vocabulary and safe facts', () => {
    expect(formatDiagnostic('Codex', 'auth', { 'exit code': 1 })).toBe(
      'Subagent failure (CLI: Codex; category: auth; exit code: 1)\nThe CLI is not signed in or its API key was rejected. Sign in with the CLI on the host, or forward its API-key variable in the plugin settings.',
    )
    expect(formatDiagnostic('OpenCode', 'unknown')).toBe('Subagent failure (CLI: OpenCode; category: unknown)')
    expect(
      safeFacts({
        'exit code': 2,
        'http status': 401,
        reason: 'api_error',
        Bad: 1,
        message: 'Bearer sk-123 rejected by https://x',
        nan: Number.NaN,
      }),
    ).toEqual(['exit code: 2', 'http status: 401', 'reason: api_error'])
    for (const category of FAILURE_CATEGORIES)
      expect(formatDiagnostic('X', category)).toContain(`category: ${category}`)
  })

  it('caps diagnostics at 4096 UTF-8 bytes on a character boundary', () => {
    const text = 'é'.repeat(3000)
    const limited = limitDiagnostic(text)
    expect(new TextEncoder().encode(limited).byteLength).toBeLessThanOrEqual(MAX_DIAGNOSTIC_BYTES)
    expect(limited.endsWith('…')).toBe(true)
    expect(limited).not.toContain('�')
    expect(limitDiagnostic('short')).toBe('short')
  })
})

describe('line framing', () => {
  const collect = (options?: { maxLength?: number; onOverflow?: () => void }) => {
    const lines: string[] = []
    return { lines, splitter: new LineSplitter(line => lines.push(line), options) }
  }

  it('splits LF and CRLF lines across chunks and flushes the last line', () => {
    const { lines, splitter } = collect()
    splitter.push('one\r\ntw')
    splitter.push('o\n\nthr')
    splitter.push(Buffer.from('ee'))
    splitter.end()
    splitter.push('ignored\n')
    expect(lines).toEqual(['one', 'two', '', 'three'])
  })

  it('decodes multi-byte characters split across chunks', () => {
    const { lines, splitter } = collect()
    const bytes = Buffer.from('{"t":"日本語 ✓"}\n', 'utf8')
    for (const byte of bytes) splitter.push(Uint8Array.of(byte))
    splitter.end()
    expect(lines).toEqual(['{"t":"日本語 ✓"}'])
  })

  it('drops an oversized line whole and resynchronizes', () => {
    const onOverflow = vi.fn()
    const { lines, splitter } = collect({ maxLength: 8, onOverflow })
    splitter.push('short\n12345')
    splitter.push('67890 still long')
    splitter.push(' tail\nnext\n')
    splitter.end()
    expect(lines).toEqual(['short', 'next'])
    expect(onOverflow).toHaveBeenCalledTimes(1)
  })

  it('keeps only the stderr tail', () => {
    const tail = new ByteTail(10)
    tail.push('0123456789')
    tail.push(Buffer.from('abc'))
    expect(tail.text()).toBe('3456789abc')
    tail.push('x'.repeat(30))
    expect(tail.text()).toBe('x'.repeat(10))
  })
})
