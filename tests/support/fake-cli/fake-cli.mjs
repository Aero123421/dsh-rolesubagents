#!/usr/bin/env node
/**
 * A tiny stand-in for a coding-agent CLI, used by the integration harness's
 * self-check (`pnpm check:cli self`). No dependencies, no network.
 *
 * Protocol (shared with the harness's test adapter and `tests/external-fakes.ts`):
 * - stdin: the task text, then EOF.
 * - stdout: JSON lines. First `{"type":"pid","pid":<n>}`, then
 *   `{"type":"text","text":…}` chunks and a terminal `{"type":"done"}`, or
 *   `{"type":"error","category":…}` for a failure.
 * Behaviour is chosen by words in the task:
 * - `SLOW`: print the pid line, then wait (up to 10 minutes) until killed.
 * - `FAIL`: write a noisy stderr line and exit 3 without a terminal event.
 * - `LEFTOVER`: start a background `sleep` that outlives this process (same process group), answer
 *   `leftover-child: <pid>` and exit 0.
 * - `CWD`: answer with the working directory.
 * - `ENV:<NAME>`: answer with the value of that environment variable (or `<unset>`).
 * - anything else: answer `echo: <task>`.
 */

import { spawn } from 'node:child_process'

process.stdout.write(`${JSON.stringify({ type: 'pid', pid: process.pid })}\n`)
let task = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  task += chunk
})
process.stdin.on('end', () => {
  const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`)
  if (task.includes('SLOW')) {
    setTimeout(() => process.exit(0), 600_000)
    return
  }
  if (task.includes('LEFTOVER')) {
    const child = spawn('sleep', ['600'], { stdio: 'ignore' })
    child.unref()
    emit({ type: 'text', text: `leftover-child: ${child.pid}` })
    emit({ type: 'done' })
    process.exit(0)
  }
  if (task.includes('FAIL')) {
    process.stderr.write('fatal: request to https://api.example failed with key sk-test-123\n')
    process.exit(3)
  }
  const env = /ENV:([A-Za-z_][A-Za-z0-9_]*)/.exec(task)
  const answer = task.includes('CWD')
    ? process.cwd()
    : env !== null
      ? (process.env[env[1]] ?? '<unset>')
      : `echo: ${task}`
  // Two chunks, the first split mid-character, to exercise framing.
  const line = `${JSON.stringify({ type: 'text', text: answer })}\n`
  const bytes = Buffer.from(line, 'utf8')
  const cut = Math.max(1, bytes.length - 3)
  process.stdout.write(bytes.subarray(0, cut))
  setTimeout(() => {
    process.stdout.write(bytes.subarray(cut))
    emit({ type: 'done' })
  }, 20)
})
