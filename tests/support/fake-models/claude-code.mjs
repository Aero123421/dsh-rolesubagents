#!/usr/bin/env node
/**
 * Deterministic Anthropic Messages API fake for driving the real `claude` CLI
 * (Claude Code 2.1.x) in `pnpm check:cli claude-code`. Node ESM, no dependencies.
 *
 *   node claude-code.mjs [--script steps.json] [--log requests.jsonl] [--default-text TEXT]
 *
 * Prints `{"port":<n>}` as its first stdout line once bound to 127.0.0.1.
 *
 * Steps are consumed in order by "main" requests (streamed and/or tool-bearing:
 * the agent loop). Side requests (non-streaming without tools, e.g. the auto-mode
 * classifier) and requests after the script ran out get `defaultText`. Other paths
 * (the CLI's `HEAD /api/hello` probe) get 404, which the CLI ignores. Every request
 * is appended to the log as one JSON line `{ method, url, headers, main, body }`.
 *
 * Step shapes:
 *   { "text": "final answer" }                          end_turn text
 *   { "tool_use": { "name", "input", "id"? }, "text"? }  stop_reason tool_use
 *   { "hold": true }                                    never answer (until the client goes away)
 *   { "status": 401, "error": { "type", "message" } }   HTTP error
 *   { "delayMs": 500, ... }                             wait first
 *   { "sticky": true, ... }                             never consumed
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'

const args = process.argv.slice(2)
const option = name => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const scriptPath = option('--script')
const logFile = option('--log')
const defaultText = option('--default-text') ?? 'FAKE_DEFAULT_REPLY'
const steps = scriptPath ? JSON.parse(readFileSync(scriptPath, 'utf8')) : []

let counter = 0
let mainIndex = 0
const held = new Set()

const usage = () => ({ input_tokens: 11, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })

function blocksOf(step) {
  const blocks = []
  if (step.text) blocks.push({ type: 'text', text: step.text })
  if (step.tool_use) {
    blocks.push({
      type: 'tool_use',
      id: step.tool_use.id ?? `toolu_fake_${String(++counter).padStart(4, '0')}`,
      name: step.tool_use.name,
      input: step.tool_use.input ?? {},
    })
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' })
  return blocks
}

function sse(res, type, payload) {
  res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
}

function writeStreaming(res, body, step) {
  const model = typeof body.model === 'string' ? body.model : 'fake-model'
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'request-id': `req_${++counter}`,
  })
  sse(res, 'message_start', {
    type: 'message_start',
    message: {
      id: `msg_fake_${++counter}`,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: usage(),
    },
  })
  blocksOf(step).forEach((block, index) => {
    if (block.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: block.text },
      })
    } else {
      sse(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      })
      sse(res, 'content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
      })
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index })
  })
  sse(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: step.tool_use ? 'tool_use' : 'end_turn', stop_sequence: null },
    usage: { output_tokens: 5 },
  })
  sse(res, 'message_stop', { type: 'message_stop' })
  res.end()
}

function writeJson(res, body, step) {
  res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_${++counter}` })
  res.end(
    JSON.stringify({
      id: `msg_fake_${++counter}`,
      type: 'message',
      role: 'assistant',
      model: typeof body.model === 'string' ? body.model : 'fake-model',
      content: blocksOf(step),
      stop_reason: step.tool_use ? 'tool_use' : 'end_turn',
      stop_sequence: null,
      usage: { ...usage(), output_tokens: 5 },
    }),
  )
}

const isMain = body => body.stream === true || (Array.isArray(body.tools) && body.tools.length > 0)

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = {}
    try {
      body = raw ? JSON.parse(raw) : {}
    } catch {
      body = { unparsed: raw.slice(0, 2000) }
    }
    const url = req.url ?? ''
    const messages = req.method === 'POST' && /^\/v1\/messages(\?|$)/.test(url)
    const main = messages && isMain(body)
    let step
    if (main && mainIndex < steps.length) {
      step = steps[mainIndex]
      if (!step.sticky) mainIndex++
    }
    if (logFile)
      appendFileSync(logFile, JSON.stringify({ method: req.method, url, headers: req.headers, main, body }) + '\n')
    if (url.startsWith('/v1/messages/count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ input_tokens: 42 }))
      return
    }
    if (!messages) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fake: not found' } }))
      return
    }
    const current = step ?? { text: defaultText }
    if (current.delayMs) await new Promise(resolve => setTimeout(resolve, current.delayMs))
    if (current.hold) {
      held.add(res)
      res.on('close', () => held.delete(res))
      return
    }
    if (current.status) {
      res.writeHead(current.status, { 'content-type': 'application/json', 'request-id': 'req_fake_err' })
      res.end(JSON.stringify({ type: 'error', error: current.error ?? { type: 'api_error', message: 'fake error' } }))
      return
    }
    if (body.stream) writeStreaming(res, body, current)
    else writeJson(res, body, current)
  })
})

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`)
})

const stop = () => {
  for (const res of held) res.destroy()
  server.closeAllConnections?.()
  server.close(() => process.exit(0))
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
