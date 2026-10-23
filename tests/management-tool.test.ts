import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { buildManagementTool, MANAGEMENT_TOOL_NAME } from '../src/host/management/tool.ts'
import { createRoleManagement, type ManagementDeps, type RoleManagement } from '../src/host/management/service.ts'
import { managementAuthorization } from '../src/host/management/auth.ts'
import { managementSettings } from '../src/host/management/settings.ts'
import { DEFAULT_ROLES } from '../src/shared/roles.ts'
import type { AgentPort } from '../src/host/ports.ts'
import { execContext, fakeAgent } from './host-fakes.ts'

vi.mock('@deepseek-ai/dsh-tools', () => import('./host-fakes.ts').then(module => module.toolsModule()))

interface Schema {
  type?: string
  enum?: readonly unknown[]
  required?: readonly string[]
  additionalProperties?: boolean
  properties?: Record<string, Schema>
  items?: Schema
  oneOf?: readonly Schema[]
}
function setup() {
  const owner = fakeAgent('owner')
  const state = { live: true, allowed: true }
  const execute = vi.fn(async (_agent: AgentPort | undefined, args: unknown, signal?: AbortSignal) => {
    if (!state.allowed) return { ok: false, code: 'management-disabled', message: 'AI role management is disabled.' }
    return { ok: true, args, aborted: signal?.aborted ?? false, optional: undefined }
  })
  const service = {
    execute,
    available: () => state.allowed,
    dispose: () => {
      state.live = false
    },
  } as unknown as RoleManagement
  const tool = buildManagementTool(owner, service, () => state.live)
  const run = (args: Record<string, unknown>, actor: AgentPort | undefined = owner, signal?: AbortSignal) =>
    tool.execute(args, execContext(actor, signal))
  return { owner, state, execute, service, tool, run }
}

describe('manage_roles tool adapter', () => {
  it('publishes only supported actions and metadata targets', () => {
    const t = setup()
    const schema = t.tool.parameters as Schema
    expect(t.tool.name).toBe(MANAGEMENT_TOOL_NAME)
    expect(schema.required).toContain('action')
    expect(schema.properties?.action?.enum).toEqual([
      'list',
      'get',
      'capabilities',
      'models',
      'preview',
      'apply',
      'apply_current',
    ])
    expect(schema.properties?.target?.enum).toEqual([
      'dsh',
      'codex',
      'claude-code',
      'agy',
      'opencode',
      'grok-build',
      'pi',
    ])
    for (const forbidden of [
      'allowAiRoleManagement',
      'enabled',
      'namespace',
      'path',
      'credentials',
      'executable',
      'envPassthrough',
    ])
      expect(schema.properties).not.toHaveProperty(forbidden)
  })
  it('advertises strict nested role/model/runner objects and preset clearing only on patches', () => {
    const schema = setup().tool.parameters as Schema
    const change = schema.properties?.changes?.items
    const role = change?.properties?.role
    const patch = change?.properties?.patch
    expect(change?.additionalProperties).toBe(false)
    expect(role?.additionalProperties).toBe(false)
    expect(patch?.additionalProperties).toBe(false)
    expect(role?.required).toEqual(expect.arrayContaining(['id', 'description']))
    expect(role?.properties).not.toHaveProperty('agentPreset')
    expect(patch?.properties?.agentPreset?.type).toBe('null')
    expect(patch?.properties).not.toHaveProperty('id')
    expect(patch?.properties).not.toHaveProperty('builtin')
    const model = role?.properties?.model?.oneOf?.find(node => node.type === 'object')
    const runner = role?.properties?.runner?.oneOf?.find(node => node.type === 'object')
    expect(model?.additionalProperties).toBe(false)
    expect(runner?.additionalProperties).toBe(false)
    expect(runner?.required).toContain('cli')
    expect(runner?.required).not.toContain('permission')
  })
  it.each([
    {},
    { action: 'invented' },
    { action: 'preview', changes: [{ op: 'create', role: { description: 'Missing id' } }] },
    { action: 'preview', changes: [{ op: 'create', role: { id: 'test', description: 'Test', apiKey: 'SECRET' } }] },
    {
      action: 'preview',
      changes: [{ op: 'update', id: 'worker', patch: { runner: { cli: 'pi', executable: 'SECRET' } } }],
    },
    { action: 'preview', changes: [{ op: 'create', role: { id: 'test', description: 'Test', agentPreset: null } }] },
  ])('rejects invalid compiled arguments before invoking the service', async args => {
    const t = setup()
    await expect(t.run(args)).rejects.toThrow()
    expect(t.execute).not.toHaveBeenCalled()
  })
  it('passes the actual owner and signal to the authority service on every execution', async () => {
    const t = setup()
    const controller = new AbortController()
    const args = { action: 'list' }
    const result = await t.run(args, t.owner, controller.signal)
    expect(t.execute).toHaveBeenCalledWith(t.owner, args, controller.signal)
    expect(result).toEqual({ ok: true, args, aborted: false })
    expect(result).not.toHaveProperty('optional')
  })
  it('does not cache ON permission in a captured tool definition', async () => {
    const t = setup()
    const captured: ToolDefinition = t.tool
    expect(await captured.execute({ action: 'list' }, execContext(t.owner))).toMatchObject({ ok: true })
    t.state.allowed = false
    expect(await captured.execute({ action: 'list' }, execContext(t.owner))).toMatchObject({
      ok: false,
      code: 'management-disabled',
    })
    expect(t.execute).toHaveBeenCalledTimes(2)
  })
  it('revokes a cached real-service adapter using authoritative settings, not a cached UI flag', async () => {
    const owner = fakeAgent('real-owner')
    let allowed = true
    let revision = 1
    const settings = managementSettings({
      namespace: () => 'rolesubagents',
      settings: () => ({
        writable: true,
        describe: () => [
          { ns: 'rolesubagents', revision, value: { allowAiRoleManagement: allowed, roles: DEFAULT_ROLES } },
        ],
        mutate: vi.fn(async () => {
          throw new Error('unexpected persistence')
        }),
      }),
    })
    const authorize = managementAuthorization({
      isDisposed: () => false,
      isCurrentAgent: agent => agent === owner,
      isRecordedChild: () => false,
      isReadOnly: () => false,
      sandboxPolicy: () => ({ resolve: () => ({ mode: 'workspace-write' }) }),
    })
    const catalog = {
      capabilities: vi.fn(),
      models: vi.fn(),
      invalidate: vi.fn(),
    } as unknown as ManagementDeps['catalog']
    const service = createRoleManagement({
      settings,
      authorize,
      catalog,
      active: () => ({ revision: 'session-1', enabled: true, roles: DEFAULT_ROLES }),
      applyCurrent: async () => ({ applied: false, durable: false, revision: 'session-1' }),
      audit: { list: async () => ({ entries: [], durable: false }), append: async () => false },
    })
    const captured = buildManagementTool(owner, service)
    expect(await captured.execute({ action: 'list' }, execContext(owner))).toMatchObject({ ok: true })
    allowed = false
    revision++
    expect(await captured.execute({ action: 'list' }, execContext(owner))).toMatchObject({
      ok: false,
      code: 'management-disabled',
    })
    expect(
      await captured.execute({ action: 'preview', expectedRevision: revision, changes: [] }, execContext(owner)),
    ).toMatchObject({ ok: false, code: 'management-disabled' })
  })

  it('rejects inherited, missing and same-id-but-replaced callers before reaching the service', async () => {
    const t = setup()
    for (const actor of [undefined, fakeAgent('child'), fakeAgent(t.owner.id, t.owner.session)]) {
      expect(await t.tool.execute({ action: 'list' }, execContext(actor))).toMatchObject({
        ok: false,
        code: 'stale-management-tool',
      })
    }
    expect(t.execute).not.toHaveBeenCalled()
  })
  it('revokes a cached adapter when its owner generation is no longer live', async () => {
    const t = setup()
    const captured = t.tool
    t.state.live = false
    expect(await captured.execute({ action: 'list' }, execContext(t.owner))).toMatchObject({
      ok: false,
      code: 'stale-management-tool',
    })
    expect(t.execute).not.toHaveBeenCalled()
  })
  it('classifies only valid read actions as concurrency-safe', () => {
    const t = setup()
    for (const action of ['list', 'get', 'capabilities', 'models'])
      expect(t.tool.isConcurrencySafe?.({ action })).toBe(true)
    for (const action of ['preview', 'apply', 'apply_current', 'invented'])
      expect(t.tool.isConcurrencySafe?.({ action })).toBe(false)
    expect(t.tool.isConcurrencySafe?.({})).toBe(false)
  })
  it('renders a structured JSON reply without raw host exception formatting', () => {
    const t = setup()
    const value = { ok: false, code: 'revision-conflict', message: 'Read and preview again.' }
    const blocks = t.tool.output?.render({ action: 'apply' }, value)
    expect(blocks).toEqual([{ type: 'text', text: JSON.stringify(value) }])
  })
})
