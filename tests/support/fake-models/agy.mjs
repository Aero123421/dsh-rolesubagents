#!/usr/bin/env node
/**
 * Fake Gemini API for driving the Antigravity CLI (`agy`) in GEMINI_API_KEY mode, for
 * `pnpm check:cli agy`. Node ESM, no dependencies. Adapted from the agy research fixture
 * (verified against agy 1.4.2).
 *
 * Usage: `node tests/support/fake-models/agy.mjs` → prints `{"port":<n>}` as its first stdout line.
 *
 * Point agy at it: env `GEMINI_API_KEY=<fake>`, `GOOGLE_GEMINI_BASE_URL=<url>`, `HTTPS_PROXY=<url>` and
 * `<HOME>/.gemini/antigravity-cli/settings.json = {"modelProvider":"gemini"}`. agy calls
 * `POST <base>/v1beta/models/<model>:streamGenerateContent?alt=sse` for every model step (plus a title side
 * request). The same port is a refusing HTTP(S) proxy: CONNECT and absolute-URI requests get 403 at once, so
 * agy's telemetry / feature-flag / updater traffic to Google hosts never leaves the machine and never stalls.
 *
 * `GET /__requests` returns a summary of every model request so far:
 * `[{ path, model, scenario, title, tools, system, user, generationConfig }]`.
 *
 * Behaviour is selected by a marker in the latest user text:
 *   [[scenario:text]]     (default) streamed answer "FAKE_ANSWER: ok (prompt=...)"
 *   [[scenario:write]]    write_to_file(<cwd>/fake_written.txt) (or [[target:/abs/path]]), then text
 *   [[scenario:replace]]  replace_file_content(<cwd>/README.md: "hello test" → "hello replaced"), then text
 *   [[scenario:command]]  run_command("echo FAKE_CMD > fake_cmd.txt"), then text
 *   [[scenario:read]]     view_file(<cwd>/README.md), then text
 *   [[scenario:preamble]] visible text + view_file in one message, then final text
 *   [[scenario:error400|error401|error403|error404|error429|error500|error503]]  HTTP error
 *   [[scenario:slow]]     one chunk, then waits 120 s (cancellation)
 *   [[scenario:partial]]  one chunk, then destroys the socket
 * After a tool result the server answers "FAKE_DONE tool=<name> result=<json, 400 chars>".
 */

import http from 'node:http'
import { pathToFileURL } from 'node:url'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function systemText(body) {
  return (body?.systemInstruction?.parts ?? []).map(part => part.text ?? '').join('\n')
}

function lastUserText(body) {
  const contents = body?.contents ?? []
  for (let i = contents.length - 1; i >= 0; i--) {
    const content = contents[i]
    if (content.role !== 'user') continue
    const texts = (content.parts ?? []).filter(part => typeof part.text === 'string').map(part => part.text)
    if (texts.length > 0) return texts.join('\n')
  }
  return ''
}

function lastFunctionResponse(body) {
  const contents = body?.contents ?? []
  const last = contents[contents.length - 1]
  return (last?.parts ?? []).find(part => part.functionResponse)?.functionResponse ?? null
}

function scenarioOf(body) {
  const match = /\[\[scenario:([a-z0-9_-]+)\]\]/i.exec(lastUserText(body))
  return match ? match[1].toLowerCase() : 'text'
}

function declaredTools(body) {
  return (body?.tools ?? []).flatMap(tool => (tool.functionDeclarations ?? []).map(fn => fn.name))
}

function isTitleRequest(body) {
  return /conversation title generator/i.test(systemText(body))
}

function workspaceOf(body) {
  const sys = systemText(body)
  const match = /Command Working Directory: (\S+)/.exec(sys) ?? /Active Workspaces:\n- (\S+)/.exec(sys)
  return match ? match[1].replace(/\/+$/, '') : process.cwd()
}

const usage = () => ({ promptTokenCount: 100, candidatesTokenCount: 10, totalTokenCount: 110, thoughtsTokenCount: 0 })

function textChunk(text, finish) {
  const candidate = { content: { role: 'model', parts: [{ text }] }, index: 0 }
  if (finish) candidate.finishReason = 'STOP'
  return { candidates: [candidate], usageMetadata: usage(), modelVersion: 'fake-gemini' }
}

function callChunk(name, args) {
  return {
    candidates: [
      { content: { role: 'model', parts: [{ functionCall: { name, args } }] }, finishReason: 'STOP', index: 0 },
    ],
    usageMetadata: usage(),
    modelVersion: 'fake-gemini',
  }
}

const meta = (action, summary) => ({ toolAction: action, toolSummary: summary })
const httpError = (code, status) => ({
  kind: 'error',
  status: code,
  body: { error: { code, message: `fake ${status.toLowerCase()}`, status } },
})

function plan(body) {
  if (isTitleRequest(body)) return { kind: 'chunks', chunks: [textChunk('Fake Title', true)] }
  const response = lastFunctionResponse(body)
  if (response) {
    const out = JSON.stringify(response.response ?? {}).slice(0, 400)
    return { kind: 'chunks', chunks: [textChunk(`FAKE_DONE tool=${response.name} result=${out}`, true)] }
  }
  const ws = workspaceOf(body)
  const one = (name, args) => ({ kind: 'chunks', chunks: [callChunk(name, args)] })
  switch (scenarioOf(body)) {
    case 'write': {
      const target = /\[\[target:([^\]]+)\]\]/.exec(lastUserText(body))?.[1] ?? `${ws}/fake_written.txt`
      return one('write_to_file', {
        TargetFile: target,
        CodeContent: 'written by fake model\n',
        Overwrite: false,
        Description: 'Create a test file',
        ...meta('Creating file', 'Test file'),
      })
    }
    case 'replace':
      return one('replace_file_content', {
        TargetFile: `${ws}/README.md`,
        Instruction: 'Replace the greeting',
        Description: 'Replace the greeting',
        AllowMultiple: false,
        TargetContent: 'hello test',
        ReplacementContent: 'hello replaced',
        StartLine: 1,
        EndLine: 3,
        ...meta('Editing file', 'Greeting edit'),
      })
    case 'command':
      return one('run_command', {
        CommandLine: 'echo FAKE_CMD > fake_cmd.txt',
        Cwd: ws,
        WaitMsBeforeAsync: 5000,
        ...meta('Running command', 'Echo test'),
      })
    case 'read':
      return one('view_file', { AbsolutePath: `${ws}/README.md`, ...meta('Reading file', 'Readme') })
    case 'preamble':
      return {
        kind: 'chunks',
        chunks: [
          textChunk('FAKE_PREAMBLE_TEXT '),
          callChunk('view_file', { AbsolutePath: `${ws}/README.md`, ...meta('Reading file', 'Readme') }),
        ],
      }
    case 'error400':
      return httpError(400, 'INVALID_ARGUMENT')
    case 'error401':
      return httpError(401, 'UNAUTHENTICATED')
    case 'error403':
      return httpError(403, 'PERMISSION_DENIED')
    case 'error404':
      return httpError(404, 'NOT_FOUND')
    case 'error429':
      return httpError(429, 'RESOURCE_EXHAUSTED')
    case 'error500':
      return httpError(500, 'INTERNAL')
    case 'error503':
      return httpError(503, 'UNAVAILABLE')
    case 'slow':
      return { kind: 'slow' }
    case 'partial':
      return { kind: 'partial' }
    default: {
      const text = lastUserText(body).replace(/\s+/g, ' ').slice(0, 60)
      return {
        kind: 'chunks',
        chunks: [textChunk('FAKE_ANSWER: '), textChunk('ok'), textChunk(` (prompt="${text}")`, true)],
      }
    }
  }
}

async function generate(res, body) {
  const step = plan(body)
  if (step.kind === 'error') {
    res.writeHead(step.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(step.body))
    return
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const send = chunk => res.write(`data: ${JSON.stringify(chunk)}\r\n\r\n`)
  if (step.kind === 'slow') {
    send(textChunk('FAKE_SLOW_START '))
    const timer = setTimeout(() => {
      send(textChunk('FAKE_SLOW_END', true))
      res.end()
    }, 120_000)
    res.on('close', () => clearTimeout(timer))
    return
  }
  if (step.kind === 'partial') {
    send(textChunk('FAKE_PARTIAL_TEXT '))
    await sleep(100)
    res.socket?.destroy()
    return
  }
  for (const chunk of step.chunks) {
    send(chunk)
    await sleep(20)
  }
  res.end()
}

/**
 * Start the fake server.
 * @param port - port to listen on (0 = any).
 * @returns `{ port, url, requests, close }`.
 */
export function startFakeAgyModel(port = 0) {
  const requests = []
  const server = http.createServer(async (req, res) => {
    const raw = await new Promise(resolve => {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })
    if (/^https?:\/\//.test(req.url ?? '')) {
      res.writeHead(403)
      res.end('blocked by the fake model proxy')
      return
    }
    const url = new URL(req.url ?? '/', 'http://x')
    if (req.method === 'GET' && url.pathname === '/__requests') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(requests))
      return
    }
    let body = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {}
    const route =
      /^(?:\/.*)?\/(v1beta|v1|v1alpha)\/models\/([^/:]+):(generateContent|streamGenerateContent|countTokens)$/.exec(
        url.pathname,
      )
    if (req.method === 'POST' && route && body) {
      requests.push({
        path: url.pathname,
        model: route[2],
        scenario: scenarioOf(body),
        title: isTitleRequest(body),
        tools: declaredTools(body),
        system: systemText(body),
        user: lastUserText(body),
        generationConfig: body.generationConfig ?? null,
      })
      if (route[3] === 'countTokens') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ totalTokens: Math.ceil(raw.length / 4) }))
        return
      }
      await generate(res, body)
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { code: 404, message: 'no route', status: 'NOT_FOUND' } }))
  })
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n'))
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port
      resolve({
        port: actual,
        url: `http://127.0.0.1:${actual}`,
        requests,
        close: () =>
          new Promise(done => {
            server.closeAllConnections?.()
            server.close(() => done())
          }),
      })
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fake = await startFakeAgyModel(Number(process.env.FAKE_AGY_PORT ?? 0))
  process.stdout.write(`${JSON.stringify({ port: fake.port })}\n`)
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => fake.close().then(() => process.exit(0)))
}
