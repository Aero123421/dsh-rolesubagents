/** Keyless scripted adapter exercising real native delegation, recovery, and continuation. */
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'

const ROLES = ['general', 'reviewer', 'fork', 'task-fork', 'model-default']
const HIGH = ReasoningEffortId('high')
const LOW = ReasoningEffortId('low')
let nextCall = 0
const callPrefix = randomUUID()

function textOf(message) {
  return (
    message?.content
      ?.filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n') ?? ''
  )
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function toolChunks(specs) {
  return [
    ...specs.flatMap((spec, index) => {
      const id = ToolCallId(`role-smoke-${callPrefix}-${++nextCall}`)
      const args = JSON.stringify(spec.args)
      return [
        { type: 'block-start', index, blockType: 'tool-call' },
        { type: 'tool-call-delta', index, id, name: spec.name, argumentsDelta: args },
        { type: 'block-end', index, block: { type: 'tool-call', id, name: spec.name, arguments: args } },
      ]
    }),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

function calls(messages) {
  return messages.flatMap(message =>
    message.role === 'assistant' ? message.content.filter(block => block.type === 'tool-call') : [],
  )
}

function hasCall(messages, name, messageText) {
  return calls(messages).some(
    call => call.name === name && (messageText === undefined || JSON.parse(call.arguments).message === messageText),
  )
}

function roleContext(messages) {
  return (
    messages
      .findLast(message => message.source?.kind === 'runtime-context')
      ?.source.sections?.find(section => section.name === 'rolesubagents:role')?.text ?? ''
  )
}

function roleOf(messages) {
  return /ROLE_E2E:([a-z-]+)/.exec(roleContext(messages))?.[1]
}

function childId(messages, role) {
  const call = calls(messages).find(entry => entry.name === 'delegate' && JSON.parse(entry.arguments).role === role)
  const result = messages.find(message => message.role === 'tool' && message.toolCallId === call?.id)
  return /started subagent ([\w-]+)/.exec(textOf(result))?.[1]
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export const name = 'rolesubagents-native-smoke'
export const inject = ['llm', 'agents', 'subagents', 'compaction']

export function apply(ctx, config) {
  const record = entry => appendFileSync(config.recordPath, `${JSON.stringify(entry)}\n`)
  const repinned = new Set()
  const overflowed = new Set()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
      record({ kind: 'agent-error', sessionId: session.id, error: event.data.reason.error })
    }
    if (event.type === 'compaction/summary') {
      record({ kind: 'compacted', sessionId: session.id, shadowed: event.data.shadowedSeqs.length })
    }
  })

  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        context: { contextWindow: 100000 },
        reasoning: {
          efforts: [
            { id: LOW, name: 'Low' },
            { id: HIGH, name: 'High' },
          ],
          defaultEffort: LOW,
        },
      }
    }

    async *stream(options) {
      options.signal?.throwIfAborted()
      if (options.purpose === 'compaction') {
        record({ kind: 'summary', sessionId: options.sessionId })
        yield* textChunks(
          'The assigned review completed. The write attempt was refused. Continue with the next request.',
        )
        return
      }
      assert.equal(options.purpose, undefined, 'only conversation and compaction calls are expected')
      const agent = ctx.agents.get(options.sessionId)
      assert(agent, 'the adapter must run through a real live Agent')
      const messages = options.messages
      const role = roleOf(messages)
      const isChild = agent.session.header.parentSession !== undefined
      if (isChild) assert(role, 'the child must receive its recorded role instructions')
      const userText = messages
        .filter(message => message.role === 'user' && message.source?.kind === 'user')
        .map(textOf)
        .join('\n')
      const allText = messages.map(textOf).join('\n')
      const latestMessage = textOf(messages.findLast(message => message.source?.kind === 'agent-message'))
      const phase = latestMessage.includes('ROLE_E2E_COLD_FOLLOWUP')
        ? 'COLD'
        : latestMessage.includes('ROLE_E2E_WARM_FOLLOWUP')
          ? 'WARM'
          : undefined
      record({
        kind: 'request',
        instance: callPrefix,
        sessionId: agent.id,
        parentSession: agent.session.header.parentSession,
        role,
        phase,
        effort: options.reasoningEffort,
        roleContext: roleContext(messages),
        hasCompletedParent: userText.includes('PARENT_COMPLETED_CONTEXT_94'),
        hasCurrentParent: userText.includes('PARENT_CURRENT_CONTEXT_57'),
        hasCompaction: messages.some(message => message.source?.kind === 'compact-checkpoint'),
        systemHash: hash(messages.filter(message => message.role === 'system').map(textOf)),
        toolsHash: hash(options.tools),
      })

      if (!isChild) {
        const task = textOf(messages.findLast(message => message.source?.kind === 'user'))
        if (task.includes('PARENT_COMPLETED_CONTEXT_94') && !task.includes('PARENT_CURRENT_CONTEXT_57')) {
          yield* textChunks('Completed parent context recorded.')
          return
        }
        const reviewer = childId(messages, 'reviewer')
        if (task.includes('ROLE_E2E_COLD_FOLLOWUP')) {
          assert(reviewer, 'the resumed parent must retain its reviewer receipt')
          if (!hasCall(messages, 'send_message', 'ROLE_E2E_COLD_FOLLOWUP')) {
            yield* toolChunks([
              { name: 'send_message', args: { agent_id: reviewer, message: 'ROLE_E2E_COLD_FOLLOWUP' } },
            ])
            return
          }
          yield* textChunks(
            allText.includes('ROLE_E2E_COLD_DONE') ? 'ROLE_E2E_COLD_OK' : 'Waiting for the reviewer response.',
          )
          return
        }
        if (!hasCall(messages, 'delegate')) {
          yield* toolChunks(
            ROLES.map(role => ({
              name: 'delegate',
              args: {
                role,
                description: `${role} native probe`,
                prompt: `ROLE_E2E_TASK:${role}\n${'Review the provided deterministic material. '.repeat(35)}`,
              },
            })),
          )
          return
        }
        const settlements = messages.filter(message => message.source?.kind === 'subagent-settled')
        if (ROLES.some(role => !allText.includes(`ROLE_E2E_DONE:${role}`)) || settlements.length < ROLES.length) {
          yield* textChunks('Delegations accepted; waiting for their results.')
          return
        }
        assert(reviewer)
        if (!hasCall(messages, 'send_message', 'ROLE_E2E_WARM_FOLLOWUP')) {
          yield* toolChunks([{ name: 'send_message', args: { agent_id: reviewer, message: 'ROLE_E2E_WARM_FOLLOWUP' } }])
          return
        }
        yield* textChunks(
          allText.includes('ROLE_E2E_WARM_DONE')
            ? 'ROLE_E2E_NATIVE_OK'
            : 'Waiting for the compacted reviewer response.',
        )
        return
      }

      const expectedEffort = role === 'model-default' ? 'low' : 'high'
      assert.equal(options.reasoningEffort, expectedEffort, `${role} must use its declared reasoning selection`)
      if (role === 'reviewer' && !repinned.has(agent.id)) {
        agent.session.append('sandbox/mode', { mode: 'workspace-write' })
        // Native Session forbids reentrant append inside its publication. The
        // plugin repairs the policy after that publication has returned.
        await Promise.resolve()
        const modes = agent.session
          .snapshotEvents()
          .filter(event => event.type === 'sandbox/mode')
          .map(event => event.data.mode)
        assert.equal(modes.at(-1), 'read-only', 'the actual session listener must re-pin the reviewer')
        repinned.add(agent.id)
        record({ kind: 'repin', sessionId: agent.id, modes })
      }

      if (phase !== undefined) {
        assert.equal(role, 'reviewer')
        const content = `This ${phase} follow-up must never be written.`
        const writeCall = calls(messages).find(
          call => call.name === 'write' && JSON.parse(call.arguments).content === content,
        )
        if (writeCall === undefined) {
          yield* toolChunks([{ name: 'write', args: { file_path: config.deniedPath, content } }])
          return
        }
        const writeResult = messages.find(message => message.role === 'tool' && message.toolCallId === writeCall.id)
        assert.equal(writeResult?.isError, true, `${phase}: the resumed reviewer must still refuse native writes`)
        assert.match(textOf(writeResult), /read-only role/)
        record({ kind: 'write-refused', sessionId: agent.id, phase, text: textOf(writeResult) })
        const response = `ROLE_E2E_${phase}_DONE`
        if (!hasCall(messages, 'send_message', response)) {
          yield* toolChunks([
            { name: 'send_message', args: { agent_id: agent.session.header.parentSession, message: response } },
          ])
          return
        }
        yield* textChunks(response)
        return
      }
      if (role === 'reviewer' && !hasCall(messages, 'write')) {
        yield* toolChunks([
          { name: 'write', args: { file_path: config.deniedPath, content: 'This must never be written.' } },
        ])
        return
      }
      if (role === 'reviewer') {
        const writeCall = calls(messages).find(call => call.name === 'write')
        const result = messages.find(message => message.role === 'tool' && message.toolCallId === writeCall.id)
        assert.equal(result?.isError, true, 'native tool dispatch must refuse the reviewer write')
        assert.match(textOf(result), /read-only role/)
        record({ kind: 'write-refused', sessionId: agent.id, text: textOf(result) })
        if (!overflowed.has(agent.id)) {
          // The real request-error middleware must compact useful history and
          // retry. No fixture edits the transcript or substitutes a compactor.
          overflowed.add(agent.id)
          record({ kind: 'overflow', sessionId: agent.id })
          yield {
            type: 'finish',
            reason: {
              kind: 'error',
              failure: { code: CONTEXT_WINDOW_EXCEEDED_CODE, message: 'Deterministic context overflow probe.' },
            },
          }
          return
        }
      }
      const response = `ROLE_E2E_DONE:${role}`
      if (!hasCall(messages, 'send_message', response)) {
        yield* toolChunks([
          { name: 'send_message', args: { agent_id: agent.session.header.parentSession, message: response } },
        ])
        return
      }
      yield* textChunks(response)
    }
  }

  ctx.llm.registerAdapter(['roles-e2e'], new Adapter())
  ctx.on('agent/request', async ({ agent }, next) => {
    const proposal = await next()
    return agent.session.header.parentSession === undefined ? { ...proposal, reasoningEffort: HIGH } : proposal
  })
}
