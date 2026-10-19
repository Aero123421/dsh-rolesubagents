#!/usr/bin/env node
// Minimal deterministic OpenAI Responses API fake for driving the real `codex` CLI
// (exec or app-server) in tests. Node >= 18, ESM, no dependencies.
//
// Usage (CLI):
//   node tests/support/fake-models/codex.mjs [--port 0] [--script script.json] [--log requests.jsonl]
//   -> prints one line `{"baseUrl":"http://127.0.0.1:PORT/v1","port":PORT}` on stdout once listening
//   (the shape `h.server` in scripts/check-cli.mjs expects). `--log` appends one JSON line per request.
//
// Usage (library):
//   import { startFakeResponses } from './codex.mjs'
//   const fake = await startFakeResponses([{ kind: 'complete', text: 'DONE' }])
//   ... fake.baseUrl, fake.requests (parsed bodies + headers), await fake.close()
//
// Script = array of behaviors, one consumed per POST /v1/responses:
//   { "kind": "complete", "text": "..." }                     final assistant message
//   { "kind": "tool", "name": "exec_command", "arguments": {...} }   one function call
//   { "kind": "tool", "prefer": [{name, arguments}, ...] }    first one whose name is advertised in body.tools
//   { "kind": "custom", "name": "apply_patch", "input": "*** Begin Patch..." }  freeform (custom) tool call
//   { "kind": "error", "status": 401, "body": {...} }         plain HTTP error (JSON body)
//   { "kind": "failed", "code": "...", "message": "..." }     SSE response.failed event
//   { "kind": "hold" }                                        200 + SSE headers, never finishes
//   { "kind": "items", "items": [ {"message": "text", "phase": "commentary"|"final_answer"},
//                                 {"tool": "exec_command", "arguments": {...}} ] }  several output items in one response
// Any behavior may carry "delayMs": N to wait before streaming its events.
// When the script is exhausted the server answers { kind: "complete", text: "FAKE_EXHAUSTED" }.
// A behavior may carry "match": "<substring>" -> it is only used when the latest user text
// contains that substring (otherwise the next unmatched behavior is used).
//
// GET /v1/models returns a tiny OpenAI-style model list (some Codex paths probe it).

import { createServer } from 'node:http'
import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

let seq = 0
const id = p => `${p}_${++seq}`

function baseResponse(model, output, status = 'completed') {
  return {
    id: id('resp'),
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status,
    error: null,
    incomplete_details: null,
    instructions: null,
    model: model ?? 'fake-model',
    output,
    parallel_tool_calls: false,
    tool_choice: 'auto',
    tools: [],
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    },
    metadata: {},
  }
}

export function completeEvents(text, model) {
  const msg = {
    id: id('msg'),
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', annotations: [], text }],
  }
  const done = baseResponse(model, [msg])
  return [
    { type: 'response.created', response: { ...done, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...msg, status: 'in_progress', content: [] } },
    {
      type: 'response.content_part.added',
      item_id: msg.id,
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', annotations: [], text: '' },
    },
    { type: 'response.output_text.delta', item_id: msg.id, output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', item_id: msg.id, output_index: 0, content_index: 0, text },
    { type: 'response.content_part.done', item_id: msg.id, output_index: 0, content_index: 0, part: msg.content[0] },
    { type: 'response.output_item.done', output_index: 0, item: msg },
    { type: 'response.completed', response: done },
  ]
}

export function functionCallEvents(name, args, model) {
  const argText = typeof args === 'string' ? args : JSON.stringify(args)
  const item = {
    id: id('fc'),
    type: 'function_call',
    status: 'completed',
    name,
    arguments: argText,
    call_id: id('call'),
  }
  const done = baseResponse(model, [item])
  return [
    { type: 'response.created', response: { ...done, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: 0, delta: argText },
    { type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: argText },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: done },
  ]
}

export function customToolCallEvents(name, input, model) {
  const item = { id: id('ctc'), type: 'custom_tool_call', status: 'completed', name, input, call_id: id('call') }
  const done = baseResponse(model, [item])
  return [
    { type: 'response.created', response: { ...done, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', input: '' } },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: done },
  ]
}

export function itemsEvents(items, model) {
  const out = []
  const events = []
  items.forEach((spec, index) => {
    let item
    if (spec.message !== undefined) {
      item = {
        id: id('msg'),
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', annotations: [], text: spec.message }],
      }
      if (spec.phase !== undefined) item.phase = spec.phase
      events.push({
        type: 'response.output_item.added',
        output_index: index,
        item: { ...item, status: 'in_progress', content: [] },
      })
      events.push({
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: index,
        content_index: 0,
        delta: spec.message,
      })
    } else {
      const argText = JSON.stringify(spec.arguments ?? {})
      item = {
        id: id('fc'),
        type: 'function_call',
        status: 'completed',
        name: spec.tool,
        arguments: argText,
        call_id: id('call'),
      }
      events.push({
        type: 'response.output_item.added',
        output_index: index,
        item: { ...item, status: 'in_progress', arguments: '' },
      })
    }
    events.push({ type: 'response.output_item.done', output_index: index, item })
    out.push(item)
  })
  const done = baseResponse(model, out)
  return [
    { type: 'response.created', response: { ...done, status: 'in_progress', output: [] } },
    ...events,
    { type: 'response.completed', response: done },
  ]
}

function failedEvents(code, message, model) {
  const r = baseResponse(model, [], 'failed')
  r.error = { code, message }
  return [
    { type: 'response.created', response: { ...r, status: 'in_progress', error: null } },
    { type: 'response.failed', response: r },
  ]
}

function toolNames(body) {
  const names = new Set()
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    if (t && typeof t.name === 'string') names.add(t.name)
  }
  return names
}

export function lastUserText(body) {
  const input = Array.isArray(body.input) ? body.input : []
  for (let i = input.length - 1; i >= 0; i--) {
    const it = input[i]
    if (it?.role === 'user' && Array.isArray(it.content)) {
      return it.content.map(c => (typeof c?.text === 'string' ? c.text : '')).join('\n')
    }
  }
  return ''
}

/**
 * Start the fake. `script` is an array of behaviors (see header).
 * @returns {Promise<{baseUrl:string, port:number, requests:object[], close:()=>Promise<void>}>}
 */
export async function startFakeResponses(script = [], { port = 0, log } = {}) {
  const queue = [...script]
  const requests = []
  const open = new Set()
  const server = createServer((req, res) => {
    open.add(res)
    res.on('close', () => open.delete(res))
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', c => {
      raw += c
    })
    req.on('end', () => {
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        body = { _unparsed: raw }
      }
      const record = { method: req.method, url: req.url, headers: req.headers, body }
      requests.push(record)
      if (log) appendFileSync(log, JSON.stringify(record) + '\n')

      if (req.method === 'GET' && /\/models(\?|$)/.test(req.url ?? '')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            object: 'list',
            data: [{ id: 'fake-model', object: 'model', created: 0, owned_by: 'fake' }],
          }),
        )
        return
      }
      if (req.method !== 'POST' || !/\/responses$/.test((req.url ?? '').split('?')[0])) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `fake: no route ${req.method} ${req.url}` } }))
        return
      }
      const user = lastUserText(body)
      const idx = queue.findIndex(b => b.match === undefined || user.includes(b.match))
      const b = idx >= 0 ? queue.splice(idx, 1)[0] : { kind: 'complete', text: 'FAKE_EXHAUSTED' }
      if (b.kind === 'error') {
        res.writeHead(b.status ?? 500, { 'content-type': 'application/json', ...(b.headers ?? {}) })
        res.end(
          JSON.stringify(
            b.body ?? {
              error: { message: b.message ?? 'fake error', type: b.type ?? 'fake_error', code: b.code ?? null },
            },
          ),
        )
        return
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-request-id': id('req'),
      })
      if (b.kind === 'hold') return
      let events
      if (b.kind === 'complete') events = completeEvents(b.text, body.model)
      else if (b.kind === 'failed')
        events = failedEvents(b.code ?? 'server_error', b.message ?? 'fake failure', body.model)
      else if (b.kind === 'items') events = itemsEvents(b.items, body.model)
      else if (b.kind === 'custom') events = customToolCallEvents(b.name, b.input, body.model)
      else if (b.kind === 'tool') {
        let choice = b
        if (Array.isArray(b.prefer)) {
          const adv = toolNames(body)
          choice = b.prefer.find(c => adv.has(c.name))
          if (!choice) {
            events = completeEvents(`FAKE_NO_ADVERTISED_TOOL among ${[...adv].join(',')}`, body.model)
          }
        }
        if (!events) {
          events = choice.custom
            ? customToolCallEvents(choice.name, choice.input, body.model)
            : functionCallEvents(choice.name, choice.arguments ?? {}, body.model)
        }
      } else events = completeEvents(`FAKE_UNKNOWN_BEHAVIOR ${b.kind}`, body.model)
      const flush = () => {
        for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
        res.end()
      }
      if (b.delayMs) setTimeout(flush, b.delayMs)
      else flush()
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const actual = server.address().port
  return {
    baseUrl: `http://127.0.0.1:${actual}/v1`,
    port: actual,
    requests,
    async close() {
      for (const r of open) r.destroy()
      server.closeAllConnections?.()
      await new Promise(r => server.close(() => r()))
    },
  }
}

// CLI entry
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const opt = (n, d) => {
    const i = args.indexOf(n)
    return i >= 0 ? args[i + 1] : d
  }
  const scriptPath = opt('--script')
  const script = scriptPath ? JSON.parse(readFileSync(scriptPath, 'utf8')) : []
  const fake = await startFakeResponses(script, { port: Number(opt('--port', '0')), log: opt('--log') })
  process.stdout.write(JSON.stringify({ baseUrl: fake.baseUrl, port: fake.port }) + '\n')
  const stop = () => {
    fake.close().finally(() => process.exit(0))
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}
