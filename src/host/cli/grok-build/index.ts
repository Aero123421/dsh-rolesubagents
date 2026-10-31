import { GROK_BUILD } from '../../../shared/cli/grok-build.ts'
import type { CliAdapter, PlanInput, RunPlan } from '../../external/types.ts'
import { GrokStream } from './parser.ts'

// biome-ignore lint/suspicious/noTemplateCurlyInString: Engine substitutes this private temporary path.
const TASK_FILE = '${RUN_DIR}/grok-task.txt'
const PRIVATE_ROOT = '$' + '{RUN_DIR}'

export const grokBuildAdapter: CliAdapter = {
  descriptor: GROK_BUILD,
  plan(input: PlanInput): RunPlan {
    const confined = input.access === 'workspace-write' && input.preset === 'workspace-write'
    if (!confined && (input.access !== 'full-access' || input.preset !== 'native'))
      throw new Error('Grok native requires full-access')
    const argv = ['--output-format', 'streaming-json', '--cwd', input.cwd, '--prompt-file', TASK_FILE]
    if (input.runner.model) argv.push('--model', input.runner.model)
    if (input.runner.effort) argv.push('--reasoning-effort', input.runner.effort)
    if (input.instructions.trim()) argv.push('--rules', input.instructions)
    if (confined)
      argv.push('--permission-mode', 'acceptEdits', '--allow', 'Write', '--allow', 'Edit', '--allow', 'Bash')
    return {
      argv,
      env: {
        GROK_DISABLE_AUTOUPDATER: '1',
        ...(confined
          ? {
              HOME: `${PRIVATE_ROOT}/home`,
              GROK_HOME: `${PRIVATE_ROOT}/grok`,
              TMPDIR: `${PRIVATE_ROOT}/tmp`,
              XDG_CONFIG_HOME: `${PRIVATE_ROOT}/home/.config`,
              XDG_CACHE_HOME: `${PRIVATE_ROOT}/home/.cache`,
              XDG_DATA_HOME: `${PRIVATE_ROOT}/home/.local/share`,
              XDG_STATE_HOME: `${PRIVATE_ROOT}/home/.local/state`,
            }
          : {}),
      },
      ...(confined ? { privateState: 'grok-build' as const } : {}),
      files: { [TASK_FILE]: input.task },
      cancelGraceMs: 0,
    }
  },
  createSession() {
    const parser = new GrokStream()
    return { start: io => io.end(), line: text => parser.line(text), finish: exit => parser.finish(exit) }
  },
  async probe(_exe, run, signal) {
    const result = await run(['--version'], { timeoutMs: 10000, env: { GROK_DISABLE_AUTOUPDATER: '1' } }, signal)
    const version =
      result.code === 0
        ? /^grok\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/m.exec(result.stdout)?.[1]
        : undefined
    return { cli: 'grok-build', found: true, auth: 'unknown', ...(version ? { version } : {}) }
  },
}
