/**
 * Model-only workflow defaults. A scope-local decorator preserves the official
 * workflow tool (including background jobs, schemas, cancellation and recording)
 * and supplies a lexical agent() adapter to its script. No DSH services are
 * monkey-patched, and no role is assigned to workflow children.
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { WorkflowModel } from '../shared/roles.ts'

/**
 * Adapt the documented agent() binding. Native validation still receives
 * explicit routes and invalid options, including accessors and symbol keys.
 * Plain input objects may originate in the host realm through `args`.
 */
export function workflowScript(script: string, model: WorkflowModel): string {
  const route = JSON.stringify({ provider: model.provider, model: model.model })
  return `return await ((agent) => (async () => {\n${script}\n})())(
    ((original) => (prompt, options) => {
      if (options === undefined) return original(prompt, ${route});
      let adapted = options;
      try {
        if (options !== null && typeof options === 'object') {
          const prototype = Object.getPrototypeOf(options);
          if (prototype === null || Object.getPrototypeOf(prototype) === null) {
            const descriptors = Object.getOwnPropertyDescriptors(options);
            if (!Object.hasOwn(descriptors, 'provider') && !Object.hasOwn(descriptors, 'model')) {
              for (const descriptor of Object.values(descriptors)) {
                if (descriptor.get !== undefined) descriptor.get = descriptor.get.bind(options);
              }
              adapted = Object.defineProperties(Object.create(prototype, descriptors),
                Object.getOwnPropertyDescriptors(${route}));
            }
          }
        }
      } catch (error) {
        // Native validation owns option failures, including throwing proxy traps.
      }
      return original(prompt, adapted);
    })(agent)
  );`
}

/** Keep the underlying tool when a child sees an already decorated definition. */
const originals = new WeakMap<ToolDefinition, ToolDefinition>()

export function workflowTool(
  tool: ToolDefinition,
  model: WorkflowModel,
  resolve?: () => ToolDefinition | undefined,
): ToolDefinition {
  const original = originals.get(tool) ?? tool
  const wrapped: ToolDefinition = {
    ...original,
    execute(args, exec) {
      const current = resolve === undefined ? original : resolve()
      if (current === undefined) throw new Error('workflow is no longer available in this agent scope')
      const target = originals.get(current) ?? current
      if (typeof args !== 'object' || args === null || !('script' in args) || typeof args.script !== 'string') {
        return target.execute(args, exec)
      }
      return target.execute({ ...args, script: workflowScript(args.script, model) }, exec)
    },
  }
  originals.set(wrapped, original)
  return wrapped
}
