import { describe, expect, it } from 'vitest'
import { scrollPaddingBottom } from '../src/client/scroll-clearance.ts'

describe('scroll clearance', () => {
  it('covers the sticky bar and the scroller padding under it', () => {
    expect(scrollPaddingBottom(47, 48)).toBe(95)
    expect(scrollPaddingBottom(46.2, 48)).toBe(95)
    expect(scrollPaddingBottom(0, 0)).toBe(0)
    expect(scrollPaddingBottom(Number.NaN, 48)).toBe(48)
    expect(scrollPaddingBottom(40, Number.NaN)).toBe(40)
  })
})
