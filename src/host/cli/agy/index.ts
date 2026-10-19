/**
 * Antigravity CLI (`agy`) adapter: one headless stream-json run per delegation.
 *
 * Invocation (DESIGN §5.3, verified against agy 1.4.2):
 *   agy --input-format stream-json --output-format stream-json --disable-slash-commands
 *       [--model m] [--effort e] [--agent dsh-rolesubagents-<nonce>] [--dangerously-skip-permissions]
 *       --log-file ${RUN_DIR}/agy.log
 * stdin: one `{"event":"user","message":{"content":…}}` line, then EOF (agy runs one turn and exits).
 * env: `AGY_CLI_DISABLE_AUTO_UPDATE=true` (otherwise every launch spawns a detached updater).
 * Pre-flight: `agy --output-format json models` — fails fast when agy is not signed in, instead of
 * agy waiting for an OAuth code (which, with a controlling TTY, would read the user's terminal).
 *
 * Presets:
 * - `read-only`, `edit-files`: a generated custom agent `${HOME}/.gemini/config/agents/dsh-rolesubagents-<nonce>.md`
 *   (removed by the engine after the run; stale ones are swept by {@link agyHousekeeping}) whose `tools:`
 *   allowlist is the boundary — an undeclared tool fails with `unknown tool` and the model carries on.
 *   `edit-files` adds `write_to_file` + `replace_file_content` but no `run_command`: agy's default headless
 *   policy auto-allows writes inside the workspace (and the OS temp dir) and soft-denies writes elsewhere
 *   (verified: the run ends with `denied_actions`, mapped to category `permission`). Role instructions are the
 *   agent body (system prompt channel).
 * - `full-access`: agy's DEFAULT agent + `--dangerously-skip-permissions`, instructions as a prompt prefix.
 *   Verified against the real binary: a custom agent without `tools:` does NOT keep the default toolset (it
 *   gets send_message/view_file/read_url_content/search_web/schedule/generate_image/manage_task — no
 *   run_command, no file writes), and even with the default toolset listed explicitly a custom agent replaces
 *   agy's identity, conversation-transcript, subagent and skills prompt sections (system prompt 8.7 KB instead
 *   of 15.7 KB). Full access should behave like plain agy, so it keeps the default agent.
 */

import type { Dirent } from 'node:fs'
import { lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ACCESS_ORDER, type AccessLevel, presetAccess } from '../../../shared/cli/index.ts'
import { AGY } from '../../../shared/cli/agy.ts'
import type {
  CliAdapter,
  PlanInput,
  ProbeModel,
  ProbeResult,
  ProbeRunner,
  RunExit,
  RunPlan,
  RunSession,
  SessionIO,
} from '../../external/types.ts'
import { AgyStreamParser, agyOutcome } from './parser.ts'

/** Prefix of every generated agent name and file (also what housekeeping sweeps). */
export const AGENT_PREFIX = 'dsh-rolesubagents-'

/** Directory of agy's user-level custom agents, relative to HOME. */
export const AGENTS_DIR = '.gemini/config/agents'

/** Tools of the read-only agent. */
export const READ_TOOLS: readonly string[] = Object.freeze(['view_file', 'grep_search', 'list_dir', 'find_by_name'])

/** Tools of the edit-files agent: reads + workspace file edits, no command execution. */
export const EDIT_TOOLS: readonly string[] = Object.freeze([...READ_TOOLS, 'write_to_file', 'replace_file_content'])

/** Env overlay of every agy process (runs and probes). */
const AGY_ENV = Object.freeze({ AGY_CLI_DISABLE_AUTO_UPDATE: 'true' })

/** The pre-flight / probe command: lists models; exits non-zero when agy is not signed in. */
const MODELS_ARGV: readonly string[] = Object.freeze(['--output-format', 'json', 'models'])
const PREFLIGHT_TIMEOUT_MS = 15_000
const VERSION_TIMEOUT_MS = 10_000

/** Generated agent files older than this are stale (a crashed Host could not remove them). */
export const STALE_AGENT_MS = 24 * 60 * 60 * 1000

/** Engine placeholders (split so they are not template expressions). */
const HOME_TOKEN = '$' + '{HOME}'
const RUN_DIR_TOKEN = '$' + '{RUN_DIR}'

const NONCE = /^[A-Za-z0-9]{1,32}$/
const LEVELS: readonly AccessLevel[] = ['read-only', 'workspace-write', 'full-access']

/**
 * The access level a run actually gets: the lower of the preset's level and the effective
 * access (an unknown preset counts as read-only — fail closed).
 * @param input - plan input.
 * @returns the level.
 */
export function agyAccess(input: Pick<PlanInput, 'preset' | 'access'>): AccessLevel {
  const preset = presetAccess(AGY, input.preset) ?? 'read-only'
  const access = ACCESS_ORDER[input.access] === undefined ? 'read-only' : input.access
  return LEVELS[Math.min(ACCESS_ORDER[preset], ACCESS_ORDER[access])] ?? 'read-only'
}

/**
 * Name of the generated agent of one run.
 * @param nonce - the engine's per-run nonce.
 * @returns `dsh-rolesubagents-<nonce>`.
 * @throws when the nonce is not alphanumeric (it becomes a file name).
 */
export function agentName(nonce: string): string {
  if (!NONCE.test(nonce)) throw new Error('invalid run nonce')
  return AGENT_PREFIX + nonce
}

/**
 * Markdown of the generated custom agent: YAML frontmatter (fixed values only) plus the role
 * instructions as an H1 section of the agent's system prompt.
 * @param name - the agent name.
 * @param tools - its tool allowlist.
 * @param instructions - role instructions; may be ''.
 * @returns the file content.
 */
export function agentMarkdown(name: string, tools: readonly string[], instructions: string): string {
  const front = [
    '---',
    `name: ${name}`,
    'description: dsh-rolesubagents delegated role (generated for one run)',
    'tools:',
    ...tools.map(tool => `  - ${tool}`),
    'mainAgent: true',
    'subagent: false',
    'hidden: true',
    '---',
  ].join('\n')
  return instructions.trim() === '' ? `${front}\n` : `${front}\n# Role instructions\n\n${instructions.trim()}\n`
}

/**
 * The user message of a full-access run: instructions as a prompt prefix (agy wraps the whole
 * message in `<USER_REQUEST>`), or the task alone.
 * @param instructions - role instructions; may be ''.
 * @param task - the delegate prompt.
 * @returns the message text.
 */
export function prefixedTask(instructions: string, task: string): string {
  return instructions.trim() === '' ? task : `# Role instructions\n\n${instructions.trim()}\n\n# Task\n\n${task}`
}

function plan(input: PlanInput, nonce: string): RunPlan {
  const level = agyAccess(input)
  const { model, effort } = input.runner
  const argv = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands']
  if (model !== undefined && model !== '') argv.push('--model', model)
  if (effort !== undefined && effort !== '') argv.push('--effort', effort)
  let files: Record<string, string> | undefined
  if (level === 'full-access') argv.push('--dangerously-skip-permissions')
  else {
    const name = agentName(nonce)
    const tools = level === 'workspace-write' ? EDIT_TOOLS : READ_TOOLS
    files = { [`${HOME_TOKEN}/${AGENTS_DIR}/${name}.md`]: agentMarkdown(name, tools, input.instructions) }
    argv.push('--agent', name)
  }
  argv.push('--log-file', `${RUN_DIR_TOKEN}/agy.log`)
  return {
    argv,
    env: { ...AGY_ENV },
    ...(files === undefined ? {} : { files }),
    preflight: { argv: MODELS_ARGV, timeoutMs: PREFLIGHT_TIMEOUT_MS, category: 'auth' },
    // agy handles SIGTERM itself (final result "interrupted", exit within ~0.2 s); no graceful step is needed.
    cancelGraceMs: 0,
  }
}

function createSession(input: PlanInput, _nonce: string): RunSession {
  const parser = new AgyStreamParser()
  const content = agyAccess(input) === 'full-access' ? prefixedTask(input.instructions, input.task) : input.task
  return {
    start(io: SessionIO): void {
      io.write(`${JSON.stringify({ event: 'user', message: { content } })}\n`)
      io.end()
    },
    line(text: string): void {
      parser.line(text)
    },
    finish(exit: RunExit) {
      return agyOutcome(parser, exit)
    },
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Probe

const VERSION_LINE = /^v?(\d+\.\d+\.\d+[0-9A-Za-z.+-]*)\s*$/m
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const EFFORT_SUFFIX = /^(.+)-(low|medium|high|xhigh|max)$/

/**
 * The version from `agy --version` (a bare semver line).
 * @param stdout - command output.
 * @returns the version, if any.
 */
export function parseVersion(stdout: string): string | undefined {
  return VERSION_LINE.exec(stdout)?.[1]
}

/**
 * Models from `agy --output-format json models` (`command.data.models[].{id,label}`).
 * Effort-suffixed slugs (`gemini-3.8-flash-high`) are also grouped into base models with their
 * efforts, listed first, since a role sets the model and effort separately.
 * @param stdout - command output (one JSON object; other lines are ignored).
 * @returns the models (empty when none could be read).
 */
export function parseModels(stdout: string): ProbeModel[] {
  let raw: unknown
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const data: unknown = JSON.parse(line)
      const command = (data as { command?: { data?: { models?: unknown } } } | null)?.command
      if (Array.isArray(command?.data?.models)) {
        raw = command.data.models
        break
      }
    } catch {}
  }
  if (!Array.isArray(raw)) return []
  const slugs: ProbeModel[] = []
  const bases = new Map<string, { name?: string; efforts: Set<string> }>()
  for (const entry of raw) {
    const id = (entry as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !MODEL_ID.test(id)) continue
    const label = (entry as { label?: unknown }).label
    const name = typeof label === 'string' && label.trim() !== '' ? label.trim().slice(0, 128) : undefined
    slugs.push(name === undefined ? { id } : { id, name })
    const suffix = EFFORT_SUFFIX.exec(id)
    if (suffix === null) continue
    const base = bases.get(suffix[1] as string) ?? { efforts: new Set<string>() }
    base.efforts.add(suffix[2] as string)
    if (base.name === undefined && name !== undefined) base.name = name.replace(/\s*\([^)]*\)$/, '')
    bases.set(suffix[1] as string, base)
  }
  const grouped: ProbeModel[] = [...bases].map(([id, base]) => ({
    id,
    ...(base.name === undefined ? {} : { name: base.name }),
    efforts: AGY.efforts.filter(effort => base.efforts.has(effort)),
  }))
  return [...grouped, ...slugs.filter(model => !bases.has(model.id))]
}

async function probe(_exe: string, run: ProbeRunner, signal: AbortSignal): Promise<ProbeResult> {
  const version = await run(['--version'], { timeoutMs: VERSION_TIMEOUT_MS, env: AGY_ENV }, signal)
  const models = await run(MODELS_ARGV, { timeoutMs: PREFLIGHT_TIMEOUT_MS, env: AGY_ENV }, signal)
  const parsedVersion = version.code === 0 ? parseVersion(version.stdout) : undefined
  const list = models.code === 0 ? parseModels(models.stdout) : []
  return {
    cli: 'agy',
    found: true,
    ...(parsedVersion === undefined ? {} : { version: parsedVersion }),
    auth: models.code === 0 ? 'ok' : models.timedOut || models.code === null ? 'unknown' : 'missing',
    ...(list.length > 0 ? { models: list } : {}),
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Housekeeping

/**
 * Remove generated agent files a previous Host could not remove (crash, kill): only regular
 * files named `dsh-rolesubagents-*.md` directly in `<home>/.gemini/config/agents`, older than
 * {@link STALE_AGENT_MS}. Never follows symlinks; a missing directory is fine.
 * @param home - the Host user's home directory.
 * @param now - current time in ms (tests).
 */
export async function agyHousekeeping(home: string, now: number = Date.now()): Promise<void> {
  const dir = join(home, AGENTS_DIR)
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith(AGENT_PREFIX) || !entry.name.endsWith('.md')) continue
    const path = join(dir, entry.name)
    try {
      const info = await lstat(path)
      if (info.isFile() && now - info.mtimeMs > STALE_AGENT_MS) await rm(path, { force: true })
    } catch {}
  }
}

export const agyAdapter: CliAdapter = {
  descriptor: AGY,
  plan,
  createSession,
  probe,
  housekeeping: home => agyHousekeeping(home),
}
