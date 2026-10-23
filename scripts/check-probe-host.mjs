#!/usr/bin/env node
/**
 * Optional installed-DSH integration: real Connection HTTP + Typert Gateway + probe, role-write safety and role display.
 * Node >=22.19 (tested 22.23.4). No GUI, real CLI, inference, installed profile or production settings are used.
 * HTTP listener, in-memory owner credentials, subprocess boundary and read-only role-safety settings are fixtures.
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
  const { mountManagementRemote } = await import('../src/host/management/remote.ts')
  const { mountRoleDisplayService } = await import('../src/host/role-display-service.ts')
  const { roleDisplayCaller } = await import('../src/client/role-display.ts')
  const { managementSettings } = await import('../src/host/management/settings.ts')
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
  console.log(`FIXTURE loopback HTTP: ${origin}`)
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

  // Production writeSafety wire contract: one named `request` parameter, independent of the AI gate.
  const safetyEndpoint = 'rolesubagentsManagement/writeSafety'
  const safetyRevision = 41
  let safetyDisposed = false
  let safetyAvailable = true
  let rawRoles = { roles: [] }
  const safetyReader = managementSettings({
    namespace: () => (safetyAvailable ? 'rolesubagents' : undefined),
    rawConfig: () => rawRoles,
    settings: () => ({
      writable: true,
      describe: () => [
        { ns: 'rolesubagents', revision: safetyRevision, value: { allowAiRoleManagement: false, roles: [] } },
      ],
      mutate: () => {
        throw new Error('Read-only safety RPC must never mutate settings')
      },
    }),
  })
  const safetyCall = (request = { expectedRevision: safetyRevision }) =>
    client.connection.rpc.call('/api', safetyEndpoint, { args: { request } }, AbortSignal.timeout(5000))
  const safetyInvoke = (request = { expectedRevision: safetyRevision }, headers = {}) =>
    fetch(`${origin}/api/${safetyEndpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'role-safety-check',
        method: safetyEndpoint,
        payload: { args: { request } },
      }),
      signal: AbortSignal.timeout(5000),
    })
  await assert.rejects(safetyCall(), error => probeFailureOf(error) === 'endpoint-unavailable')
  await mountManagementRemote(ctx, {
    writeSafety: revision => safetyReader.writeSafety(revision),
    isDisposed: () => safetyDisposed,
  })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  const safetyService = ctx.get('rolesubagentsManagement')
  assert(safetyService, 'actual source Remote service must be published')
  const safetyRuntime = [...ctx.registry.values()].find(
    runtime =>
      runtime.name === 'RolesubagentsManagementService' || runtime.callback.name === 'RolesubagentsManagementService',
  )
  const safetyFiber = safetyRuntime && [...safetyRuntime.fibers][0]
  assert(safetyFiber, 'actual source Remote service must have a disposable plugin fiber')
  const positiveSafety = { ok: true, value: { safe: true, revision: safetyRevision, reason: 'literal-role-settings' } }
  assert.deepEqual(await safetyCall(), positiveSafety)
  console.log(
    'PASS real client Connection → HTTP → Gateway → writeSafety uses args.request and returns canonical revision with AI gate OFF',
  )
  assert.deepEqual(await safetyCall({ expectedRevision: safetyRevision - 1 }), {
    ok: true,
    value: { safe: false, revision: safetyRevision, reason: 'revision-conflict' },
  })
  rawRoles = { roles: [{ opaque: { __jsExpr: '"SYNTHETIC_WIRE_MARKER"' } }] }
  const unsafeSafety = await safetyCall()
  assert.deepEqual(unsafeSafety, { ok: true, value: { safe: false, reason: 'expression-backed-role-settings' } })
  assert(!JSON.stringify(unsafeSafety).includes('SYNTHETIC_WIRE_MARKER'))
  assert(!JSON.stringify(unsafeSafety).includes('__jsExpr'))
  rawRoles = { roles: [] }
  assert.deepEqual(await safetyCall({ expectedRevision: safetyRevision, namespace: 'unrelated-config' }), {
    ok: true,
    value: { safe: false, reason: 'safety-unavailable' },
  })
  const wrongSafetyArgs = await client.connection.rpc.call(
    '/api',
    safetyEndpoint,
    { args: { namespace: 'unrelated-config' } },
    AbortSignal.timeout(5000),
  )
  assert.equal(wrongSafetyArgs.ok, false)
  assert.equal(wrongSafetyArgs.error.code, 'gateway/arguments-invalid')
  console.log(
    'PASS writeSafety wire refuses stale revision, opaque expressions and caller namespace fields without returning source values',
  )
  assert.equal((await safetyInvoke(undefined, { cookie: '' })).status, 401)
  assert.equal((await safetyInvoke(undefined, { origin: 'https://untrusted.invalid' })).status, 403)
  console.log(
    'PASS writeSafety actual HTTP authentication/Origin fence rejects ownerless and cross-origin calls (401/403)',
  )
  safetyAvailable = false
  assert.deepEqual(await safetyCall(), { ok: true, value: { safe: false, reason: 'safety-unavailable' } })
  safetyAvailable = true
  safetyDisposed = true
  assert.deepEqual(await safetyCall(), { ok: true, value: { safe: false, reason: 'safety-unavailable' } })
  safetyDisposed = false
  assert.deepEqual(await safetyCall(), positiveSafety)
  safetyDisposed = true
  await safetyFiber.dispose()
  assert.equal(ctx.get('rolesubagentsManagement'), undefined)
  try {
    const afterSafetyUnload = await safetyCall()
    assert(
      afterSafetyUnload.ok === false || afterSafetyUnload.value?.safe === false,
      'unloaded safety service must never attest safe',
    )
  } catch (error) {
    assert.equal(probeFailureOf(error), 'endpoint-unavailable')
  }
  console.log('PASS missing, unavailable and unloaded writeSafety service cannot produce a positive attestation')
  // Role badges use the same authenticated transport, never a configuration endpoint.
  const displayEndpoint = 'rolesubagentsRoleDisplay/query'
  const displayLifetime = new AbortController()
  const displayRole = {
    id: 'reviewer',
    builtin: 'general',
    instructions: 'SYNTHETIC_PRIVATE_INSTRUCTIONS',
    model: { provider: 'SYNTHETIC_PRIVATE_PROVIDER' },
    runner: { env: { SYNTHETIC_PRIVATE_ENV: 'value' } },
  }
  const displayCall = childIds =>
    client.connection.rpc.call('/api', displayEndpoint, { args: { childIds } }, AbortSignal.timeout(5000))
  const displayInvoke = (childIds, headers = {}) =>
    fetch(`${origin}/api/${displayEndpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'role-display-check',
        method: displayEndpoint,
        payload: { args: { childIds } },
      }),
      signal: AbortSignal.timeout(5000),
    })
  await assert.rejects(displayCall(['saved-child']), error => probeFailureOf(error) === 'endpoint-unavailable')
  await mountRoleDisplayService(ctx, {
    state: {
      ready: Promise.resolve(),
      readRoleById: id => (id === 'saved-child' || id === 'external-activation' ? displayRole : undefined),
    },
    isDisposed: () => displayLifetime.signal.aborted,
    lifetime: displayLifetime.signal,
  })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  const expectedDisplay = { roleId: 'reviewer', displayName: 'reviewer', builtin: 'general' }
  const displayAnswer = await displayCall(['saved-child', 'unknown-child', 'external-activation', 'saved-child'])
  assert.deepEqual(displayAnswer, { ok: true, value: [expectedDisplay, null, expectedDisplay, expectedDisplay] })
  assert(!JSON.stringify(displayAnswer).includes('SYNTHETIC_PRIVATE'))
  assert.deepEqual(Object.keys(displayAnswer.value[0]).sort(), ['builtin', 'displayName', 'roleId'])
  const clientRoles = await roleDisplayCaller(client)(
    ['saved-child', 'unknown-child', 'external-activation'],
    AbortSignal.timeout(5000),
  )
  assert.deepEqual(
    { ...clientRoles },
    {
      'saved-child': { roleId: 'reviewer', displayName: 'reviewer' },
      'external-activation': { roleId: 'reviewer', displayName: 'reviewer' },
    },
  )
  assert.equal((await displayCall(Array(100).fill('saved-child'))).value.length, 100)
  for (const bad of [Array(101).fill('saved-child'), ['../config'], ['x'.repeat(257)], [null], {}])
    assert.equal((await displayCall(bad)).ok, false)
  assert.equal(
    (await client.connection.rpc.call('/api', displayEndpoint, { args: { wrong: [] } }, AbortSignal.timeout(5000)))
      .error.code,
    'gateway/arguments-invalid',
  )
  assert.equal((await displayInvoke(['saved-child'], { cookie: '' })).status, 401)
  assert.equal((await displayInvoke(['saved-child'], { origin: 'https://untrusted.invalid' })).status, 403)
  console.log(
    'PASS role-display actual client caller → HTTP → Gateway → Remote: positional saved identities, metadata allowlist, batch/ID bounds, authentication and Origin fence',
  )
  const displayRuntime = [...ctx.registry.values()].find(
    runtime =>
      runtime.name === 'RolesubagentsRoleDisplayService' || runtime.callback.name === 'RolesubagentsRoleDisplayService',
  )
  const displayFiber = displayRuntime && [...displayRuntime.fibers][0]
  assert(displayFiber, 'role-display must have a disposable native service fiber')
  displayLifetime.abort()
  assert.equal((await displayCall(['saved-child'])).ok, false)
  await displayFiber.dispose()
  assert.equal(ctx.get('rolesubagentsRoleDisplay'), undefined)
  assert.deepEqual(Object.keys(await roleDisplayCaller(client)(['saved-child'], AbortSignal.timeout(5000))), [])
  console.log(
    'PASS role-display disposal refuses captured calls and actual client degrades to unbadged rows after unload',
  )
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
