// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { ExternalRunDialog } from '../src/client/ExternalRunDialog.tsx'
import type { ExternalRunsState } from '../src/client/external-runs.ts'
import type { ExternalRunDisplay } from '../src/shared/role-display.ts'
import { cleanup, fireEvent, render, screen, settle, update } from './client-dom.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
const run: ExternalRunDisplay = {
  id: 'run-1',
  parentSessionId: 'parent',
  label: 'Review',
  roleId: 'reviewer',
  cli: 'codex',
  status: 'succeeded',
  startedAt: '2026-10-29T00:00:00Z',
  endedAt: '2026-10-29T00:00:05Z',
  resultText: 'Safe result <img src=x onerror=bad()>',
  resultTruncated: false,
}
function state(entry = run): ExternalRunsState {
  return {
    byId: { [entry.id]: entry },
    unavailable: false,
    loading: false,
    durable: true,
    byParent: {
      parent: {
        byId: { [entry.id]: entry },
        loading: false,
        error: false,
        stale: false,
        fetchedAt: Date.now(),
        durable: true,
      },
    },
  }
}
function mount(value = state()) {
  const onClose = vi.fn(),
    onOpenParent = vi.fn()
  render(
    <>
      <button type="button">Parent chat input</button>
      <ExternalRunDialog
        id={run.id}
        label={run.label}
        state={value}
        locale="en"
        parentSessionId="parent"
        onOpenParent={onOpenParent}
        onClose={onClose}
      />
    </>,
  )
  return { onClose, onOpenParent }
}
it('does not block parent chat interaction and preserves plain text safely', () => {
  const { onClose, onOpenParent } = mount()
  const dialog = screen.getByRole('dialog')
  expect(dialog.getAttribute('aria-modal')).toBe('false')
  expect(document.querySelector('.dshrs-run-backdrop')).toBeNull()
  expect(dialog.querySelector('img')).toBeNull()
  expect(dialog.textContent).toContain(run.resultText)
  const parent = screen.getByRole('button', { name: 'Parent chat input' })
  update(() => parent.focus())
  expect(document.activeElement).toBe(parent)
  fireEvent.click(screen.getByRole('button', { name: 'Open parent chat' }))
  expect(onOpenParent).toHaveBeenCalledTimes(1)
  update(() => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(onClose).toHaveBeenCalledTimes(1)
})
it('copies only available text and truthfully labels truncated previews', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  mount(state({ ...run, resultTruncated: true }))
  fireEvent.click(screen.getByRole('button', { name: 'Copy preview' }))
  await settle()
  expect(writeText).toHaveBeenCalledWith(run.resultText)
  expect(screen.getByRole('dialog').textContent).toContain('Copy includes only the visible preview')
  expect(screen.getByRole('dialog').textContent).toContain('Copied')
})
it('shows clipboard failure with a manual selection fallback', async () => {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    configurable: true,
  })
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Copy result' }))
  await settle()
  expect(screen.getByRole('dialog').textContent).toContain('Copy failed')
  expect(document.activeElement?.tagName).toBe('PRE')
})
it('uses parent-specific freshness when another parent has failed', () => {
  const value = state()
  value.unavailable = true
  value.byParent.other = { byId: {}, error: true, stale: false, loading: false, fetchedAt: null, durable: false }
  mount(value)
  expect(screen.getByRole('dialog').textContent).not.toContain('could not be refreshed')
  expect(screen.getByRole('dialog').textContent).not.toContain('Last known status')
})
it('never describes stale running data as live running', () => {
  const value = state({ ...run, status: 'running', endedAt: undefined, resultText: undefined })
  value.byParent.parent!.error = true
  value.byParent.parent!.stale = true
  mount(value)
  expect(screen.getByRole('dialog').textContent).toContain('Last known status')
  expect(screen.getByRole('dialog').textContent).not.toContain('Running in the background')
})
it('keeps internal IDs in collapsed details and provides readable/raw views', () => {
  mount()
  const details = document.querySelector('details')!
  expect(details.open).toBe(false)
  expect(details.textContent).toContain(run.id)
  expect(details.textContent).toContain('Actual model / effort')
  const raw = screen.getByRole('button', { name: 'Raw text' })
  expect(raw.getAttribute('aria-pressed')).toBe('false')
  fireEvent.click(raw)
  expect(raw.getAttribute('aria-pressed')).toBe('true')
  expect(document.querySelector('pre')?.className).toBe('dshrs-run-raw')
})
