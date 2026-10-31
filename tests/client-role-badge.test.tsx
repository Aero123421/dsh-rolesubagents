// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { RoleBadge } from '../src/client/RoleBadge.tsx'
import { cleanup, render, screen } from './client-dom.ts'

afterEach(cleanup)

describe('role badges', () => {
  it.each([
    'general',
    'fork',
    'worker',
    'lightworker',
    'explorer',
    'reviewer',
    'tester',
    'debugger',
    'architect',
    'planner',
    'researcher',
    'writer',
    'security',
    'designer',
    'analyst',
    'devops',
    'optimizer',
    'translator',
  ])('renders %s with decorative local SVG and visible name', roleId => {
    render(<RoleBadge roleId={roleId} />)
    expect(screen.getByText(roleId)).toBeTruthy()
    const svg = document.querySelector('svg')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.getAttribute('focusable')).toBe('false')
    expect(svg?.querySelector('path')?.getAttribute('d')).toBeTruthy()
    expect(document.querySelector('img, use, script')).toBeNull()
  })

  it.each([
    ['coder', 'worker'],
    ['developer', 'worker'],
    ['implementer', 'worker'],
    ['qa', 'tester'],
    ['testing', 'tester'],
    ['debug', 'debugger'],
    ['planning', 'planner'],
    ['research', 'researcher'],
    ['docs', 'writer'],
    ['documentation', 'writer'],
    ['auditor', 'security'],
    ['security-auditor', 'security'],
    ['design', 'designer'],
    ['analysis', 'analyst'],
    ['sre', 'devops'],
    ['performance', 'optimizer'],
    ['localization', 'translator'],
  ])('uses the %s alias artwork without changing its visible name', (alias, preset) => {
    render(<RoleBadge roleId={preset} />)
    const path = document.querySelector('path')?.getAttribute('d')
    cleanup()
    render(<RoleBadge roleId={alias} />)
    expect(screen.getByText(alias)).toBeTruthy()
    expect(document.querySelector('path')?.getAttribute('d')).toBe(path)
  })

  it('does not guess icon roles from substrings', () => {
    render(<RoleBadge roleId="custom-security-team" />)
    expect(document.querySelector('path')?.getAttribute('d')).toContain('M8 3')
  })

  it('renders custom names as text, never markup', () => {
    const roleId = '<img src=x onerror=alert(1)>'
    render(<RoleBadge roleId={roleId} />)
    expect(screen.getByText(roleId)).toBeTruthy()
    expect(document.querySelector('img')).toBeNull()
    expect(document.querySelector('path')?.getAttribute('d')).toContain('M8 3')
  })

  it('does not treat inherited object keys as SVG presets', () => {
    render(<RoleBadge roleId="constructor" />)
    expect(document.querySelector('path')?.getAttribute('d')).toContain('M8 3')
  })
})
