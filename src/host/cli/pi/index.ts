import { PI } from '../../../shared/cli/pi.ts'
import type { CliAdapter, PlanInput, RunPlan } from '../../external/types.ts'
import { PiSession } from './parser.ts'

// biome-ignore lint/suspicious/noTemplateCurlyInString: Engine substitutes this private temporary path.
const INSTRUCTIONS_FILE = '${RUN_DIR}/pi-instructions.txt'
const PRIVATE_ROOT = '$' + '{RUN_DIR}'

export const piAdapter: CliAdapter = {
  descriptor: PI,
  plan(input: PlanInput): RunPlan {
    const confined = input.access === 'workspace-write' && input.preset === 'workspace-write'
    if (!confined && (input.access !== 'full-access' || input.preset !== 'native'))
      throw new Error('Pi native requires full-access')
    const argv = ['--mode', 'rpc', '--no-session']
    if (input.runner.model) argv.push('--model', input.runner.model)
    if (input.runner.effort) argv.push('--thinking', input.runner.effort)
    const files = input.instructions.trim() ? { [INSTRUCTIONS_FILE]: input.instructions } : undefined
    if (files) argv.push('--append-system-prompt', INSTRUCTIONS_FILE)
    // Version checks must not mutate an installed CLI; normal auth/config/extensions remain untouched.
    return {
      argv,
      env: {
        PI_SKIP_VERSION_CHECK: '1',
        ...(confined
          ? {
              HOME: `${PRIVATE_ROOT}/home`,
              PI_CODING_AGENT_DIR: `${PRIVATE_ROOT}/pi`,
              TMPDIR: `${PRIVATE_ROOT}/tmp`,
              XDG_CONFIG_HOME: `${PRIVATE_ROOT}/home/.config`,
              XDG_CACHE_HOME: `${PRIVATE_ROOT}/home/.cache`,
              XDG_DATA_HOME: `${PRIVATE_ROOT}/home/.local/share`,
              XDG_STATE_HOME: `${PRIVATE_ROOT}/home/.local/state`,
            }
          : {}),
      },
      ...(confined ? { privateState: 'pi' as const } : {}),
      ...(files ? { files } : {}),
      cancelGraceMs: 5000,
    }
  },
  createSession(input, nonce) {
    return new PiSession(input.task, nonce)
  },
  async probe(_exe, run, signal) {
    // --help and --list-models initialize the full extension runtime in Pi 1.3.0. --version exits early.
    const result = await run(['--version'], { timeoutMs: 10000, env: { PI_SKIP_VERSION_CHECK: '1' } }, signal)
    const version =
      result.code === 0 ? /^(?:pi\s+)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/m.exec(result.stdout)?.[1] : undefined
    return { cli: 'pi', found: true, auth: 'unknown', ...(version ? { version } : {}) }
  },
}
