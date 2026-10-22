import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('real CLI check environment', () => {
  it('isolates identity before runtime startup and restores only its own process environment', () => {
    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import assert from 'node:assert/strict';
      import { existsSync } from 'node:fs';
      import { isolateCheckEnvironment } from './scripts/check-environment.mjs';
      const originalHome = process.env.HOME;
      process.env.ANTHROPIC_API_KEY = 'test-secret-never-forward';
      process.env.CLAUDE_CONFIG_DIR = '/must-not-use';
      process.env.PI_CODING_AGENT_DIR = '/must-not-use';
      process.env.HTTPS_PROXY = 'http://must-not-use';
      const unsafeNames = ['BASH_ENV', 'ENV', 'ZDOTDIR', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONSTARTUP', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'SSH_AUTH_SOCK', 'GIT_CONFIG_GLOBAL', 'UNRECOGNIZED_PROVIDER_CONFIG'];
      for (const name of unsafeNames) process.env[name] = '/must-not-use';
      process.env.CHECK_CLI_VERSION_PI = '1.3.0';
      process.env.CHECK_CODEX_SANDBOX_BACKEND = 'default';
      const check = isolateCheckEnvironment();
      for (const name of unsafeNames) assert.equal(process.env[name], undefined, name);
      assert.equal(process.env.CHECK_CLI_VERSION_PI, '1.3.0');
      assert.equal(process.env.CHECK_CODEX_SANDBOX_BACKEND, 'default');
      assert.notEqual(check.home, originalHome);
      assert.equal(process.env.HOME, check.home);
      assert.equal(process.env.USERPROFILE, check.home);
      assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
      assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined);
      assert.equal(process.env.PI_CODING_AGENT_DIR, undefined);
      assert.equal(process.env.HTTPS_PROXY, undefined);
      assert.ok(process.env.XDG_CONFIG_HOME.startsWith(check.home + '/'));
      assert.ok(process.env.DSH_HOME.startsWith(check.home + '/'));
      assert.ok(existsSync(process.env.DSH_HOME));
      check.dispose();
      check.dispose();
      assert.equal(process.env.HOME, originalHome);
      assert.equal(process.env.ANTHROPIC_API_KEY, 'test-secret-never-forward');
      assert.equal(existsSync(check.home), false);
      console.log('isolated');
    `,
      ],
      { encoding: 'utf8' },
    )
    expect(result.trim()).toBe('isolated')
  })
})
