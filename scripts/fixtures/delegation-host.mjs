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
export const inject = ['llm', 'agents', 'subagents', 'compaction', 'storageDomain']

export function apply(ctx, config) {
  const record = entry => appendFileSync(config.recordPath, `${JSON.stringify(entry)}\n`)
  // Observe real native routing/storage; delegate every operation to the installed services.
  const resolveCallConfig = ctx.llm.resolveCallConfig.bind(ctx.llm)
  ctx.llm.resolveCallConfig = async (...args) => {
    record({ kind: 'resolve-call', config: args[0], ownsEffort: Object.hasOwn(args[0] ?? {}, 'reasoningEffort') })
    return resolveCallConfig(...args)
  }
  const open = ctx.storageDomain.open.bind(ctx.storageDomain)
  ctx.storageDomain.open = (...args) => {
    const domain = open(...args)
    if (args[0]?.name !== 'rolesubagents') return domain
    const observe = opened => {
      const table = opened.table.bind(opened)
      opened.table = name => {
        const original = table(name)
        const put = original.put.bind(original)
        original.put = (key, value) => {
          record({ kind: 'role-storage', table: name, key, value })
          return put(key, value)
        }
        return original
      }
      return opened
    }
    return domain instanceof Promise ? domain.then(observe) : observe(domain)
  }
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
      if (!['fixture-model', 'fixture-terra-max'].includes(model)) throw new Error(`fixture unknown model: ${model}`)
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
        if (task.includes('ROLE_E2E_OVERRIDES')) {
          const probes = [
            ['override-ok', { provider: 'roles-e2e', model: 'fixture-terra-max', readOnly: true }],
            ['override-effort', { provider: 'roles-e2e', model: 'fixture-terra-max', effort: 'high' }],
            ['override-bad-model', { provider: 'roles-e2e', model: 'missing-model' }],
            ['override-bad-effort', { provider: 'roles-e2e', model: 'fixture-terra-max', effort: 'impossible' }],
            ['override-half-route', { model: 'fixture-terra-max' }],
            ['override-downgrade', { readOnly: false }],
            ['override-unknown', { permission: 'danger-full-access' }],
            ['override-fork', { role: 'fork', provider: 'roles-e2e', model: 'fixture-terra-max' }],
          ]
          if (!hasCall(messages, 'delegate')) {
            yield* toolChunks(
              probes.map(([label, overrides]) => ({
                name: 'delegate',
                args: {
                  role: 'general',
                  description: label,
                  prompt: `ROLE_E2E_OVERRIDE_CHILD:${label}`,
                  ...overrides,
                },
              })),
            )
            return
          }
          for (const [label] of probes) {
            const call = calls(messages).find(
              entry => entry.name === 'delegate' && JSON.parse(entry.arguments).description === label,
            )
            const result = messages.find(message => message.role === 'tool' && message.toolCallId === call?.id)
            assert(result, `${label}: missing tool result`)
            const successful = label === 'override-ok' || label === 'override-effort'
            assert.equal(result.isError === true, !successful, `${label}: incorrect native admission`)
            if (successful) {
              assert.match(textOf(result), /Configured request: roles-e2e\/fixture-terra-max/)
              assert.match(textOf(result), /not confirmed by this start receipt/)
              if (label === 'override-ok') assert.match(textOf(result), /Read-only:/)
            } else assert.doesNotMatch(textOf(result), /started subagent/)
            record({ kind: 'override-receipt', label, text: textOf(result), error: result.isError === true })
          }
          if (!allText.includes('OVERRIDE_DONE:override-ok') || !allText.includes('OVERRIDE_DONE:override-effort')) {
            yield* textChunks('Waiting for override children.')
            return
          }
          if (
            !calls(messages).some(
              entry => entry.name === 'delegate' && JSON.parse(entry.arguments).description === 'override-baseline',
            )
          ) {
            yield* toolChunks([
              {
                name: 'delegate',
                args: {
                  role: 'general',
                  description: 'override-baseline',
                  prompt: 'ROLE_E2E_OVERRIDE_CHILD:override-baseline',
                },
              },
            ])
            return
          }
          yield* textChunks(
            allText.includes('OVERRIDE_DONE:override-baseline')
              ? 'ROLE_E2E_OVERRIDES_OK'
              : 'Waiting for baseline child.',
          )
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

      const override = /ROLE_E2E_OVERRIDE_CHILD:([a-z-]+)/.exec(userText)?.[1]
      if (override !== undefined) {
        assert(
          ['override-ok', 'override-effort', 'override-baseline'].includes(override),
          'rejected override must never spawn',
        )
        assert.equal(options.provider, 'roles-e2e')
        assert.equal(options.model, override === 'override-baseline' ? 'fixture-model' : 'fixture-terra-max')
        assert.equal(options.reasoningEffort, override === 'override-ok' ? 'low' : 'high')
        const modes = agent.session
          .snapshotEvents()
          .filter(event => event.type === 'sandbox/mode')
          .map(event => event.data.mode)
        if (override === 'override-ok') {
          assert.equal(modes.at(-1), 'read-only')
          assert.match(roleContext(messages), /This role is read-only/)
          if (!hasCall(messages, 'write')) {
            yield* toolChunks([
              { name: 'write', args: { file_path: config.deniedPath, content: 'Override must not write.' } },
            ])
            return
          }
          const writeCall = calls(messages).find(entry => entry.name === 'write')
          const result = messages.find(message => message.role === 'tool' && message.toolCallId === writeCall.id)
          assert.equal(result?.isError, true)
          assert.match(textOf(result), /read-only role/)
        } else assert.doesNotMatch(roleContext(messages), /This role is read-only/)
        record({
          kind: 'override-child',
          label: override,
          sessionId: agent.id,
          parentSession: agent.session.header.parentSession,
          effort: options.reasoningEffort,
          model: options.model,
          modes,
        })
        yield* textChunks(`OVERRIDE_DONE:${override}`)
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
