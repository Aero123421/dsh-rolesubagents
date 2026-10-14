// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import type { Controller } from '../src/client/controller.ts'
import type { DshClientContext } from '../src/client/dsh.ts'
import { RolesPage } from '../src/client/RolesPage.tsx'
import { fakeForm, fakeRemote } from './client-helpers.ts'

interface Registration {
  slot: string
  options: Record<string, unknown>
  component: unknown
}

/** A context that runs effects and slot injections at once and remembers how to undo them. */
function fakeContext(locale = 'en') {
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
