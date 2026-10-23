// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  apply,
  inject,
  PROBE_ENDPOINT,
  probeCaller,
  ROLE_WRITE_SAFETY_ENDPOINT,
  ROLE_WRITE_SAFETY_TIMEOUT_MS,
  roleWriteSafetyCaller,
} from '../src/client/index.ts'
import { type Controller, ProbeUnavailableError } from '../src/client/controller.ts'
import type { ConnectionLike, DshClientContext } from '../src/client/dsh.ts'
import { RolesPage } from '../src/client/RolesPage.tsx'
import { fakeForm, fakeRemote } from './client-helpers.ts'

interface Registration {
  slot: string
  options: Record<string, unknown>
  component: unknown
}

/** A context that runs effects and slot injections at once and remembers how to undo them. */
function fakeContext(locale = 'en', services?: Record<string, unknown>) {
  const form = fakeForm()
  const remote = fakeRemote()
  const disposers: { label: string | undefined; dispose: () => unknown }[] = []
  const registrations: Registration[] = []
  const localeListeners = new Set<() => void>()
  const eventListeners = new Map<string, () => void>()
  const formsGot: string[] = []
  const state = { locale }
  remote.$on.mockImplementation((event: string, listener: () => void) => {
    eventListeners.set(event, listener)
    return () => {
      eventListeners.delete(event)
    }
  })
  const ctx: DshClientContext = {
    configForms: {
      get(entry) {
        formsGot.push(entry)
        return form.form
      },
    },
    remote,
    locale: {
      getLocale: () => ({ active: state.locale }),
      subscribe(listener) {
        localeListeners.add(listener)
        return () => {
          localeListeners.delete(listener)
        }
      },
    },
    slots: {
      inject(slot, callback) {
        const dispose = callback()
        if (dispose !== undefined) disposers.push({ label: `slot:${slot}`, dispose })
      },
      register(options, component) {
        registrations.push({ slot: String(options.name), options, component })
        return () => {
          registrations.splice(0)
        }
      },
    },
    on(event, listener) {
      eventListeners.set(event, listener)
      return () => {
        eventListeners.delete(event)
      }
    },
    effect(execute, label) {
      disposers.push({ label, dispose: execute() })
    },
    ...(services === undefined ? {} : { get: (name: string) => services[name] }),
  }
  return {
    ctx,
    form,
    remote,
    registrations,
    disposers,
    eventListeners,
    formsGot,
    setLocale(next: string) {
      state.locale = next
      for (const listener of [...localeListeners]) listener()
    },
    unload() {
      for (const { dispose } of disposers.splice(0).reverse()) dispose()
    },
  }
}

const controllerOf = (registration: Registration | undefined): Controller => {
  const injected = (registration?.options.inject as (() => { controller: Controller }) | undefined)?.()
  if (injected === undefined) throw new Error('no inject face')
  return injected.controller
}

afterEach(() => {
  document.head.innerHTML = ''
})

describe('client entry', () => {
  it('names the Cordis services it needs', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.session', 'remote.agentPresets', 'configForms'])
  })

  it('registers the page in the keyed bundle configuration slot under the package name', () => {
    const { ctx, registrations, formsGot } = fakeContext()
    apply(ctx)
    expect(registrations).toHaveLength(1)
    const [registration] = registrations
    expect(registration?.slot).toBe('plugins.bundle.config')
    expect(registration?.options.key).toBe('dsh-rolesubagents')
    expect(registration?.component).toBe(RolesPage)
    expect(formsGot).toEqual(['rolesubagents'])
    const controller = controllerOf(registration)
    expect(controller.getSnapshot()).toMatchObject({ status: 'ready', locale: 'en' })
    expect(controllerOf(registration)).toBe(controller)
  })

  it('injects one style element and removes it when the plugin unloads', () => {
    const { ctx, unload } = fakeContext()
    apply(ctx)
    const styles = document.head.querySelectorAll('style[data-plugin="dsh-rolesubagents"]')
    expect(styles).toHaveLength(1)
    expect(styles[0]?.textContent).toContain('.dshrs-root')
    const classes = [...(styles[0]?.textContent ?? '').matchAll(/\.([a-z][\w-]*)/g)].map(match => match[1])
    expect(classes.length).toBeGreaterThan(20)
    expect(classes.filter(name => !name?.startsWith('dshrs-'))).toEqual([])
    unload()
    expect(document.head.querySelector('style[data-plugin="dsh-rolesubagents"]')).toBeNull()
  })

  it('ties every subscription to the context and lets go of them on unload', () => {
    const { ctx, registrations, disposers, eventListeners, unload } = fakeContext()
    apply(ctx)
    expect(disposers.map(entry => entry.label)).toEqual(
      expect.arrayContaining([
        'dsh-rolesubagents:styles',
        'dsh-rolesubagents:controller',
        'dsh-rolesubagents:locale',
        'dsh-rolesubagents:reconnect',
        'dsh-rolesubagents:adapters',
      ]),
    )
    expect([...eventListeners.keys()].sort()).toEqual(['connection/reset', 'llm/adapters-updated'])
    const controller = controllerOf(registrations[0])
    unload()
    expect(eventListeners.size).toBe(0)
    const listener = vi.fn()
    controller.subscribe(listener)
    controller.setLocale('ja')
    expect(listener).not.toHaveBeenCalled()
  })

  it('follows the active DSH locale', () => {
    const { ctx, registrations, setLocale } = fakeContext('ja')
    apply(ctx)
    const controller = controllerOf(registrations[0])
    expect(controller.getSnapshot().locale).toBe('ja')
    setLocale('en')
    expect(controller.getSnapshot().locale).toBe('en')
  })

  it('reloads the model and preset lists after a reconnect or an adapter change, once an editor needed them', async () => {
    const { ctx, registrations, remote, eventListeners } = fakeContext()
    apply(ctx)
    const controller = controllerOf(registrations[0])
    eventListeners.get('connection/reset')?.()
    expect(remote.session.modelCatalog).not.toHaveBeenCalled()
    const uid = controller.getSnapshot().draft?.rows[2]?.uid ?? -1
    controller.toggleEditor(uid)
    await Promise.resolve()
    expect(remote.session.modelCatalog).toHaveBeenCalledTimes(1)
    await new Promise(resolve => setTimeout(resolve, 0))
    eventListeners.get('connection/reset')?.()
    eventListeners.get('llm/adapters-updated')?.()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(remote.session.modelCatalog).toHaveBeenCalledTimes(3)
    expect(remote.agentPresets.list).toHaveBeenCalledTimes(3)
  })
})

describe('role-write safety production wiring', () => {
  it('requires the fixed metadata-only endpoint and reads the connection lazily on each attempt', async () => {
    const services: Record<string, unknown> = {}
    const { ctx } = fakeContext('en', services)
    const check = roleWriteSafetyCaller(ctx)
    const signal = new AbortController().signal
    await expect(check(7, signal)).rejects.toThrow('role-write-safety-unavailable')
    const call = vi.fn<ConnectionLike['rpc']['call']>(async () => ({
      ok: true,
      value: { safe: true, revision: 7, reason: 'literal-role-settings' },
    }))
    services.connection = { rpc: { call } }
    await expect(check(7, signal)).resolves.toEqual({
      ok: true,
      value: { safe: true, revision: 7, reason: 'literal-role-settings' },
    })
    expect(ROLE_WRITE_SAFETY_ENDPOINT).toBe('rolesubagentsManagement/writeSafety')
    expect(call).toHaveBeenCalledExactlyOnceWith(
      '/api',
      ROLE_WRITE_SAFETY_ENDPOINT,
      { args: { request: { expectedRevision: 7 } } },
      expect.any(AbortSignal),
    )
    expect(inject).not.toContain('connection')
  })

  it('normalizes missing endpoint and transport errors without a fallback or raw message', async () => {
    const call = vi.fn<ConnectionLike['rpc']['call']>(async () => ({
      ok: false,
      error: { code: 'gateway/method-unavailable', message: 'SECRET endpoint data' },
    }))
    const { ctx } = fakeContext('en', { connection: { rpc: { call } } })
    const check = roleWriteSafetyCaller(ctx)
    await expect(check(1, new AbortController().signal)).rejects.toThrow(/^role-write-safety-unavailable$/)
    call.mockRejectedValueOnce(new Error('SECRET transport error'))
    await expect(check(1, new AbortController().signal)).rejects.toThrow(/^role-write-safety-unavailable$/)
    expect(call).toHaveBeenCalledTimes(2)
    expect(call.mock.calls.every(args => args[1] === ROLE_WRITE_SAFETY_ENDPOINT)).toBe(true)
  })

  it('bounds a stalled request to ten seconds and aborts its transport signal', async () => {
    vi.useFakeTimers()
    try {
      const call = vi.fn<ConnectionLike['rpc']['call']>(() => new Promise(() => {}))
      const { ctx } = fakeContext('en', { connection: { rpc: { call } } })
      const pending = roleWriteSafetyCaller(ctx)(1, new AbortController().signal)
      const rejected = expect(pending).rejects.toThrow(/^role-write-safety-unavailable$/)
      await vi.advanceTimersByTimeAsync(ROLE_WRITE_SAFETY_TIMEOUT_MS)
      await rejected
      expect(call).toHaveBeenCalledTimes(1)
      expect(call.mock.calls[0]?.[3]?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not start a request with an already-aborted owner signal', async () => {
    const call = vi.fn<ConnectionLike['rpc']['call']>(async () => ({ ok: true, value: {} }))
    const { ctx } = fakeContext('en', { connection: { rpc: { call } } })
    const abort = new AbortController()
    abort.abort()
    await expect(roleWriteSafetyCaller(ctx)(1, abort.signal)).rejects.toThrow(/^role-write-safety-unavailable$/)
    expect(call).not.toHaveBeenCalled()
  })

  it('always injects the guard in production, failing role saves closed without blocking management OFF', async () => {
    const { ctx, form, registrations } = fakeContext()
    form.set({ value: { ...(form.form.getSnapshot().value as object), allowAiRoleManagement: true } })
    apply(ctx)
    const controller = controllerOf(registrations[0])
    const uid = controller.getSnapshot().draft?.rows[2]?.uid ?? -1
    controller.patchRole(uid, { description: 'unsaved' })
    await controller.save()
    expect(form.calls).toHaveLength(0)
    expect(controller.getSnapshot()).toMatchObject({
      dirty: true,
      save: 'failed',
      saveIssue: 'role-write-safety-unavailable',
    })
    await controller.setAllowAiRoleManagement(false)
    expect(form.calls).toEqual([{ ops: [{ op: 'set', path: ['allowAiRoleManagement'], value: false }], revision: 1 }])
  })

  it('invalidates and aborts a pending role guard on connection/reset even when a new Host reuses its revision', async () => {
    let release: (value: { ok: true; value: unknown }) => void = () => {}
    const call = vi.fn<ConnectionLike['rpc']['call']>(
      () =>
        new Promise(resolve => {
          release = resolve
        }),
    )
    const { ctx, form, registrations, eventListeners } = fakeContext('en', { connection: { rpc: { call } } })
    apply(ctx)
    const controller = controllerOf(registrations[0])
    controller.setEnabled(false)
    const pending = controller.save()
    await Promise.resolve()
    expect(call).toHaveBeenCalledTimes(1)
    eventListeners.get('connection/reset')?.()
    await pending
    expect(call.mock.calls[0]?.[3]?.aborted).toBe(true)
    expect(form.calls).toHaveLength(0)
    expect(controller.getSnapshot()).toMatchObject({
      dirty: true,
      canSave: false,
      saveIssue: 'role-write-safety-conflict',
    })
    release({ ok: true, value: { safe: true, revision: 1, reason: 'literal-role-settings' } })
    await Promise.resolve()
    await controller.save()
    expect(call).toHaveBeenCalledTimes(1)
    expect(form.calls).toHaveLength(0)
  })

  it('permits a literal role save with a positive same-revision response even while AI management is OFF', async () => {
    const call = vi.fn<ConnectionLike['rpc']['call']>(async () => ({
      ok: true,
      value: { safe: true, revision: 1, reason: 'literal-role-settings' },
    }))
    const { ctx, form, registrations } = fakeContext('en', { connection: { rpc: { call } } })
    apply(ctx)
    const controller = controllerOf(registrations[0])
    controller.setEnabled(false)
    await controller.save()
    expect(controller.getSnapshot()).toMatchObject({
      save: 'saved',
      saveIssue: undefined,
      management: { enabled: false },
    })
    expect(form.calls).toHaveLength(1)
    expect(call.mock.calls[0]?.[2]).toEqual({ args: { request: { expectedRevision: 1 } } })
  })
})

describe('CLI connection test wiring', () => {
  it('keeps connection out of the required services and reads it lazily', async () => {
    expect(inject).not.toContain('connection')
    const call = vi.fn(async () => ({ ok: true as const, value: { cli: 'codex', found: false } }))
    const services: Record<string, unknown> = {}
    const { ctx } = fakeContext('en', services)
    const probe = probeCaller(ctx)
    if (probe === undefined) throw new Error('no probe')
    const signal = new AbortController().signal
    await expect(probe('codex', signal)).rejects.toBeInstanceOf(ProbeUnavailableError)
    services.connection = { rpc: {} }
    await expect(probe('codex', signal)).rejects.toBeInstanceOf(ProbeUnavailableError)
    services.connection = { rpc: { call } }
    await expect(probe('agy', signal)).resolves.toEqual({ ok: true, value: { cli: 'codex', found: false } })
    expect(call).toHaveBeenCalledWith('/api', PROBE_ENDPOINT, { args: { request: { cli: 'agy' } } }, signal)
    expect(PROBE_ENDPOINT).toBe('rolesubagentsCli/probe')
  })

  it('treats a throwing service lookup as no connection', async () => {
    const { ctx } = fakeContext()
    const probe = probeCaller({
      ...ctx,
      get: () => {
        throw new Error('inactive context')
      },
    })
    await expect(probe?.('codex', new AbortController().signal)).rejects.toBeInstanceOf(ProbeUnavailableError)
  })

  it('reports missing connection per attempt and resets diagnostics on reconnect', async () => {
    const plain = fakeContext()
    apply(plain.ctx)
    await expect(probeCaller(plain.ctx)('codex', new AbortController().signal)).rejects.toBeInstanceOf(
      ProbeUnavailableError,
    )
    expect(controllerOf(plain.registrations[0]).getSnapshot().probes.available).toBe(true)

    const call = vi.fn(async () => ({ ok: false as const, error: { code: 'gateway/method-unavailable', message: '' } }))
    const wired = fakeContext('en', { connection: { rpc: { call } } })
    apply(wired.ctx)
    const controller = controllerOf(wired.registrations[0])
    expect(controller.getSnapshot().probes.available).toBe(true)
    controller.probeCli('codex')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(controller.getSnapshot().probes.clis.codex).toEqual({ status: 'error', issue: 'remote-unavailable' })
    expect(controller.getSnapshot().probes.available).toBe(true)
    wired.eventListeners.get('connection/reset')?.()
    expect(controller.getSnapshot().probes.available).toBe(true)
  })
})
