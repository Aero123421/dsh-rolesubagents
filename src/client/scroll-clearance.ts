/**
 * Keep the sticky save bar from covering the last lines in DSH's page scroller.
 *
 * The bar stays `position: sticky; bottom: 0`. On DSH Web the scroller is an
 * ancestor with `overflow: auto` and its own `padding-bottom`, so the sticky
 * edge sits on that padding edge rather than on the border edge. Content then
 * shows in the padding and slides under the bar. `scroll-padding-bottom` on
 * that scroller is the bar's height plus the scroller's padding, which is the
 * band actually covered.
 */

/** Pixels of `scroll-padding-bottom` that clear a sticky bar of `barHeight` inside a scroller padded by `paddingBottom`. */
export function scrollPaddingBottom(barHeight: number, paddingBottom: number): number {
  const bar = Number.isFinite(barHeight) ? Math.max(0, barHeight) : 0
  const pad = Number.isFinite(paddingBottom) ? Math.max(0, paddingBottom) : 0
  return Math.ceil(bar + pad)
}

/** A connection test should move the page only after the user starts it and it finishes. */
export function shouldRevealProbe(
  previous: 'idle' | 'loading' | 'ready' | 'error',
  next: 'idle' | 'loading' | 'ready' | 'error',
): boolean {
  return previous === 'loading' && next !== 'loading'
}

/** The nearest ancestor that scrolls vertically, or null when the page itself does not. */
export function scrollPortOf(start: Element | null): HTMLElement | null {
  let el = start?.parentElement ?? null
  while (el !== null) {
    const overflow = getComputedStyle(el).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return el
    el = el.parentElement
  }
  return null
}

/**
 * Point the page scroller's `scroll-padding-bottom` at the covered band, and
 * keep it in step with the bar's height. Restores the previous inline value.
 * @param root - the plugin page root, or null before it is mounted.
 * @returns a function that removes the observer and the inline padding.
 */
export function bindScrollClearance(root: HTMLElement | null): () => void {
  if (root === null) return () => {}
  const footer = root.querySelector<HTMLElement>('.dshrs-footer')
  const port = scrollPortOf(root)
  if (footer === null || port === null) return () => {}
  const previous = port.style.scrollPaddingBottom
  const apply = () => {
    const bar = footer.getBoundingClientRect().height
    const pad = Number.parseFloat(getComputedStyle(port).paddingBottom) || 0
    port.style.scrollPaddingBottom = `${scrollPaddingBottom(bar, pad)}px`
  }
  apply()
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(apply)
  observer?.observe(footer)
  return () => {
    observer?.disconnect()
    port.style.scrollPaddingBottom = previous
  }
}
