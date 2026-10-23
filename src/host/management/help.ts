/** Static model-facing guidance. No settings, metadata, plans or child execution. */
export function roleManagementHelp() {
  return {
    ok: true,
    kind: 'help',
    purpose:
      'Manage saved role definitions for this Host/profile, not running children. Creating a role does not start a child; delegate starts one. Reuse an existing suitable role; put one-off work in delegate.prompt instead of creating near-duplicate roles.',
    promptFields: {
      'role.description': 'Parent-facing: when to choose this role. Not a child instruction.',
      'role.instructions':
        'Child-facing: reusable approach, constraints and expected report. Added as role context, not an override of higher-priority instructions or permissions.',
      'delegate.prompt':
        'Child-facing: this particular task, targets, necessary context and completion criteria. Fresh children do not see the parent conversation.',
      'delegate.description': 'Short display label for this particular task, not the saved role description.',
    },
    promptExample: {
      description: 'Use for reviewing code changes for bugs and regressions without editing files.',
      instructions:
        'Read the requested code and relevant tests. Report issues with severity, evidence and suggested fixes. Do not modify files. State what could not be verified.',
      readOnly: true,
      delegation: {
        description: 'Review authentication changes',
        prompt:
          'Review the authentication diff, especially expired-token handling. Report problems with file locations and supporting evidence.',
      },
      note: 'Text saying do not edit is not a permission setting. Also set readOnly: true when read-only execution is intended; normal runner and caller restrictions still apply.',
    },
    actions: {
      help: 'No extra arguments. Static guidance; no configuration write, preview plan, model lookup or child launch.',
      list: 'No extra arguments. Saved role summaries, settings revision and currentSession state/revision.',
      get: 'id required. Full known fields for one saved role, including instructions, with revisions.',
      capabilities:
        'Optional target. Supported fields/contexts and candidate permissions; advertised support is not caller authorization.',
      models:
        'target required; optional provider, query, limit, offset, refresh. For dsh, first get the provider roster, then request a returned provider. Candidates are not verified authentication, entitlement or availability.',
      preview:
        'expectedRevision and changes required. Validate up to 16 create/update/delete changes and return a caller-owned planId, expiry and diff; does not save.',
      apply:
        'planId required. Recheck and save the previewed roles only; does not refresh the current catalog or start a child.',
      apply_current:
        "expectedRevision and expectedSessionRevision required. Explicitly refresh only this parent's future delegate catalog; existing children and other sessions stay unchanged.",
    },
    sequence: [
      'Read list; use get before editing an existing role. Inspect capabilities/models only when needed.',
      'Preview with the exact settings revision from your fresh read. Inspect the returned diff before apply.',
      'Apply the exact unexpired planId returned to this caller. Plans expire after 10 minutes.',
      'Read list again after saving; never guess the next revision. Saving affects new root conversations, not old session snapshots.',
      'Only if needed here: apply_current using both fresh revision and currentSession.revision from list/get. Check currentApplied, sessionDurable and nextAction separately from globalSaved.',
      'Wait for the next model/tool boundary, then use the refreshed delegate in a separate call. Do not parallelize refresh and delegation or use new IDs inside an already-bound workflow program.',
    ],
    examples: {
      note: 'Schematic individual calls, not one workflow. Replace revision 42 and placeholder IDs with exact fresh response values. Update/delete are alternative preview examples, not an automatic sequence. The delegate example starts a child and can consume model usage; help itself executes none of these examples.',
      list: { action: 'list' },
      get: { action: 'get', id: 'code_reviewer' },
      create: {
        action: 'preview',
        expectedRevision: 42,
        changes: [
          {
            op: 'create',
            role: {
              id: 'code_reviewer',
              description: 'Use for reviewing code changes for bugs and regressions without editing files.',
              instructions:
                'Read the requested code and relevant tests. Report issues with severity, evidence and suggested fixes. Do not modify files. State what could not be verified.',
              context: 'spawn',
              readOnly: true,
            },
          },
        ],
      },
      update: {
        action: 'preview',
        expectedRevision: 42,
        changes: [
          {
            op: 'update',
            id: 'code_reviewer',
            patch: {
              instructions:
                'Review only the requested scope. Report evidence and unverified assumptions without editing files.',
            },
          },
        ],
      },
      delete: { action: 'preview', expectedRevision: 42, changes: [{ op: 'delete', id: 'code_reviewer' }] },
      apply: { action: 'apply', planId: 'REPLACE_WITH_RETURNED_PLAN_ID' },
      apply_current: {
        action: 'apply_current',
        expectedRevision: 42,
        expectedSessionRevision: 'REPLACE_WITH_CURRENT_SESSION_REVISION',
      },
      delegate: {
        role: 'code_reviewer',
        description: 'Review authentication changes',
        prompt:
          'Review the authentication diff, especially expired-token handling. Report problems with file locations and supporting evidence.',
      },
    },
    rules: [
      'Requires the user-enabled AI management switch and a live eligible parent. Children cannot administer roles; read-only parents can read help but cannot mutate. Help does not bypass authorization.',
      'Create requires id and description. IDs match ^[a-z][a-z0-9_-]{0,31}$. Context defaults to spawn; omitted model inherits the normal parent route. Total role limit: 32.',
      'Updates preserve omitted fields and keep id stable. model/runner are replacement objects, not deep patches; supply complete intended values. Explicit null clears supported optional fields. Clear incompatible fields deliberately.',
      'spawn starts fresh; fork/full copies completed parent turns, not the current turn. fork/task does not inherit the conversation. Inspect capabilities before choosing context/model/runner combinations.',
      'Cannot delete or change built-in general/fork identity, change permission/master switches, workflow defaults, provider routes, CLI executables/environment/credentials, install/authenticate CLIs or select arbitrary Agent Presets. Existing presets may only be preserved or cleared.',
      'Role instructions do not grant access. CLI permissions cannot exceed the caller ceiling. Stored settings needing repair or executable/nonliteral configuration require human/native editing, not implicit repair through an unrelated mutation.',
      'Conflict or expired plan: reread and create a new preview; never blindly retry a write. Global saving, current-session refresh and durability are separate outcomes; inspect returned truth fields before retrying.',
    ],
  }
}
