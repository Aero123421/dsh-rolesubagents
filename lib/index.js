import { createRequire as __dshRolesCreateRequire } from 'node:module';
const require = __dshRolesCreateRequire(import.meta.url);

// src/host/index.ts
import z from "@deepseek-ai/schemastery";

// src/shared/roles.ts
var ROLE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
var MAX_ROLES = 32;
var MAX_DESCRIPTION_LENGTH = 1e3;
var MAX_INSTRUCTIONS_LENGTH = 8e3;
var MAX_NAME_LENGTH = 128;
var DEFAULT_ROLES = Object.freeze([
  {
    id: "general",
    enabled: true,
    builtin: "general",
    description: "General-purpose child for a self-contained task. It does not see this conversation, so include everything it needs.",
    instructions: "",
    context: "spawn",
    readOnly: false
  },
  {
    id: "fork",
    enabled: true,
    builtin: "fork",
    description: "For follow-up analysis, a second opinion, or a continuation of this conversation. It does not see the current turn, so state what is new.",
    instructions: "",
    context: "fork",
    readOnly: false
  },
  {
    id: "worker",
    enabled: true,
    description: "Implements one scoped change. Give it the files or area it may change, the expected result, and how to check it is done.",
    instructions: "You are a worker. Change only the files and scope you were given. When you finish, report what you changed, how you checked it, and anything left undone.",
    context: "spawn",
    readOnly: false
  },
  {
    id: "explorer",
    enabled: true,
    description: "Read-only investigation of code, docs, or the web. Say what to find and where to look; it returns findings with file paths or links.",
    instructions: "You are an explorer. Investigate only what you were asked. Report concise findings with file paths, line numbers, or links as evidence. You cannot modify files.",
    context: "spawn",
    readOnly: true
  },
  {
    id: "reviewer",
    enabled: true,
    description: "Independent read-only review. Give it the target and the acceptance criteria; do not pass your own reasoning, so its judgement stays independent.",
    instructions: "You are a reviewer. Judge the target against each given criterion and answer pass or fail with evidence. Point out concrete problems; do not rewrite the work. You cannot modify files.",
    context: "spawn",
    readOnly: true
  }
]);
var DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  roles: DEFAULT_ROLES
});
var BUILTIN_CONTEXT = { general: "spawn", fork: "fork" };
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value) {
  return typeof value === "string" ? value : "";
}
function nonEmpty(value, max) {
  if (typeof value !== "string") return void 0;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > max ? void 0 : trimmed;
}
function cloneDefault(builtin) {
  const found = DEFAULT_ROLES.find((role) => role.builtin === builtin);
  if (found === void 0) throw new Error(`missing default for built-in role "${builtin}"`);
  return { ...found };
}
function normalizeSettings(input) {
  const problems = [];
  const source = isRecord(input) ? input : {};
  const enabled = typeof source.enabled === "boolean" ? source.enabled : DEFAULT_SETTINGS.enabled;
  const rawRoles = Array.isArray(source.roles) ? source.roles : DEFAULT_ROLES;
  const roles = [];
  const seen = /* @__PURE__ */ new Set();
  const builtins = /* @__PURE__ */ new Set();
  rawRoles.forEach((raw, index) => {
    if (!isRecord(raw)) {
      problems.push({ index, code: "not-an-object", message: `role #${index + 1} is not an object` });
      return;
    }
    const builtin = raw.builtin === "general" || raw.builtin === "fork" ? raw.builtin : void 0;
    if (builtin !== void 0 && builtins.has(builtin)) {
      problems.push({ index, code: "builtin-duplicate", message: `built-in role "${builtin}" appears more than once` });
      return;
    }
    const id = builtin ?? (typeof raw.id === "string" ? raw.id : "");
    if (!ROLE_ID_PATTERN.test(id)) {
      problems.push({ index, id, code: "invalid-id", message: `role id "${id}" must match ${ROLE_ID_PATTERN}` });
      return;
    }
    if (seen.has(id)) {
      problems.push({ index, id, code: "duplicate-id", message: `role id "${id}" is used more than once` });
      return;
    }
    if (roles.length >= MAX_ROLES) {
      problems.push({ index, id, code: "too-many-roles", message: `only ${MAX_ROLES} roles are kept` });
      return;
    }
    let context = raw.context === "fork" ? "fork" : "spawn";
    if (builtin !== void 0 && context !== BUILTIN_CONTEXT[builtin]) {
      problems.push({
        index,
        id,
        code: "builtin-context-fixed",
        message: `built-in role "${builtin}" always uses ${BUILTIN_CONTEXT[builtin]}`
      });
      context = BUILTIN_CONTEXT[builtin];
    }
    let description = text(raw.description);
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      problems.push({
        index,
        id,
        code: "description-too-long",
        message: `description of "${id}" is cut to ${MAX_DESCRIPTION_LENGTH} characters`
      });
      description = description.slice(0, MAX_DESCRIPTION_LENGTH);
    }
    let instructions = text(raw.instructions);
    if (instructions.length > MAX_INSTRUCTIONS_LENGTH) {
      problems.push({
        index,
        id,
        code: "instructions-too-long",
        message: `instructions of "${id}" are cut to ${MAX_INSTRUCTIONS_LENGTH} characters`
      });
      instructions = instructions.slice(0, MAX_INSTRUCTIONS_LENGTH);
    }
    const role = {
      id,
      enabled: raw.enabled !== false,
      ...builtin === void 0 ? {} : { builtin },
      description,
      instructions,
      context,
      readOnly: raw.readOnly === true
    };
    if (raw.model !== void 0 && raw.model !== null) {
      const model = isRecord(raw.model) ? raw.model : {};
      const provider = nonEmpty(model.provider, MAX_NAME_LENGTH);
      const modelId = nonEmpty(model.model, MAX_NAME_LENGTH);
      const effort = model.reasoningEffort === void 0 || model.reasoningEffort === "" ? void 0 : nonEmpty(model.reasoningEffort, MAX_NAME_LENGTH);
      if (provider === void 0 || modelId === void 0 || model.reasoningEffort !== void 0 && model.reasoningEffort !== "" && effort === void 0) {
        problems.push({
          index,
          id,
          code: "invalid-model",
          message: `model of "${id}" needs a provider and a model; it inherits the parent's route instead`
        });
      } else if (context === "fork") {
        problems.push({
          index,
          id,
          code: "fork-model-ignored",
          message: `fork role "${id}" always uses the parent's model`
        });
      } else {
        role.model = { provider, model: modelId, ...effort === void 0 ? {} : { reasoningEffort: effort } };
      }
    }
    if (raw.agentPreset !== void 0 && raw.agentPreset !== null && raw.agentPreset !== "") {
      const preset = nonEmpty(raw.agentPreset, MAX_NAME_LENGTH);
      if (preset === void 0) {
        problems.push({ index, id, code: "invalid-preset", message: `agent preset of "${id}" is not a valid id` });
      } else if (context === "fork") {
        problems.push({
          index,
          id,
          code: "fork-preset-ignored",
          message: `fork role "${id}" cannot use an agent preset`
        });
      } else {
        role.agentPreset = preset;
      }
    }
    seen.add(id);
    if (builtin !== void 0) builtins.add(builtin);
    roles.push(role);
  });
  for (const builtin of ["general", "fork"]) {
    if (builtins.has(builtin)) continue;
    const restored = { ...cloneDefault(builtin), enabled: false };
    if (seen.has(restored.id)) {
      problems.push({
        code: "builtin-missing",
        id: builtin,
        message: `built-in role "${builtin}" is shadowed by a custom role with the same id`
      });
      continue;
    }
    problems.push({
      code: "builtin-missing",
      id: builtin,
      message: `built-in role "${builtin}" was missing and is restored switched off`
    });
    roles.splice(builtin === "general" ? 0 : Math.min(1, roles.length), 0, restored);
  }
  while (roles.length > MAX_ROLES) {
    const index = roles.findLastIndex((role) => role.builtin === void 0);
    const [dropped] = roles.splice(index, 1);
    problems.push({ id: dropped?.id, code: "too-many-roles", message: `only ${MAX_ROLES} roles are kept` });
  }
  return { settings: { enabled, roles }, problems };
}
function selectableRoles(settings) {
  return settings.enabled ? settings.roles.filter((role) => role.enabled) : [];
}
function roleContextText(role) {
  const lines = [];
  const instructions = role.instructions.trim();
  if (instructions.length > 0 || role.builtin === void 0) lines.push(`Your role: ${role.id}.`);
  if (instructions.length > 0) lines.push(instructions);
  if (role.readOnly) {
    lines.push(
      "This role is read-only: you cannot modify files, and requests for wider sandbox access are rejected. Report what should change instead of trying to change it."
    );
  }
  return lines.join("\n");
}
var FORK_NOTE = " (fork: inherits this conversation's completed turns)";
function roleListLine(role) {
  const description = role.description.trim();
  return `- ${role.id}${description.length > 0 ? `: ${description}` : ""}${role.context === "fork" ? FORK_NOTE : ""}`;
}

// src/host/records.ts
import { appendPluginRecord, pluginRecordOf } from "@deepseek-ai/dsh-session";
var ROLES_RECORD = "plugin:dsh-rolesubagents/roles";
var ROLE_RECORD = "plugin:dsh-rolesubagents/role";
function latest(session, type) {
  let data;
  for (const event of session.snapshotEvents()) {
    const record = pluginRecordOf(event);
    if (record?.type === type) data = record.data;
  }
  return data;
}
function isRecord2(value) {
  return typeof value === "object" && value !== null;
}
function readRolesSnapshot(session) {
  const data = latest(session, ROLES_RECORD);
  if (!isRecord2(data) || data.version !== 1) return void 0;
  return normalizeSettings(data.settings).settings;
}
function readRole(session) {
  const data = latest(session, ROLE_RECORD);
  if (!isRecord2(data) || data.version !== 1 || !isRecord2(data.role)) return void 0;
  const role = normalizeSettings({ enabled: true, roles: [data.role] }).settings.roles.find(
    (entry) => entry.id === data.role.id
  );
  return role;
}
function writeRolesSnapshot(session, settings) {
  appendPluginRecord(session, ROLES_RECORD, { version: 1, settings });
}
function writeRole(session, role) {
  appendPluginRecord(session, ROLE_RECORD, { version: 1, role });
}

// src/host/tool.ts
import { randomUUID } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
var TOOL_NAME = "delegate";
function toolDescription(roles) {
  const general = roles.some((role) => role.builtin === "general");
  return [
    "Delegate a task to a subagent: a separate agent that works in its own context and returns its result, not its intermediate steps. Pick the role that fits the task:",
    ...roles.map(roleListLine),
    general ? "Omit `role` to use `general`." : "A `role` is required.",
    "The subagent starts in the background and this tool immediately returns its id; the runtime notifies you when it finishes. The child reports results with `send_message`; use `send_message` to steer it while running or continue its conversation after it finishes. Start independent delegations together in one assistant message and keep working while they run. When only waiting remains, end your turn instead of sleeping or polling; the next result starts a new turn."
  ].join("\n");
}
function resolveRole(roles, requested) {
  if (requested === void 0 || requested === "") {
    const general = roles.find((role2) => role2.builtin === "general");
    if (general === void 0)
      throw new Error(`role is required; choose one of: ${roles.map((role2) => role2.id).join(", ")}`);
    return general;
  }
  const role = roles.find((entry) => entry.id === requested);
  if (role === void 0)
    throw new Error(`unknown role "${requested}"; choose one of: ${roles.map((entry) => entry.id).join(", ")}`);
  return role;
}
function buildTool(snapshot, deps) {
  const roles = selectableRoles(snapshot);
  if (roles.length === 0) return void 0;
  const hasGeneral = roles.some((role) => role.builtin === "general");
  return defineTool({
    name: TOOL_NAME,
    description: toolDescription(roles),
    parameters: {
      description: {
        type: "string",
        required: true,
        description: "A short (3-5 word) description of the delegated task, for display."
      },
      prompt: {
        type: "string",
        required: true,
        description: "The task for the subagent. Fresh roles do not see this conversation, so include everything they need. Fork roles already see its completed turns but not the current one, so state what is new, including anything from the current turn they need."
      },
      role: {
        type: "string",
        ...hasGeneral ? {} : { required: true },
        enum: roles.map((role) => role.id),
        description: hasGeneral ? "Role for this subagent. Omit to use `general`." : "Role for this subagent."
      },
      cwd: {
        type: "string",
        description: "Initial child working directory. Relative paths use your current directory; omitted inherits it. Later directory changes in either agent are independent."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", required: true, const: "activation" },
          subagentId: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: `started subagent ${value.subagentId}` }]
    },
    isConcurrencySafe: () => true,
    async execute(rawArgs, exec) {
      const args = rawArgs;
      const parent = exec.agent;
      if (parent === void 0) throw new Error("subagent tool requires a calling agent");
      const role = resolveRole(roles, args.role);
      const providerName = role.context === "fork" ? deps.forkProvider : deps.spawnProvider;
      const provider = deps.ctx.subagents.getProvider(providerName);
      if (provider === void 0) throw new Error(`subagent provider "${providerName}" is not available`);
      const agentOptions = role.model === void 0 ? void 0 : {
        provider: role.model.provider,
        model: role.model.model,
        ...role.model.reasoningEffort === void 0 ? {} : { reasoningEffort: role.model.reasoningEffort }
      };
      if (agentOptions !== void 0) {
        if (provider.capabilities.agentOptions !== true) {
          throw new Error(`role "${role.id}": provider "${providerName}" cannot set the child model`);
        }
        await deps.ctx.get("llm")?.resolveCallConfig(agentOptions, exec.signal);
      }
      if (role.agentPreset !== void 0 && (provider.capabilities.agentPreset !== true || provider.inheritsParentContext === true)) {
        throw new Error(`role "${role.id}": provider "${providerName}" cannot mount agent preset "${role.agentPreset}"`);
      }
      const maxDepth = deps.ctx.subagents.resolveMaxDepth(void 0);
      const childId = randomUUID();
      deps.pending.set(childId, { role, snapshot });
      try {
        const started = await deps.ctx.subagents.startActivation({
          provider: providerName,
          childId,
          label: args.description,
          request: {
            prompt: [{ type: "text", text: args.prompt }],
            parent,
            ...args.cwd === void 0 ? {} : { cwd: args.cwd },
            ...role.agentPreset === void 0 ? {} : { agentPreset: role.agentPreset },
            ...agentOptions === void 0 ? {} : { agentOptions },
            ...maxDepth === void 0 ? {} : { maxDepth }
          },
          signal: exec.signal,
          delivery: "parent"
        });
        return { kind: "activation", subagentId: started.childId };
      } finally {
        deps.pending.delete(childId);
      }
    }
  });
}

// src/host/index.ts
var name = "dsh-rolesubagents";
var inject = ["tools", "subagents", "systemPrompt", "agents"];
var ROLE_CONTEXT_ORDER = 121;
var Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  roles: z.array(z.any()).default(DEFAULT_ROLES.map((role) => ({ ...role }))).volatile(),
  spawnProvider: z.string().default("spawn"),
  forkProvider: z.string().default("fork")
});
function read(value, fallback) {
  if (value === void 0) return fallback;
  if (typeof value === "object" && value !== null && "get" in value && typeof value.get === "function")
    return value.get();
  return value;
}
function apply(ctx, config = {}) {
  const spawnProvider = config.spawnProvider ?? "spawn";
  const forkProvider = config.forkProvider ?? "fork";
  const pending = /* @__PURE__ */ new Map();
  const installed = /* @__PURE__ */ new Map();
  const sessions = /* @__PURE__ */ new Map();
  let lastProblems = "";
  const currentSettings = () => {
    const { settings, problems } = normalizeSettings({
      enabled: read(config.enabled, true),
      roles: read(config.roles, DEFAULT_ROLES)
    });
    const summary = problems.map((problem) => problem.message).join("; ");
    if (summary !== "" && summary !== lastProblems) ctx.logger.warn(`rolesubagents: settings adjusted: ${summary}`);
    lastProblems = summary;
    return settings;
  };
  const stateOf = (id) => {
    let state = sessions.get(id);
    if (state === void 0) {
      state = { toolInstalled: false };
      sessions.set(id, state);
    }
    return state;
  };
  const roleOf = (agent) => {
    const state = stateOf(agent.session.id);
    if (state.role === void 0) state.role = readRole(agent.session) ?? null;
    return state.role ?? void 0;
  };
  const snapshotFor = (agent) => {
    const recorded = readRolesSnapshot(agent.session);
    if (recorded !== void 0) return recorded;
    const parentId = agent.session.header.parentSession;
    const parentSession = parentId === void 0 ? void 0 : ctx.get("sessions")?.get(parentId);
    const snapshot = (parentSession === void 0 ? void 0 : readRolesSnapshot(parentSession)) ?? currentSettings();
    writeRolesSnapshot(agent.session, snapshot);
    return snapshot;
  };
  const install = (agent, snapshot) => {
    if (installed.has(agent)) return;
    const definition = buildTool(snapshot, { ctx, spawnProvider, forkProvider, pending });
    if (definition === void 0) return;
    installed.set(agent, agent.ctx.tools.register(definition));
    stateOf(agent.session.id).toolInstalled = true;
  };
  const onCreated = (agent, source) => {
    const child = pending.get(agent.id);
    if (child !== void 0 && source === "startup") {
      if (child.role.readOnly) agent.session.append("sandbox/mode", { mode: "read-only" });
      writeRole(agent.session, child.role);
      writeRolesSnapshot(agent.session, child.snapshot);
      stateOf(agent.session.id).role = child.role;
      install(agent, child.snapshot);
      return;
    }
    install(agent, snapshotFor(agent));
  };
  ctx.systemPrompt.context({
    name: "rolesubagents:role",
    order: ROLE_CONTEXT_ORDER,
    interpolate: false,
    required: true,
    text: ({ agent }) => {
      if (agent === void 0) return "";
      const lines = [];
      const role = roleOf(agent);
      if (role !== void 0) {
        const text2 = roleContextText(role);
        if (text2 !== "") lines.push(text2);
      }
      const depth = agent.session.header.delegationDepth ?? 0;
      const maxDepth = ctx.subagents.resolveMaxDepth(void 0);
      if (depth > 0 && maxDepth !== void 0 && stateOf(agent.session.id).toolInstalled) {
        const remaining = Math.max(0, maxDepth - depth);
        lines.push(
          `Delegation depth for \`${TOOL_NAME}\`: current ${depth}, maximum ${maxDepth}, remaining levels ${remaining}.` + (remaining === 0 ? ` Do not call \`${TOOL_NAME}\` at this depth; carry out the work directly.` : "")
        );
      }
      return lines.join("\n\n");
    }
  });
  const guarded = (agent, source) => {
    try {
      onCreated(agent, source);
    } catch (error) {
      if (pending.get(agent.id)?.role.readOnly === true && source === "startup") throw error;
      ctx.logger.warn(
        `rolesubagents: could not prepare agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };
  ctx.on("agent/created", ({ agent, source }) => guarded(agent, source));
  ctx.on("agent/disposed", ({ agent }) => {
    installed.get(agent)?.();
    installed.delete(agent);
    sessions.delete(agent.session.id);
  });
  for (const agent of ctx.agents.list()) guarded(agent, "resume");
  ctx.effect(
    () => () => {
      for (const dispose of installed.values()) dispose();
      installed.clear();
      sessions.clear();
      pending.clear();
    },
    "rolesubagents: scoped tools"
  );
}
export {
  Config,
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
