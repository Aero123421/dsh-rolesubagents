import { describe, expect, it } from 'vitest'
import { scrollPaddingBottom, shouldRevealProbe } from '../src/client/scroll-clearance.ts'

describe('scroll clearance', () => {
  it('covers the sticky bar and the scroller padding under it', () => {
    expect(scrollPaddingBottom(47, 48)).toBe(95)
    expect(scrollPaddingBottom(46.2, 48)).toBe(95)
    expect(scrollPaddingBottom(0, 0)).toBe(0)
    expect(scrollPaddingBottom(Number.NaN, 48)).toBe(48)
    expect(scrollPaddingBottom(40, Number.NaN)).toBe(40)
  })

  it('reveals a connection test only when one the user started has finished', () => {
    expect(shouldRevealProbe('loading', 'ready')).toBe(true)
    expect(shouldRevealProbe('loading', 'error')).toBe(true)
    expect(shouldRevealProbe('idle', 'ready')).toBe(false)
    expect(shouldRevealProbe('ready', 'ready')).toBe(false)
    expect(shouldRevealProbe('idle', 'idle')).toBe(false)
    expect(shouldRevealProbe('loading', 'loading')).toBe(false)
  })
})
