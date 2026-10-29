/** Installed-Host harness adapters for the legacy and explicit-executor tool APIs. */
import assert from 'node:assert/strict'

/** Mount the installed runtime's real native executor without an obsolete mode setting. */
export async function mountNativeTools(ctx, ToolRuntime) {
  new ToolRuntime(ctx)
  if (typeof ctx.tools.setExecutor === 'function') {
    const native = await import('@deepseek-ai/dsh-tool-executor-native')
    await ctx.plugin(native)
  }
}

/** Dispatch one real tool call, retaining the runtime's guards and result validation. */
export async function executeHostTool(tools, input) {
  if (typeof tools.setExecutor !== 'function') return tools.execute(input)
  const { callId, name, arguments: args, ...context } = input
  const batch = await tools.execute({
    ...context,
    calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }],
  })
  assert.equal(batch.results.length, 1, 'single-call dispatch must settle exactly one result')
  assert.equal(batch.results[0].callId, callId, 'the settled result must belong to the requested call')
  return batch.results[0].result
}
