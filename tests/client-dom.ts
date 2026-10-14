/**
 * A small DOM test harness over React's own `act` and `createRoot`, with the
 * handful of queries the page tests need. `@testing-library/react` is declared
 * in package.json but cannot load without its `@testing-library/dom` peer, which
 * the repo does not install.
 */

import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Matcher = string | RegExp

const hit = (matcher: Matcher, text: string): boolean => {
  const value = text.replace(/\s+/g, ' ').trim()
  return typeof matcher === 'string' ? value === matcher : matcher.test(value)
}

/** The element's own text nodes, which is what Testing Library's `getByText` matches. */
const ownText = (el: Element): string =>
  [...el.childNodes]
    .filter(node => node.nodeType === 3)
    .map(node => node.textContent ?? '')
    .join('')

const IMPLICIT: Record<string, string> = {
  button: 'button:not([role])',
  switch: '[role="switch"]',
  status: '[role="status"]',
  radio: 'input[type="radio"]',
  option: 'option',
}

function nameOf(el: Element): string {
  const label = el.getAttribute('aria-label')
  if (label !== null) return label
  if (el instanceof HTMLInputElement) return el.closest('label')?.textContent?.trim() ?? ''
  return el.textContent?.trim() ?? ''
}

function describe(what: string, root: ParentNode): string {
  const html = root instanceof Element ? root.outerHTML : document.body.innerHTML
  return `${what}\n${html.slice(0, 1500)}`
}

export function within(root: ParentNode) {
  const byText = (matcher: Matcher, options: { selector?: string } = {}): HTMLElement[] =>
    [...root.querySelectorAll<HTMLElement>(options.selector ?? '*')].filter(el => hit(matcher, ownText(el)))
  const byRole = (role: string, options: { name?: Matcher } = {}): HTMLElement[] =>
    [...root.querySelectorAll<HTMLElement>(IMPLICIT[role] ?? `[role="${role}"]`)].filter(
      el => options.name === undefined || hit(options.name, nameOf(el)),
    )
  const byLabel = (matcher: Matcher): HTMLElement[] => {
    const found = new Set<HTMLElement>()
    for (const label of root.querySelectorAll('label')) {
      if (!hit(matcher, label.textContent ?? '')) continue
      const target = label.htmlFor
        ? document.getElementById(label.htmlFor)
        : label.querySelector('input,select,textarea')
      if (target instanceof HTMLElement) found.add(target)
    }
    for (const el of root.querySelectorAll<HTMLElement>('[aria-label]')) {
      if (hit(matcher, el.getAttribute('aria-label') ?? '')) found.add(el)
    }
    return [...found]
  }
  const one = <T>(found: T[], what: string): T => {
    if (found.length !== 1) throw new Error(describe(`${found.length} matches for ${what}`, root))
    return found[0] as T
  }
  const queries = {
    getAllByText: (m: Matcher, o?: { selector?: string }) => {
      const found = byText(m, o)
      if (found.length === 0) throw new Error(describe(`no text ${m}`, root))
      return found
    },
    getByText: (m: Matcher, o?: { selector?: string }) => one(byText(m, o), `text ${m}`),
    queryByText: (m: Matcher, o?: { selector?: string }) => byText(m, o)[0] ?? null,
    getAllByRole: (r: string, o?: { name?: Matcher }) => byRole(r, o),
    getByRole: (r: string, o?: { name?: Matcher }) => one(byRole(r, o), `role ${r} ${o?.name ?? ''}`),
    queryByRole: (r: string, o?: { name?: Matcher }) => byRole(r, o)[0] ?? null,
    getByLabelText: (m: Matcher) => one(byLabel(m), `label ${m}`),
    queryByLabelText: (m: Matcher) => byLabel(m)[0] ?? null,
  }
  return {
    ...queries,
    findByText: (m: Matcher, o?: { selector?: string }) => waitFor(() => queries.getByText(m, o)),
    findByRole: (r: string, o?: { name?: Matcher }) => waitFor(() => queries.getByRole(r, o)),
  }
}

export const screen = new Proxy({} as ReturnType<typeof within>, {
  get: (_target, key: keyof ReturnType<typeof within>) => within(document.body)[key],
})

/** Retry until `check` stops throwing, letting React and pending promises settle in between. */
export async function waitFor<T>(check: () => T, timeout = 1000): Promise<T> {
  const deadline = Date.now() + timeout
  for (;;) {
    try {
      return check()
    } catch (error) {
      if (Date.now() > deadline) throw error
    }
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
  }
}

let mounted: { root: Root; container: HTMLElement } | undefined

export function render(element: ReactElement): { container: HTMLElement } {
  cleanup()
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  act(() => root.render(element))
  mounted = { root, container }
  return { container }
}

export function cleanup(): void {
  if (mounted === undefined) return
  const { root, container } = mounted
  mounted = undefined
  act(() => root.unmount())
  container.remove()
}

/** Run a change that does not come from a user event (a Host update, a locale switch) and let React render it. */
export function update(change: () => void): void {
  act(change)
}

/** Let pending promises (Remote answers, saves) settle and React render their results. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

export const fireEvent = {
  click(el: Element): void {
    act(() => (el as HTMLElement).click())
  },
  /** Type into an input, textarea or select the way a user would, so React sees a real change. */
  change(el: Element, init: { target: { value: string } }): void {
    const proto = Object.getPrototypeOf(el) as object
    act(() => {
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, init.target.value)
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
    })
  },
}
