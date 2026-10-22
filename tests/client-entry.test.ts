// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, PROBE_ENDPOINT, probeCaller } from '../src/client/index.ts'
import { type Controller, ProbeUnavailableError } from '../src/client/controller.ts'
import type { DshClientContext } from '../src/client/dsh.ts'
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
