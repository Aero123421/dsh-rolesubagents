#!/usr/bin/env node
/** Opt-in actual-Chromium component smoke; no server, package install, or live DSH context. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isolateCheckEnvironment } from './check-environment.mjs'

const args = process.argv.slice(2)
const usage =
  'Usage: ROLE_CATALOG_BROWSER=/absolute/path/to/chrome node scripts/check-role-catalog-browser.mjs --out <new-output-directory> [--browser /absolute/path/to/chrome] [--no-sandbox]\nOptional external-binary check; requires Node 22+, installed esbuild/React and Chromium. --no-sandbox explicitly weakens Chromium OS isolation; never uses your real profile. Not whole-GUI integration or native-UI parity.'
if (args.includes('--help')) {
  console.log(usage)
  process.exit(0)
}
let browser = process.env.ROLE_CATALOG_BROWSER
let output
let noSandbox = false
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--browser') browser = args[++index]
  else if (args[index] === '--out') output = args[++index]
  else if (args[index] === '--no-sandbox') noSandbox = true
  else throw new Error(`Unknown option ${args[index]}\n${usage}`)
}
if (!browser || !isAbsolute(browser) || !output) throw new Error(usage)
browser = await realpath(browser)
if (!(await stat(browser)).isFile()) throw new Error('Browser must be a regular executable file')
output = resolve(output)
await mkdir(output, { recursive: true })
output = await realpath(output)
// Never overwrite prior evidence. Caller chooses the output directory; only three new files are written.
for (const name of ['report.json', 'desktop.png', 'mobile-ja.png']) {
  try {
    await stat(join(output, name))
    throw new Error(`Output already exists: ${join(output, name)}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
const isolated = isolateCheckEnvironment() // BEFORE loading esbuild or any plugin code.
process.removeListener('exit', isolated.dispose) // Explicitly wait for Chrome exit BEFORE removing its profile.
const homeIdentity = await stat(isolated.home)
const report = {
  scope: 'isolated actual-Chromium component smoke; fixture refs, not Host RPC or DSH GUI',
  browserPath: browser,
  noSandbox,
  startedAt: new Date().toISOString(),
  checks: [],
  errors: [],
  screenshots: [],
  networkRequests: [],
}
let chrome
let exited
let stderr = ''
let sessionId
let nextId = 0
let buffered = ''
const pending = new Map()
const timeout = (milliseconds, message) =>
  new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds)
    timer.unref()
  })
const send = (method, params = {}, session = sessionId) =>
  new Promise((resolveCall, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP timeout: ${method}`))
    }, 15000)
    pending.set(id, { resolve: resolveCall, reject, timer })
    chrome.stdio[3].write(`${JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) })}\0`)
  })
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails)
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}
const check = async (name, expression) => {
  await evaluate(expression)
  report.checks.push(name)
  console.log(`PASS ${name}`)
}
const key = async (value, code = value) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code })
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}
const click = async selector => {
  const point = await evaluate(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw Error('Missing click target'); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`,
  )
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}
const screenshot = async name => {
  const image = await send('Page.captureScreenshot', { format: 'png' })
  await writeFile(join(output, name), Buffer.from(image.data, 'base64'), { flag: 'wx', mode: 0o600 })
  report.screenshots.push(name)
}
const interrupt = () => {
  chrome?.kill('SIGTERM')
}
process.once('SIGINT', interrupt)
process.once('SIGTERM', interrupt)
try {
  const { build } = await import('esbuild')
  const fixture = fileURLToPath(new URL('./fixtures/role-catalog-browser.tsx', import.meta.url))
  const bundle = await build({
    entryPoints: [fixture],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  const html = join(isolated.home, 'fixture.html')
  const profile = join(isolated.home, 'chromium-profile')
  await mkdir(profile, { mode: 0o700 })
  if ((await realpath(profile)) !== profile || !profile.startsWith(`${isolated.home}/`))
    throw new Error('Profile identity mismatch')
  await writeFile(
    html,
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><title>Isolated role catalog component smoke</title><style>body{margin:0;padding:20px;font:14px system-ui;color:#e5e7eb;background:#17191e;--dsw-specific-menu:#24272e;--dsw-alias-label-primary:#eee;--dsw-alias-label-tertiary:#aeb4c0;--dsw-alias-border-l1:#505661}h1{font-size:18px}h2{font-size:14px}section{margin:24px 0}#outside{margin-top:260px}button{color:inherit;background:#343944;border:1px solid #626977;border-radius:6px;padding:6px}</style><div id="fixture"></div><script>${bundle.outputFiles[0].text.replaceAll('</script', '<\\/script')}</script></html>`,
    { flag: 'wx', mode: 0o600 },
  )
  const flags = [
    '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    ...'--no-first-run --no-default-browser-check --disable-background-networking --disable-component-update --disable-sync --disable-default-apps --disable-extensions --disable-domain-reliability --disable-breakpad --disable-crash-reporter --disable-client-side-phishing-detection'.split(
      ' ',
    ),
    '--disable-features=MediaRouter,OptimizationHints,AutofillServerCommunication,CertificateTransparencyComponentUpdater',
    ...'--metrics-recording-only --password-store=basic --use-mock-keychain --disable-dev-shm-usage --disable-gpu'.split(
      ' ',
    ),
    '--host-resolver-rules=MAP * ~NOTFOUND',
    '--proxy-server=127.0.0.1:9',
    ...(noSandbox ? ['--no-sandbox'] : []),
    'about:blank',
  ]
  report.browserFlags = flags
  chrome = spawn(browser, flags, { env: process.env, stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] })
  exited = once(chrome, 'exit')
  chrome.stderr.on('data', chunk => {
    stderr = (stderr + chunk.toString()).slice(-12000)
  })
  chrome.on('error', error => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  })
  chrome.on('exit', () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error(`Chromium exited: ${stderr}`))
    }
    pending.clear()
  })
  chrome.stdio[3].on('error', () => {})
  chrome.stdio[4].on('data', chunk => {
    buffered += chunk.toString()
    while (buffered.includes('\0')) {
      const boundary = buffered.indexOf('\0')
      const message = JSON.parse(buffered.slice(0, boundary))
      buffered = buffered.slice(boundary + 1)
      if (message.id) {
        const request = pending.get(message.id)
        if (!request) continue
        pending.delete(message.id)
        clearTimeout(request.timer)
        if (message.error) request.reject(new Error(JSON.stringify(message.error)))
        else request.resolve(message.result)
      } else if (message.method === 'Runtime.exceptionThrown')
        report.errors.push({ type: 'pageerror', detail: message.params.exceptionDetails })
      else if (message.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(message.params.type))
        report.errors.push({ type: 'console', detail: message.params.args })
      else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error')
        report.errors.push({ type: 'browser-log', detail: message.params.entry })
      else if (message.method === 'Network.requestWillBeSent') report.networkRequests.push(message.params.request.url)
      else if (message.method === 'Fetch.requestPaused') {
        const { requestId, request } = message.params
        const local = request.url === pathToFileURL(html).href
        if (!local) report.errors.push({ type: 'unexpected-network', url: request.url })
        void send(
          local ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          local ? { requestId } : { requestId, errorReason: 'BlockedByClient' },
        ).catch(error => report.errors.push({ type: 'interception', message: error.message }))
      }
    }
  })
  report.browserVersion = await send('Browser.getVersion')
  const target = await send('Target.createTarget', { url: 'about:blank' })
  sessionId = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
  for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await send(`${domain}.enable`)
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
  await send('Emulation.setDeviceMetricsOverride', { width: 1040, height: 760, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: pathToFileURL(html).href })
  await evaluate(
    'new Promise((resolve,reject)=>{const end=Date.now()+8000; const poll=()=>window.smoke?.ready()?resolve():Date.now()>end?reject(Error("Fixture did not mount")):setTimeout(poll,25);poll()})',
  )
  await evaluate('document.querySelector("#root-action button").focus()')
  await key('ArrowDown')
  await check('root, keyboard focus, status/tokens/duration, actual SVG and escaped hostile text', 'smoke.checkRoot()')
  await key('ArrowRight')
  await check('nested projection and metadata', 'smoke.checkNested()')
  await click('[role="treeitem"][aria-disabled="true"]')
  await check('external non-navigation', 'smoke.checkExternal()')
  await click('[aria-label^="Nested reviewer ·"]')
  await check('nested direct-parent navigation', 'smoke.checkNavigation("open","worker","nested")')
  await click('#root-action button')
  await click('[aria-label="Open Worker in sidebar"]')
  await check('sidebar address', 'smoke.checkNavigation("aside","root","worker")')
  await evaluate('document.querySelector("#root-action button").focus()')
  await key('ArrowDown')
  await key('Escape')
  await check('Escape dismissal and focus return', 'smoke.checkClosed(true)')
  await click('#root-action button')
  await click('#outside')
  await check('outside pointer dismissal', 'smoke.checkClosed()')
  await click('#lineage .dshrs-catalog button')
  await click('[aria-label="Expand Worker"]')
  await check('dark/light current row painted background and bold inherited label', 'smoke.checkCurrent()')
  await screenshot('desktop.png')
  await click('[aria-label^="Ordinary ·"]')
  await check('child lineage sibling navigation', 'smoke.checkNavigation("open","root","ordinary")')
  await evaluate('smoke.setLocale()')
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 720, deviceScaleFactor: 1, mobile: true })
  await click('#root-action button')
  await check('Japanese labels and 320px viewport without overflow', 'smoke.checkMobile()')
  await screenshot('mobile-ja.png')
  await check('reconnect aborts stale metadata; unavailable metadata is nonfatal', 'smoke.unavailable()')
  await check('metadata retries after actual five-second interval', 'smoke.recoverByRetry()')
  await click('[aria-label="展開 Worker"]')
  await evaluate('smoke.projectionError()')
  await click('[role="alert"] button')
  await check('projection error retry', 'smoke.checkRetry()')
  await check('pending request no overlap, unmount abort/cleanup and no later polling', 'smoke.pendingAndUnmount()')
  report.fixture = await evaluate('smoke.summary()')
  if (report.errors.length) throw new Error(`Unexpected browser errors: ${JSON.stringify(report.errors)}`)
  report.passed = true
} catch (error) {
  report.passed = false
  report.failure = error.stack ?? String(error)
  process.exitCode = 1
} finally {
  if (chrome) {
    if (chrome.exitCode === null && chrome.signalCode === null) {
      try {
        await Promise.race([send('Browser.close', {}, undefined), exited, timeout(2000, 'close timeout')])
      } catch {}
      try {
        await Promise.race([exited, timeout(3000, 'exit timeout')])
      } catch {
        chrome.kill('SIGKILL')
      }
    }
    report.browserExit = await Promise.race([exited, timeout(5000, 'Chromium did not exit; refusing profile cleanup')])
  }
  process.removeListener('SIGINT', interrupt)
  process.removeListener('SIGTERM', interrupt)
  report.finishedAt = new Date().toISOString()
  report.stderr = stderr
  const currentHome = await stat(isolated.home)
  if (currentHome.dev !== homeIdentity.dev || currentHome.ino !== homeIdentity.ino)
    await Promise.reject(new Error('Private HOME identity changed; refusing cleanup'))
  isolated.dispose()
  report.privateHomeRemoved = true
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}
console.log(`${report.passed ? 'PASS' : 'FAIL'} isolated browser smoke: ${join(output, 'report.json')}`)
if (!report.passed) console.error(report.failure)
