/** React glue: the controller travels through context inside this plugin's own tree. */

import { createContext, type ReactNode, useContext, useMemo, useSyncExternalStore } from 'react'
import type { Controller, PageState } from './controller.ts'
import { type Translator, translator } from './i18n.ts'

const ControllerContext = createContext<Controller | null>(null)

export function ControllerProvider(props: { controller: Controller; children: ReactNode }) {
  return <ControllerContext.Provider value={props.controller}>{props.children}</ControllerContext.Provider>
}

export function useController(): Controller {
  const controller = useContext(ControllerContext)
  if (controller === null) throw new Error('dsh-rolesubagents: component rendered outside ControllerProvider')
  return controller
}

/** The controller's current state; the component re-renders whenever it changes. */
export function usePageState(): PageState {
  const controller = useController()
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot)
}

/** The translator for DSH's active locale. */
export function useT(): Translator {
  const { locale } = usePageState()
  return useMemo(() => translator(locale), [locale])
}
