// Deterministic localhost-only Chat Completions backend for Grok/Pi real-binary checks.
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

export function startFakeChat(label) {
  const args = process.argv.slice(2)
  const logPath = args[args.indexOf('--log') + 1]
  const log = entry => {
    if (args.includes('--log')) appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
  }
  let sequence = 0
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', data => {
      raw += data
    })
    req.on('end', () => {
      let body
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        res.writeHead(400)
        res.end()
        return
      }
      log({ method: req.method, url: req.url, authorization: req.headers.authorization, body })
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model', owned_by: 'fake' }] }))
        return
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404)
        res.end()
        return
      }
      const textOf = content =>
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map(part => part.text ?? '').join('')
            : ''
      const messages = body.messages ?? []
      const task = textOf([...messages].reverse().find(message => message.role === 'user')?.content)
      const status = /\[\[http:(\d{3})\]\]/.exec(task)?.[1]
      if (status) {
        res.writeHead(Number(status), { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: `fake ${status} error`, type: 'fake_error', code: status } }))
        return
      }
      const id = `chatcmpl-${label}-${++sequence}`
      const model = body.model ?? 'fake-model'
      const chunk = (delta, finish = null) => ({
        id,
        object: 'chat.completion.chunk',
        created: 1,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
      const sse = data => res.write(`data: ${JSON.stringify(data)}\n\n`)
      const tool = /\[\[tool:([\w.-]+) (\{.*?\})\]\]/s.exec(task)
      const hasToolResult = messages.some(message => message.role === 'tool')
      const finish = task.includes('[[length]]') ? 'length' : tool && !hasToolResult ? 'tool_calls' : 'stop'
      const text = `${label.toUpperCase()}_FAKE_FINAL ✓${hasToolResult ? ' after tool' : ''}`
      const usage = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id,
            object: 'chat.completion',
            created: 1,
            model,
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finish }],
            usage,
          }),
        )
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      sse(chunk({ role: 'assistant', content: '' }))
      if (task.includes('[[slow]]')) {
        let ticks = 0
        const timer = setInterval(() => {
          sse(chunk({ content: `tick${++ticks} ` }))
        }, 100)
        res.on('close', () => {
          clearInterval(timer)
          log({ event: 'stream-closed' })
        })
        return
      }
      if (tool && !hasToolResult) {
        sse(chunk({ content: 'Intermediate commentary.' }))
        sse(
          chunk({
            tool_calls: [
              { index: 0, id: 'call_fake', type: 'function', function: { name: tool[1], arguments: tool[2] } },
            ],
          }),
        )
      } else {
        sse(chunk({ content: text.slice(0, 8) }))
        sse(chunk({ content: text.slice(8) }))
      }
      sse(chunk({}, finish))
      sse({ id, object: 'chat.completion.chunk', created: 1, model, choices: [], usage })
      res.end('data: [DONE]\n\n')
    })
  })
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    console.log(JSON.stringify({ listening: true, port, baseURL: `http://127.0.0.1:${port}/v1` }))
  })
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.on(signal, () => {
      server.closeAllConnections()
      server.close(() => process.exit(0))
    })
}
