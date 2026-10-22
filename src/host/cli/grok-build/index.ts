import { GROK_BUILD } from '../../../shared/cli/grok-build.ts'
import type { CliAdapter, PlanInput, RunPlan } from '../../external/types.ts'
import { GrokStream } from './parser.ts'

// biome-ignore lint/suspicious/noTemplateCurlyInString: Engine substitutes this private temporary path.
const TASK_FILE = '${RUN_DIR}/grok-task.txt'

export const grokBuildAdapter: CliAdapter = {
  descriptor: GROK_BUILD,
  plan(input: PlanInput): RunPlan {
    if (input.access !== 'full-access' || input.preset !== 'native') throw new Error('Grok native requires full-access')
    const argv = ['--output-format', 'streaming-json', '--cwd', input.cwd, '--prompt-file', TASK_FILE]
    if (input.runner.model) argv.push('--model', input.runner.model)
    if (input.runner.effort) argv.push('--reasoning-effort', input.runner.effort)
    if (input.instructions.trim()) argv.push('--rules', input.instructions)
    return { argv, env: { GROK_DISABLE_AUTOUPDATER: '1' }, files: { [TASK_FILE]: input.task }, cancelGraceMs: 0 }
  },
  createSession() {
    const parser = new GrokStream()
    return { start: io => io.end(), line: text => parser.line(text), finish: exit => parser.finish(exit) }
  },
  async probe(_exe, run, signal) {
    const result = await run(['--version'], { timeoutMs: 10000, env: { GROK_DISABLE_AUTOUPDATER: '1' } }, signal)
    const version = result.code === 0 ? /^grok\s+(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/m.exec(result.stdout)?.[1] : undefined
    return { cli: 'grok-build', found: true, auth: 'unknown', ...(version ? { version } : {}) }
  },
}
