#!/usr/bin/env node
/**
 * Optional installed-DSH integration: real Connection HTTP carrier + Typert Gateway + plugin probe.
 * Node >=22.19 (tested 22.23.4). No GUI, real CLI, inference, installed profile or production settings are used.
 * Only the HTTP listener, in-memory credential store, and subprocess boundary are fixtures.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire, registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { isolateCheckEnvironment } from './check-environment.mjs'
import { hostResolveHook } from './host-resolve-hook.mjs'

const checkout = resolve(process.env.DSH_CHECKOUT || '/usr/lib/node_modules/@deepseek-ai/dsh')
const isolated = isolateCheckEnvironment()
const hostRequire = createRequire(resolve(checkout, 'package.json'))
const hook = registerHooks(hostResolveHook(hostRequire))
let server
let ctx
let client
try {
  const { Context } = await import('@deepseek-ai/cordis')
  const Connection = await import('@deepseek-ai/dsh-client-connection')
  const { installConnection } = await import('@deepseek-ai/dsh-client-connection/client')
  const { default: Gateway } = await import('@deepseek-ai/dsh-api-gateway')
  const { default: Registry } = await import('@deepseek-ai/dsh-typert-registry')
  const { mountProbeService } = await import('../src/host/external/probe-service.ts')
  const { probeFailureOf } = await import('../src/client/controller.ts')
  const routes = new Map()
  const records = new Map()
  ctx = new Context()
  ctx.provide('credentials', {
    async modifyRecord(key, modify) {
      const next = await modify(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
  })
  ctx.provide('remoteAccess', { decide: () => ({ kind: 'deny', reason: 'test-owner-only' }) })
  ctx.provide('webServer', {
    host: '127.0.0.1',
    protocol: 'http:',
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
    registerUpgrade() {
      return () => {}
    },
  })
  new Registry(ctx)
  await Connection.apply(ctx, { trustedHosts: [] })
  const gatewayScope = ctx.plugin(Gateway, { websocketHeartbeatIntervalMs: 60000, streamInboxBytes: 1024 * 1024 })
  server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname
    if (pathname === '/') {
      if (ctx.connection.authorizeIndex(req, res)) {
        res.writeHead(200)
        res.end('integration fixture')
      }
      return
    }
    const route = [...routes.values()].find(route =>
      route.kind === 'exact'
        ? route.path === pathname
        : pathname === route.path || pathname.startsWith(`${route.path}/`),
    )
    if (!route) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    Promise.resolve(route.handler(req, res)).catch(() => {
      if (!res.headersSent) res.writeHead(500)
      res.end('fixture failure')
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  const login = await fetch(ctx.connection.authenticatedUrl(`${origin}/`), { redirect: 'manual' })
  assert.equal(login.status, 303)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  client = new Context()
  let wireMode = 'normal'
  installConnection(client, {
    transport: {
      fetch: (input, init) => {
        if (wireMode === 'malformed') return Promise.resolve(Response.json({ nope: true }))
        if (wireMode === 'transport') return Promise.reject(new TypeError('fetch failed'))
        return fetch(new URL(input, `${origin}/`), { ...init, headers: { ...init.headers, cookie } })
      },
    },
  })
  const call = () =>
    client.connection.rpc.call(
      '/api',
      'rolesubagentsCli/probe',
      { args: { request: { cli: 'codex' } } },
      AbortSignal.timeout(5000),
    )
  const invoke = (body = { args: { request: { cli: 'codex' } } }, headers = {}) =>
    fetch(`${origin}/api/rolesubagentsCli/probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'probe-check',
        method: 'rolesubagentsCli/probe',
        payload: body,
      }),
      signal: AbortSignal.timeout(5000),
    })
  const before = await invoke()
  assert.equal(before.status, 404, 'without Remote method, real Connection cannot claim endpoint')
  assert.equal(probeFailureOf(new Error('transport failure: HTTP 404')), 'endpoint-unavailable')
  await assert.rejects(call(), error => probeFailureOf(error) === 'endpoint-unavailable')
  let disposed = false
  let subprocess
  await mountProbeService(ctx, {
    subprocess: () => subprocess,
    adapters: () => ({ probe: async () => ({ auth: 'missing', version: 'fixture-1' }) }),
    cliSettings: () => undefined,
    isDisposed: () => disposed,
  })
  // Cordis installs service fibers asynchronously; flush its finite microtask queue, not time-based polling.
  for (let i = 0; i < 20; i++) await Promise.resolve()
  const unavailable = await invoke()
  assert.equal(unavailable.status, 200)
  const unavailableBody = Connection.serverResponseSchema.parse(await unavailable.json()).result
  assert.equal(unavailableBody.ok, true)
  assert.deepEqual(unavailableBody.value, { cli: 'codex', found: false, message: 'subprocess-unavailable' })
  assert.deepEqual(await call(), { ok: true, value: unavailableBody.value })
  console.log('PASS real client Connection → HTTP → Gateway → decorated probe returns subprocess-unavailable')
  subprocess = {
    resolveExecutable: async () => {
      throw new Error('fixture ENOENT')
    },
    spawn: () => {
      throw new Error('no subprocess permitted')
    },
  }
  assert.deepEqual(await call(), { ok: true, value: { cli: 'codex', found: false, message: 'not-found' } })
  subprocess.resolveExecutable = async () => '/fixture/codex'
  assert.deepEqual(await call(), {
    ok: true,
    value: { cli: 'codex', found: true, path: '/fixture/codex', auth: 'missing', version: 'fixture-1' },
  })
  console.log(
    'PASS CLI absent and CLI authentication missing are distinct successful diagnostic results (fixture subprocess/adapter)',
  )
  wireMode = 'malformed'
  await assert.rejects(call(), error => probeFailureOf(error) === 'malformed')
  wireMode = 'transport'
  await assert.rejects(call(), error => probeFailureOf(error) === 'transport')
  wireMode = 'normal'
  assert.equal((await call()).ok, true)
  console.log('PASS real client rejects malformed envelopes; transport failure remains retryable')
  const denied = await invoke(undefined, { cookie: '' })
  assert.equal(denied.status, 401)
  const forbidden = await invoke(undefined, { origin: 'https://untrusted.invalid' })
  assert.equal(forbidden.status, 403)
  assert.equal(probeFailureOf(new Error(`transport failure: HTTP ${denied.status}`)), 'host-auth')
  console.log('PASS real Connection authentication and Host/Origin fence (401/403)')
  const invalid = await invoke({ args: { wrong: { cli: 'codex' } } })
  assert.equal(invalid.status, 200)
  const invalidBody = Connection.serverResponseSchema.parse(await invalid.json()).result
  assert.equal(invalidBody.ok, false)
  assert.equal(invalidBody.error.code, 'gateway/arguments-invalid')
  console.log('PASS real Gateway validates argument names and returns structured Remote error')
  await gatewayScope.dispose()
  const noGateway = await invoke()
  assert.equal(noGateway.status, 404)
  console.log('PASS missing Gateway and missing Remote both produce ambiguous HTTP 404; no false attribution')
  disposed = true
  console.log(
    `PASS installed DSH ${hostRequire('./package.json').version}; isolated HOME/profile, no real CLI/model calls`,
  )
} finally {
  if (server) {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
  try {
    await client?.fiber.dispose()
    await ctx?.fiber.dispose()
  } finally {
    hook.deregister()
    isolated.dispose()
  }
}
