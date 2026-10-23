/** Thin model-facing adapter. All authority, parsing and persistence live in the shared Host service. */
import { defineTool, type InferValue, type ToolDefinition, type ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import { CLI_IDS } from '../../shared/cli/index.ts'
import type { AgentPort } from '../ports.ts'
import type { RoleManagement } from './service.ts'

export const MANAGEMENT_TOOL_NAME = 'manage_roles'
const nullable = (schema: ValueSchemaSpec): ValueSchemaSpec => ({ oneOf: [schema, { type: 'null' }] })
const model: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    provider: { type: 'string', required: true },
    model: { type: 'string', required: true },
    reasoningEffort: { type: 'string' },
  },
}
const runner: ValueSchemaSpec = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cli: { type: 'string', enum: CLI_IDS, required: true },
    permission: {
      type: 'string',
      description: 'Choose an advertised preset; omission uses the CLI default. Never exceeds the caller ceiling.',
    },
    model: { type: 'string' },
    provider: { type: 'string' },
    effort: { type: 'string' },
    timeoutMinutes: { type: 'integer' },
  },
}
const editable = {
  enabled: { type: 'boolean' },
  description: { type: 'string', description: 'Parent-facing: when to choose this role, not child instructions.' },
  instructions: {
    type: 'string',
    description:
      'Child-facing reusable approach, constraints and expected report. The specific task belongs in delegate.prompt.',
  },
  context: { type: 'string', enum: ['spawn', 'fork'] },
  forkScope: nullable({ type: 'string', enum: ['full', 'task'] }),
  readOnly: { type: 'boolean' },
  model: nullable(model),
  runner: nullable(runner),
  agentPreset: {
    type: 'null',
    description: 'Only clearing an existing preset is supported; arbitrary preset changes require the settings UI.',
  },
} as const
const creatable = {
  enabled: editable.enabled,
  description: editable.description,
  instructions: editable.instructions,
  context: editable.context,
  forkScope: editable.forkScope,
  readOnly: editable.readOnly,
  model: editable.model,
  runner: editable.runner,
} as const
const outputSchema = { type: 'object', additionalProperties: true } as const
export function buildManagementTool(
  owner: AgentPort,
  service: RoleManagement,
  isLive: () => boolean = () => true,
): ToolDefinition {
  return defineTool({
    name: MANAGEMENT_TOOL_NAME,
    description:
      "Manage this Host/profile's saved subagent role definitions, not running children. Requires the user-enabled AI role-management switch and an eligible live parent session; children cannot use it. Use action help for prompt-field guidance, examples and the safe sequence. Read list/get first for settings and current-session revisions; capabilities/models show candidate metadata, not verified authentication or model availability. To create/update/delete: preview a bounded changes batch with expectedRevision, inspect its diff, then apply its planId. Saving affects new root conversations only; apply_current explicitly updates only this parent's FUTURE delegate catalog using the latest settings and session revisions. Wait for the next model/tool boundary before using new delegate IDs; already-bound workflow programs, admitted delegations, existing children and other conversations are unchanged. Cannot edit its own permission switch, CLI executables, environment or credentials. A conflict requires reread/new preview, never blind retry.",
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['help', 'list', 'get', 'capabilities', 'models', 'preview', 'apply', 'apply_current'],
      },
      id: { type: 'string', description: 'get only: exact saved role id.' },
      target: {
        type: 'string',
        enum: ['dsh', ...CLI_IDS],
        description: 'capabilities/models target; models requires it.',
      },
      provider: { type: 'string', description: 'models only: choose a DSH provider from its provider roster.' },
      query: { type: 'string', description: 'models only: filter candidate ids/names.' },
      limit: { type: 'integer', description: 'models only: bounded page size, at most 100.' },
      offset: { type: 'integer', description: 'models only: page offset.' },
      refresh: {
        type: 'boolean',
        description:
          'models only: refresh safe metadata/registry data; never starts inference or unsafe CLI initialization.',
      },
      expectedRevision: {
        type: 'integer',
        description: 'preview/apply_current only: exact saved settings revision from list/get.',
      },
      expectedSessionRevision: {
        type: 'string',
        description: 'apply_current only: exact currentSession.revision from list/get.',
      },
      planId: { type: 'string', description: 'apply only: unexpired preview id belonging to this live caller.' },
      changes: {
        type: 'array',
        description:
          'preview only, at most 16 changes. New id+description required; context defaults spawn. Updates keep id stable; model/runner are replacement objects; explicit null clears. Incompatible fields must be explicitly cleared, never silently repaired.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            op: { type: 'string', required: true, enum: ['create', 'update', 'delete'] },
            id: { type: 'string' },
            role: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ...creatable,
                id: { type: 'string', required: true },
                description: { ...editable.description, required: true },
              },
            },
            patch: { type: 'object', additionalProperties: false, properties: editable },
          },
        },
      },
    },
    output: { schema: outputSchema, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: args => ['help', 'list', 'get', 'capabilities', 'models'].includes(args.action),
    async execute(args, exec) {
      const actor = (exec as { agent?: AgentPort }).agent
      if (actor !== owner || !isLive())
        return {
          ok: false,
          code: 'stale-management-tool',
          message: "Use the current calling parent's tool definition.",
        }
      const reply = await service.execute(actor, args, exec.signal)
      return JSON.parse(JSON.stringify(reply)) as InferValue<typeof outputSchema>
    },
  })
}
