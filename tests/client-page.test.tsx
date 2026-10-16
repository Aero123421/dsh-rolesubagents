// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { type Controller, createController } from '../src/client/controller.ts'
import { RolesPage } from '../src/client/RolesPage.tsx'
import { DEFAULT_ROLES } from '../src/shared/roles.ts'
import { cleanup, fireEvent, render, screen, settle, update, waitFor, within } from './client-dom.ts'
import { type FakeForm, fakeForm, fakeRemote, type FakeRemote } from './client-helpers.ts'

afterEach(cleanup)

interface MountOptions {
  form?: Parameters<typeof fakeForm>[0]
  locale?: string
  remote?: FakeRemote
  /** Load the model and preset lists up front, as if an editor had been opened before. */
  preload?: boolean
}

async function mount(options: MountOptions = {}) {
  const fake = fakeForm(options.form)
  const remote = options.remote ?? fakeRemote()
  const controller = createController({ form: fake.form, remote, locale: options.locale ?? 'en' })
  render(<RolesPage controller={controller} view="page" />)
  if (options.preload !== false) update(() => controller.loadReference())
  await settle()
  return { fake, remote, controller }
}

const rowOf = (id: string): HTMLElement => {
  const item = screen.getByText(id, { selector: '.dshrs-row-id' }).closest('li')
  if (item === null) throw new Error(`no row ${id}`)
  return item
}
const button = (name: string | RegExp) => screen.getByRole('button', { name })
const saved = async (fake: FakeForm) => {
  await settle()
  await waitFor(() => expect(fake.calls.length).toBeGreaterThan(0))
  await screen.findByText(/^Saved\./)
}

describe('role list', () => {
  it('shows one row per role in stored order with the badges the spec asks for', async () => {
    await mount()
    const ids = [...document.querySelectorAll('.dshrs-row-id')].map(node => node.textContent)
    expect(ids).toEqual(['general', 'fork', 'worker', 'explorer', 'reviewer'])
    expect(within(rowOf('general')).getByText('Built-in')).toBeTruthy()
    expect(within(rowOf('general')).getByText('Fresh')).toBeTruthy()
    expect(within(rowOf('fork')).getByText('Fork')).toBeTruthy()
    expect(within(rowOf('worker')).queryByText('Built-in')).toBeNull()
    expect(within(rowOf('explorer')).getByText('Read-only')).toBeTruthy()
    expect(within(rowOf('worker')).queryByText('Read-only')).toBeNull()
    expect(within(rowOf('worker')).getByText("Model: parent's model")).toBeTruthy()
    expect(screen.getByText('5 of 32 roles')).toBeTruthy()
  })

  it('offers delete only for custom roles and move buttons only where a move is possible', async () => {
    await mount()
    expect(screen.queryByRole('button', { name: 'Delete role general' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Delete role fork' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete role worker' })).toBeTruthy()
    expect((button('Move role general up') as HTMLButtonElement).disabled).toBe(true)
    expect((button('Move role reviewer down') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button('Move role worker up'))
    const ids = [...document.querySelectorAll('.dshrs-row-id')].map(node => node.textContent)
    expect(ids.slice(0, 3)).toEqual(['general', 'worker', 'fork'])
  })

  it('shows the model and preset of a role', async () => {
    const roles = DEFAULT_ROLES.map(role =>
      role.id === 'worker'
        ? {
            ...role,
            model: { provider: 'deepseek', model: 'deepseek-v4-pro', reasoningEffort: 'high' },
            agentPreset: 'ptc',
          }
        : role,
    )
    await mount({ form: { value: { enabled: true, roles } } })
    expect(within(rowOf('worker')).getByText('Model: deepseek / deepseek-v4-pro · high')).toBeTruthy()
    expect(within(rowOf('worker')).getByText('Preset: PTC')).toBeTruthy()
  })

  it('prefixes every class it renders, in every state of the page', async () => {
    await mount()
    fireEvent.click(button('Edit role worker'))
    fireEvent.click(screen.getByRole('switch', { name: 'Enable role worker' }))
    fireEvent.change(screen.getByLabelText('Role ID'), { target: { value: 'Bad Id' } })
    const names = [...document.querySelectorAll('[class]')].flatMap(node => [...node.classList])
    expect(names.length).toBeGreaterThan(50)
    expect(names.filter(name => !name.startsWith('dshrs-'))).toEqual([])
    expect(document.querySelector('.dshrs-off.dshrs-open')).not.toBeNull()
  })

  it('switches a role and the master switch, and reports unsaved changes', async () => {
    await mount()
    const master = screen.getByRole('switch', { name: 'Subagents' })
    expect(master.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('No changes')
    fireEvent.click(master)
    expect(master.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(screen.getByRole('switch', { name: 'Enable role worker' }))
    expect(within(rowOf('worker')).getByRole('switch').getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('status').textContent).toBe('Unsaved changes')
    expect((button('Save') as HTMLButtonElement).disabled).toBe(false)
  })

  it('adds, duplicates, templates and deletes roles', async () => {
    await mount()
    fireEvent.click(button('New role'))
    expect(rowOf('role')).toBeTruthy()
    fireEvent.click(button('Duplicate role worker'))
    expect(rowOf('worker-2')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Template'), { target: { value: 'reviewer' } })
    fireEvent.click(button('Add from template'))
    expect(rowOf('reviewer-2')).toBeTruthy()
    fireEvent.click(button('Delete role worker-2'))
    expect(screen.queryByText('worker-2', { selector: '.dshrs-row-id' })).toBeNull()
    expect(screen.getByText('7 of 32 roles')).toBeTruthy()
  })
})

describe('role editor', () => {
  it('moves the cursor into a new role and validates its id as it is typed', async () => {
    await mount()
    fireEvent.click(button('New role'))
    const id = screen.getByLabelText('Role ID') as HTMLInputElement
    expect(document.activeElement).toBe(id)
    expect(id.value).toBe('role')
    fireEvent.change(id, { target: { value: 'Bad Id' } })
    expect(id.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getAllByText(/is not valid/).length).toBeGreaterThan(0)
    expect(screen.getByText('Fix these before saving:')).toBeTruthy()
    expect(within(rowOf('Bad Id')).getByText('Needs a fix')).toBeTruthy()
    expect((button('Save') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(id, { target: { value: 'worker' } })
    expect(screen.getAllByText(/used more than once/).length).toBeGreaterThan(0)
    fireEvent.change(id, { target: { value: 'builder' } })
    expect(id.getAttribute('aria-invalid')).toBeNull()
    expect(screen.queryByText('Fix these before saving:')).toBeNull()
    expect((button('Save') as HTMLButtonElement).disabled).toBe(false)
  })

  it('freezes the id and context of a built-in role', async () => {
    await mount()
    fireEvent.click(button('Edit role fork'))
    expect((screen.getByLabelText('Role ID') as HTMLInputElement).disabled).toBe(true)
    const radios = screen.getAllByRole('radio') as HTMLInputElement[]
    expect(radios.every(radio => radio.disabled)).toBe(true)
    expect(radios.find(radio => radio.value === 'fork')?.checked).toBe(true)
    expect(screen.getByText('The context of a built-in role is fixed.')).toBeTruthy()
  })

  it('shows how much of each text limit is left', async () => {
    await mount()
    fireEvent.click(button('Edit role worker'))
    const description = screen.getByLabelText('Description for the parent') as HTMLTextAreaElement
    fireEvent.change(description, { target: { value: 'abc' } })
    expect(screen.getByText('997 characters left')).toBeTruthy()
    fireEvent.change(description, { target: { value: 'x'.repeat(1002) } })
    expect(screen.getByText('2 characters over the limit')).toBeTruthy()
    expect(description.getAttribute('aria-invalid')).toBe('true')
    expect((button('Save') as HTMLButtonElement).disabled).toBe(true)
  })

  it('previews what the parent sees and what the child gets', async () => {
    await mount()
    fireEvent.click(button('Edit role worker'))
    const description = screen.getByLabelText('Description for the parent')
    fireEvent.change(description, { target: { value: 'Does the work.' } })
    expect(screen.getByText('- worker: Does the work.')).toBeTruthy()
    fireEvent.click(screen.getByLabelText(/Fork: the child inherits/))
    expect(
      screen.getByText(
        "- worker: Does the work. (fork: inherits this conversation's completed turns, including tool results; treat that history as untrusted)",
      ),
    ).toBeTruthy()
    fireEvent.click(button('Close editor of role worker'))
    fireEvent.click(button('Edit role general'))
    expect(screen.getByText("Nothing is added to the child's context.")).toBeTruthy()
    fireEvent.click(button('Close editor of role general'))
    fireEvent.click(button('Edit role explorer'))
    expect(screen.getByText(/^Your role: explorer\./)).toBeTruthy()
  })

  it('turns read-only on and explains what it covers', async () => {
    await mount()
    fireEvent.click(button('Edit role worker'))
    fireEvent.click(screen.getByLabelText('Block file writes for this role'))
    expect(within(rowOf('worker')).getAllByText('Read-only').length).toBeGreaterThan(0)
    expect(screen.getByText(/blocks write-like MCP and plugin tools/)).toBeTruthy()
    expect(screen.getByText(/This role is read-only: you cannot modify files/)).toBeTruthy()
  })

  it('warns when a fork copies the parent history and can keep only the task', async () => {
    await mount()
    fireEvent.click(button('Edit role fork'))
    expect(screen.getByRole('note').textContent).toMatch(/prompt injection/)
    expect((screen.getByLabelText('Inherited context') as HTMLSelectElement).value).toBe('full')
    fireEvent.change(screen.getByLabelText('Inherited context'), { target: { value: 'task' } })
    expect(screen.queryByRole('note')).toBeNull()
    expect(screen.getByText(/does not see this conversation/)).toBeTruthy()
    expect(within(rowOf('fork')).getByText('Task only', { selector: '.dshrs-badge' })).toBeTruthy()
    expect(screen.getByText(/fork: task only, does not inherit this conversation/)).toBeTruthy()
  })

  it('disables model and preset for a fork role, clears them, and says why', async () => {
    const roles = DEFAULT_ROLES.map(role =>
      role.id === 'worker'
        ? { ...role, model: { provider: 'deepseek', model: 'deepseek-v4-pro' }, agentPreset: 'ptc' }
        : role,
    )
    await mount({ form: { value: { enabled: true, roles } } })
    fireEvent.click(button('Edit role worker'))
    await within(rowOf('worker')).findByRole('option', { name: 'DeepSeek' })
    expect((within(rowOf('worker')).getByLabelText('Provider') as HTMLSelectElement).disabled).toBe(false)
    fireEvent.click(screen.getByLabelText(/Fork: the child inherits/))
    const provider = within(rowOf('worker')).getByLabelText('Provider') as HTMLSelectElement
    expect(provider.disabled).toBe(true)
    expect(provider.value).toBe('')
    expect((screen.getByLabelText('Agent preset') as HTMLSelectElement).disabled).toBe(true)
    expect(screen.getByText(/Fork roles always use the parent's model/)).toBeTruthy()
    expect(screen.getByText('Fork roles cannot use an agent preset.')).toBeTruthy()
    expect(within(rowOf('worker')).getByText("Model: parent's model")).toBeTruthy()
    expect(within(rowOf('worker')).queryByText(/Preset:/)).toBeNull()
  })

  it('offers the catalog as provider, model and effort choices', async () => {
    await mount()
    fireEvent.click(button('Edit role worker'))
    await within(rowOf('worker')).findByRole('option', { name: 'DeepSeek' })
    expect(within(rowOf('worker')).queryByLabelText('Model')).toBeNull()
    fireEvent.change(within(rowOf('worker')).getByLabelText('Provider'), { target: { value: 'deepseek' } })
    const model = within(rowOf('worker')).getByLabelText('Model') as HTMLSelectElement
    expect(model.value).toBe('deepseek-v4-flash')
    fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: 'max' } })
    expect(within(rowOf('worker')).getByText('Model: deepseek / deepseek-v4-flash · max')).toBeTruthy()
    fireEvent.change(model, { target: { value: 'deepseek-v4-pro' } })
    expect(screen.queryByLabelText('Reasoning effort')).toBeNull()
    expect(within(rowOf('worker')).getByText('Model: deepseek / deepseek-v4-pro')).toBeTruthy()
    fireEvent.change(within(rowOf('worker')).getByLabelText('Provider'), { target: { value: '' } })
    expect(within(rowOf('worker')).getByText("Model: parent's model")).toBeTruthy()
  })

  it('keeps a stored route that the catalog no longer lists', async () => {
    const roles = DEFAULT_ROLES.map(role =>
      role.id === 'worker' ? { ...role, model: { provider: 'gone', model: 'old' } } : role,
    )
    await mount({ form: { value: { enabled: true, roles } } })
    fireEvent.click(button('Edit role worker'))
    await screen.findByRole('option', { name: 'gone (not listed)' })
    expect((within(rowOf('worker')).getByLabelText('Provider') as HTMLSelectElement).value).toBe('gone')
    expect(screen.getByRole('option', { name: 'old (not listed)' })).toBeTruthy()
  })

  it('falls back to typed ids when the catalog and the preset list are unavailable, and can retry', async () => {
    const remote = fakeRemote()
    remote.session.modelCatalog.mockRejectedValue(new Error('down'))
    remote.agentPresets.list.mockRejectedValue(new Error('down'))
    await mount({ remote, preload: false })
    fireEvent.click(button('Edit role worker'))
    await settle()
    await within(rowOf('worker')).findByText('The model list is unavailable. Type the IDs instead.')
    const provider = within(rowOf('worker')).getByLabelText('Provider') as HTMLInputElement
    expect(provider.tagName).toBe('INPUT')
    fireEvent.change(provider, { target: { value: 'acme' } })
    expect(screen.getAllByText(/needs both a provider and a model/).length).toBeGreaterThan(0)
    fireEvent.change(within(rowOf('worker')).getByLabelText('Model'), { target: { value: 'big' } })
    fireEvent.change(screen.getByLabelText('Reasoning effort'), { target: { value: 'deep' } })
    expect(within(rowOf('worker')).getByText('Model: acme / big · deep')).toBeTruthy()
    expect(screen.queryByText('Fix these before saving:')).toBeNull()
    const preset = screen.getByLabelText('Agent preset') as HTMLInputElement
    expect(preset.tagName).toBe('INPUT')
    fireEvent.change(preset, { target: { value: 'ptc' } })
    expect(within(rowOf('worker')).getByText('Preset: ptc')).toBeTruthy()
    remote.session.modelCatalog.mockResolvedValue({ ok: true, value: { groups: [], failures: [] } })
    fireEvent.click(within(rowOf('worker')).getByRole('button', { name: 'Retry' }))
    await settle()
    expect(remote.session.modelCatalog).toHaveBeenCalledTimes(3)
  })

  it('offers the agent presets and explains what a preset changes', async () => {
    await mount()
    fireEvent.click(button('Edit role worker'))
    const preset = (await screen.findByRole('option', { name: 'PTC' })).closest('select') as HTMLSelectElement
    expect(screen.getByText(/replaces the child's system prompt and tools/)).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Broken' })).toBeNull()
    fireEvent.change(preset, { target: { value: 'ptc' } })
    expect(within(rowOf('worker')).getByText('Preset: PTC')).toBeTruthy()
    fireEvent.change(preset, { target: { value: '' } })
    expect(within(rowOf('worker')).queryByText(/Preset:/)).toBeNull()
  })
})

describe('saving', () => {
  it('writes the draft once and tells the user when it applies', async () => {
    const { fake } = await mount()
    fireEvent.click(screen.getByRole('switch', { name: 'Subagents' }))
    fireEvent.click(button('Save'))
    expect(button('Saving…').getAttribute('aria-busy')).toBe('true')
    await saved(fake)
    expect(fake.calls).toHaveLength(1)
    expect(screen.getByRole('status').textContent).toBe(
      'Saved. Changes apply to new sessions; running sessions keep their roles and workflow default model.',
    )
    expect((button('Save') as HTMLButtonElement).disabled).toBe(true)
  })

  it('reports a failed save and lets the user try again', async () => {
    const { fake } = await mount()
    fake.outcome = 'throw'
    fireEvent.click(screen.getByRole('switch', { name: 'Subagents' }))
    fireEvent.click(button('Save'))
    await screen.findByText('Could not save. Check the connection and try again.')
    expect((button('Save') as HTMLButtonElement).disabled).toBe(false)
  })

  it('reports a conflict and reloads the latest settings on request', async () => {
    const { fake } = await mount()
    fake.outcome = 'refuse'
    fake.onRefuse = () => fake.set({ revision: 2, value: { enabled: false, roles: DEFAULT_ROLES } })
    fireEvent.click(screen.getByRole('switch', { name: 'Enable role worker' }))
    fireEvent.click(button('Save'))
    await screen.findByText('The settings changed on the Host after you started editing, so nothing was saved.')
    expect((button('Save') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button('Reload latest settings'))
    expect(screen.queryByText(/nothing was saved/)).toBeNull()
    expect(screen.getByRole('switch', { name: 'Subagents' }).getAttribute('aria-checked')).toBe('false')
    expect(within(rowOf('worker')).getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })

  it('discards edits', async () => {
    await mount()
    fireEvent.click(button('New role'))
    expect(screen.getByText('6 of 32 roles')).toBeTruthy()
    fireEvent.click(button('Discard'))
    expect(screen.getByText('5 of 32 roles')).toBeTruthy()
    expect((button('Discard') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('states', () => {
  it('says when the settings are loading or not served', async () => {
    const { fake } = await mount({ form: { status: 'loading', value: undefined, revision: undefined } })
    expect(screen.getByText('Loading settings…')).toBeTruthy()
    update(() => fake.set({ status: 'unavailable' }))
    expect(screen.getByText(/Role settings are not available/)).toBeTruthy()
    expect(screen.queryByRole('switch')).toBeNull()
  })

  it('renders read-only when the Host document is not writable', async () => {
    await mount({ form: { writable: false } })
    expect(screen.getByText('Settings are read-only on this Host.')).toBeTruthy()
    expect(screen.getAllByRole('switch').every(control => (control as HTMLButtonElement).disabled)).toBe(true)
    expect((button('New role') as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    fireEvent.click(button('Edit role worker'))
    expect((screen.getByLabelText('Description for the parent') as HTMLTextAreaElement).disabled).toBe(true)
  })

  it('says when the role limit is reached', async () => {
    const roles = [
      ...DEFAULT_ROLES.slice(0, 2),
      ...Array.from({ length: 30 }, (_, n) => ({ ...DEFAULT_ROLES[2], id: `r${n}` })),
    ]
    await mount({ form: { value: { enabled: true, roles } } })
    expect(screen.getByText('The limit of 32 roles is reached.')).toBeTruthy()
    expect((button('New role') as HTMLButtonElement).disabled).toBe(true)
  })

  it('lists the problems found in the stored settings', async () => {
    await mount({ form: { value: { enabled: true, roles: [{ id: 'Bad Id' }, ...DEFAULT_ROLES] } } })
    expect(screen.getByText(/had 1 problem\(s\) and are shown repaired/)).toBeTruthy()
  })

  it('renders nothing for the summary view', async () => {
    cleanup()
    const fake = fakeForm()
    const controller: Controller = createController({ form: fake.form, remote: fakeRemote(), locale: 'en' })
    const { container } = render(<RolesPage controller={controller} view="summary" />)
    expect(container.innerHTML).toBe('')
  })
})

describe('language', () => {
  it('shows Japanese chrome for a ja locale and keeps typed role text as it is', async () => {
    await mount({ locale: 'ja-JP' })
    expect(screen.getByRole('switch', { name: 'サブエージェント' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '新しいロール' })).toBeTruthy()
    expect(within(rowOf('fork')).getByText('フォーク')).toBeTruthy()
    expect(within(rowOf('worker')).getByText('モデル: 親と同じモデル')).toBeTruthy()
    expect(document.querySelector('.dshrs-root')?.getAttribute('lang')).toBe('ja')
    fireEvent.click(screen.getByRole('switch', { name: 'サブエージェント' }))
    expect(screen.getByRole('status').textContent).toBe('未保存の変更があります')
  })

  it('switches language live and falls back to English for other locales', async () => {
    const { controller } = await mount({ locale: 'fr' })
    expect(screen.getByRole('switch', { name: 'Subagents' })).toBeTruthy()
    update(() => controller.setLocale('ja'))
    expect(screen.getByRole('switch', { name: 'サブエージェント' })).toBeTruthy()
  })
})

describe('workflow model section', () => {
  it('loads a model-only picker, selects providers/models, saves and clears', async () => {
    const { fake, remote } = await mount({ preload: false })
    await settle()
    const picker = within(screen.getByText('Workflow model', { selector: 'legend' }).closest('fieldset') as HTMLElement)
    expect(remote.session.modelCatalog).toHaveBeenCalledTimes(1)
    expect(remote.agentPresets.list).not.toHaveBeenCalled()
    expect(picker.queryByLabelText('Reasoning effort')).toBeNull()
    expect(picker.queryByLabelText('Agent preset')).toBeNull()
    expect(picker.getByText(/Explicit workflow model overrides take priority/)).toBeTruthy()
    fireEvent.change(picker.getByLabelText('Provider'), { target: { value: 'deepseek' } })
    expect((picker.getByLabelText('Model') as HTMLSelectElement).value).toBe('deepseek-v4-flash')
    expect(picker.queryByLabelText('Reasoning effort')).toBeNull()
    fireEvent.change(picker.getByLabelText('Model'), { target: { value: 'deepseek-v4-pro' } })
    fireEvent.click(button('Save'))
    await saved(fake)
    expect(fake.calls[0]?.ops[2]).toMatchObject({ value: { provider: 'deepseek', model: 'deepseek-v4-pro' } })
    fireEvent.change(picker.getByLabelText('Provider'), { target: { value: 'other' } })
    expect((picker.getByLabelText('Model') as HTMLSelectElement).value).toBe('o1')
    fireEvent.change(picker.getByLabelText('Model'), { target: { value: '' } })
    expect((button('Save') as HTMLButtonElement).disabled).toBe(true)
    expect(picker.getByLabelText('Provider').getAttribute('aria-invalid')).toBe('true')
    fireEvent.change(picker.getByLabelText('Provider'), { target: { value: '' } })
    fireEvent.click(button('Save'))
    await settle()
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1]?.ops[2]).toMatchObject({ value: null })
    expect(remote.session.modelCatalog).toHaveBeenCalledTimes(1)
  })

  it('supports typed routes, validation, and explicit retry without repeated failed loads', async () => {
    const remote = fakeRemote()
    remote.session.modelCatalog.mockRejectedValue(new Error('down'))
    await mount({ remote, preload: false })
    await settle()
    const picker = within(screen.getByText('Workflow model', { selector: 'legend' }).closest('fieldset') as HTMLElement)
    fireEvent.change(picker.getByLabelText('Provider'), { target: { value: 'custom' } })
    expect((button('Save') as HTMLButtonElement).disabled).toBe(true)
    expect(picker.getByText(/workflow model needs both/)).toBeTruthy()
    fireEvent.change(picker.getByLabelText('Model'), { target: { value: 'custom-model' } })
    expect((button('Save') as HTMLButtonElement).disabled).toBe(false)
    expect(picker.queryByLabelText('Reasoning effort')).toBeNull()
    await settle()
    expect(remote.session.modelCatalog).toHaveBeenCalledTimes(1)
    fireEvent.click(picker.getByRole('button', { name: 'Retry' }))
    await settle()
    expect(remote.session.modelCatalog).toHaveBeenCalledTimes(2)
  })
})
