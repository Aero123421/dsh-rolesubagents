import { readFileSync, readdirSync } from 'node:fs'

/** Track harness descendants without reading unrelated processes' potentially secret environments. */
export function createOwnedEnvironmentScanner({
  self = process.pid,
  root = '/proc',
  read = readFileSync,
  list = readdirSync,
} = {}) {
  const owned = new Map()
  const identity = pid => {
    const stat = read(`${root}/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[19] ? { parent: Number(fields[1]), birth: fields[19] } : undefined
  }
  return entry => {
    const processes = new Map()
    for (const name of list(root)) {
      if (!/^\d+$/.test(name)) continue
      try {
        const info = identity(name)
        if (info) processes.set(Number(name), info)
      } catch {}
    }
    const belongs = pid => {
      const seen = new Set()
      for (let current = pid; !seen.has(current); ) {
        if (current === self) return true
        seen.add(current)
        const info = processes.get(current)
        if (!info) return false
        if (owned.get(current) === info.birth) return true
        current = info.parent
      }
      return false
    }
    const pids = []
    for (const [pid, info] of processes) {
      if (pid === self || !belongs(pid)) continue
      owned.set(pid, info.birth)
      try {
        if (identity(pid)?.birth !== info.birth) continue
        if (read(`${root}/${pid}/environ`, 'latin1').split('\0').includes(entry)) pids.push(pid)
      } catch {}
    }
    for (const [pid, birth] of owned) if (processes.get(pid)?.birth !== birth) owned.delete(pid)
    return pids
  }
}
