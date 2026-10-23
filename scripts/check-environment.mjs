/** Disposable identity for real-CLI checks; never run plugin housekeeping against the user's HOME. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function isolateCheckEnvironment() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'rolesubagents-check-home-')))
  const original = { ...process.env }
  // Deny by default: native shell/runtime hooks and credential-file selectors do not necessarily
  // contain KEY/TOKEN. Suites explicitly supply dummy credentials and test-owned configuration.
  const keep = new Set([
    'PATH',
    'Path',
    'LANG',
    'LANGUAGE',
    'TERM',
    'COLORTERM',
    'SHELL',
    'USER',
    'LOGNAME',
    'TZ',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'DSH_CHECKOUT',
    'CLI_PATH_DIR',
    'CHECK_CLI_CASE',
    'CHECK_CLI_REPORT',
    'CHECK_CLI_REQUIRE_ALL',
    'CHECK_CLI_OUTSIDE_TMP',
    'CHECK_CODEX_SANDBOX_BACKEND',
  ])
  for (const name of Object.keys(process.env)) {
    if (
      !keep.has(name) &&
      !/^LC_[A-Z_]+$/.test(name) &&
      !/^CHECK_CLI_(EXECUTABLE|VERSION)_(CODEX|CLAUDE_CODE|AGY|OPENCODE|GROK_BUILD|PI)$/.test(name)
    ) {
      delete process.env[name]
    }
  }
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    DSH_HOME: join(home, '.dsh'),
    NO_PROXY: '127.0.0.1,localhost,::1',
    no_proxy: '127.0.0.1,localhost,::1',
  })
  for (const key of ['XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'DSH_HOME']) {
    mkdirSync(process.env[key], { recursive: true })
  }
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    // Only the freshly minted directory may be removed; reject an unexpected symlink replacement.
    if (realpathSync(home) !== home) throw new Error('check HOME changed identity; refusing cleanup')
    rmSync(home, { recursive: true, force: true })
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]
    Object.assign(process.env, original)
  }
  process.once('exit', dispose)
  return { home, dispose }
}
