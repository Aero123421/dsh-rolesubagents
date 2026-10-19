#!/usr/bin/env node
// Minimal deterministic OpenAI Chat Completions fake for driving `opencode` (via @ai-sdk/openai-compatible).
// Node >= 18, ESM, no dependencies. Used by scripts/check-cli/opencode.mjs (adapted from the OpenCode research).
//
// Usage:  node tests/support/fake-models/opencode.mjs [--port 0] [--log requests.jsonl]
//   Prints one JSON line to stdout once listening: {"listening":true,"port":N,"baseURL":"http://127.0.0.1:N/v1"}
//
// Endpoints:  GET /v1/models, POST /v1/chat/completions (stream and non-stream). Everything else -> 404.
//
// Behaviour is chosen from markers in the LAST user message of the request (and the request shape):
//   * request has no `tools` (e.g. opencode's title generator)      -> plain text "Fake title"
//   * [[tool:NAME {json-args}]]  first turn -> one tool call NAME(args); once a `tool` message is present
//                                -> final text "FAKE_FINAL after tool: <first 300 chars of the tool output>"
//                                (add [[pretext]] to also stream "Let me run that first." before the tool call)
//   * [[slow]]                   -> streams one chunk every 500 ms for ~60 s (for cancellation tests)
//   * [[http:CODE]]              -> HTTP error CODE with an OpenAI-style error body
//   * [[reasoning]]              -> emits `reasoning_content` deltas before the text
//   * otherwise                  -> "FAKE_FINAL: hello from the fake model"
// Every request is appended to the log as {ts, method, url, headers (authorization redacted to a prefix), body}.
import http from 'node:http'
import fs from 'node:fs'

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const port = Number(opt('port', process.env.FAKE_PORT ?? '0'))
const logPath = opt('log', process.env.FAKE_LOG ?? '')
const MODEL_IDS = (process.env.FAKE_MODELS ?? 'fake-model,fake-small').split(',')

function log(entry) {
  if (!logPath) return
  fs.appendFileSync(logPath, JSON.stringify(entry) + '\n')
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(p => (typeof p === 'string' ? p : (p.text ?? ''))).join('')
  return ''
}

function decide(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : []
  const lastUser = [...msgs].reverse().find(m => m.role === 'user')
  const userText = textOf(lastUser?.content)
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0
  const toolMsgs = msgs.filter(m => m.role === 'tool')
  if (!hasTools) return { kind: 'text', text: 'Fake title' }
  const http = userText.match(/\[\[http:(\d{3})\]\]/)
  if (http) return { kind: 'http', status: Number(http[1]) }
  if (userText.includes('[[slow]]')) return { kind: 'slow' }
  const tool = userText.match(/\[\[tool:([A-Za-z0-9_.-]+)\s+(\{.*?\})\]\]/s)
  if (tool) {
    if (toolMsgs.length === 0)
      return {
        kind: 'tool',
        name: tool[1],
        args: tool[2],
        pretext: userText.includes('[[pretext]]') ? 'Let me run that first.' : '',
      }
    const out = textOf(toolMsgs[toolMsgs.length - 1].content).slice(0, 300)
    return { kind: 'text', text: `FAKE_FINAL after tool: ${out}` }
  }
  return { kind: 'text', text: 'FAKE_FINAL: hello from the fake model', reasoning: userText.includes('[[reasoning]]') }
}

const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
let seq = 0

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`)
}

function chunk(id, model, delta, finish = null, extra = {}) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...extra,
  }
}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', d => (raw += d))
  req.on('end', async () => {
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      body = raw
    }
    const headers = { ...req.headers }
    if (headers.authorization) headers.authorization = headers.authorization.slice(0, 16) + '…'
    log({ ts: new Date().toISOString(), method: req.method, url: req.url, headers, body })

    const path = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && path.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({ object: 'list', data: MODEL_IDS.map(id => ({ id, object: 'model', owned_by: 'fake' })) }),
      )
    }
    if (req.method !== 'POST' || !path.endsWith('/chat/completions')) {
      res.writeHead(404, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ error: { message: `fake: no route ${req.method} ${path}` } }))
    }

    const d = decide(body ?? {})
    const id = `chatcmpl-fake-${++seq}`
    const model = body?.model ?? 'fake-model'
    if (d.kind === 'http') {
      res.writeHead(d.status, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({
          error: { message: `fake upstream error ${d.status}`, type: 'fake_error', code: String(d.status) },
        }),
      )
    }

    if (!body?.stream) {
      const message =
        d.kind === 'tool'
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: `call_${seq}`, type: 'function', function: { name: d.name, arguments: d.args } }],
            }
          : { role: 'assistant', content: d.kind === 'slow' ? 'slow' : d.text }
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(
        JSON.stringify({
          id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message, finish_reason: d.kind === 'tool' ? 'tool_calls' : 'stop' }],
          usage,
        }),
      )
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    sse(res, chunk(id, model, { role: 'assistant', content: '' }))
    if (d.kind === 'tool') {
      if (d.pretext) sse(res, chunk(id, model, { content: d.pretext }))
      sse(
        res,
        chunk(id, model, {
          tool_calls: [{ index: 0, id: `call_${seq}`, type: 'function', function: { name: d.name, arguments: '' } }],
        }),
      )
      sse(res, chunk(id, model, { tool_calls: [{ index: 0, function: { arguments: d.args } }] }))
      sse(res, chunk(id, model, {}, 'tool_calls'))
    } else if (d.kind === 'slow') {
      let closed = false
      res.on('close', () => (closed = true))
      for (let i = 0; i < 120 && !closed; i++) {
        sse(res, chunk(id, model, { content: `tick ${i} ` }))
        await new Promise(r => setTimeout(r, 500))
      }
      if (closed) {
        log({ ts: new Date().toISOString(), event: 'client_closed_stream', id })
        return
      }
      sse(res, chunk(id, model, {}, 'stop'))
    } else {
      if (d.reasoning) {
        sse(res, chunk(id, model, { reasoning_content: 'thinking about it' }))
      }
      const parts = d.text.match(/.{1,12}/gs) ?? ['']
      for (const p of parts) sse(res, chunk(id, model, { content: p }))
      sse(res, chunk(id, model, {}, 'stop'))
    }
    sse(res, { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage })
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

server.listen(port, '127.0.0.1', () => {
  const p = server.address().port
  process.stdout.write(JSON.stringify({ listening: true, port: p, baseURL: `http://127.0.0.1:${p}/v1` }) + '\n')
})
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)))
