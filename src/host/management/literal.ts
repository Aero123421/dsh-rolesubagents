/** Do not restate evaluated profile expressions as literal role values (or materialize their secrets). */
export function literalRoleSettings(rawConfig: unknown): boolean {
  if (rawConfig === undefined || rawConfig === null) return true
  if (typeof rawConfig !== 'object' || Array.isArray(rawConfig)) return false
  const rootPrototype = Object.getPrototypeOf(rawConfig)
  if (rootPrototype !== Object.prototype && rootPrototype !== null) return false
  const root = Object.getOwnPropertyDescriptors(rawConfig)
  if (Object.hasOwn(root, '__jsExpr')) return false
  const roles = root.roles
  if (!roles) return true // Static schema defaults are literal.
  if (!('value' in roles) || !roles.enumerable) return false
  const seen = new WeakSet<object>()
  let nodes = 0
  let characters = 0
  function literal(value: unknown, depth: number): boolean {
    if (++nodes > 20_000 || depth > 64) return false
    if (value === null || typeof value === 'boolean') return true
    if (typeof value === 'string') {
      characters += value.length
      return characters <= 4 * 1024 * 1024
    }
    if (typeof value === 'number') return Number.isFinite(value)
    if (typeof value !== 'object' || value === null) return false
    const prototype = Object.getPrototypeOf(value)
    if (Array.isArray(value) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null)
      return false
    if (seen.has(value) || Object.getOwnPropertySymbols(value).length) return false
    seen.add(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if (Object.hasOwn(descriptors, '__jsExpr')) return false
    const array = Array.isArray(value)
    if (array && (value.length > 20_000 || Object.keys(descriptors).length !== value.length + 1)) return false
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (array && key === 'length') continue
      if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) return false
      characters += key.length
      if (!descriptor.enumerable || !('value' in descriptor) || !literal(descriptor.value, depth + 1)) return false
    }
    seen.delete(value)
    return characters <= 4 * 1024 * 1024
  }
  return literal(roles.value, 0)
}
export interface RoleWriteSafety {
  readonly safe: boolean
  readonly revision?: number
  readonly reason:
    | 'literal-role-settings'
    | 'expression-backed-role-settings'
    | 'safety-unavailable'
    | 'revision-conflict'
}
