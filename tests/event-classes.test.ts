/**
 * The child-history classifier names every session event DSH 0.2.1-alpha.3 can write.
 * A type missing from both lists would fail closed and can reject a legitimate child.
 */

import { KNOWN_SESSION_EVENT_TYPES } from '../node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js'
import { describe, expect, it } from 'vitest'
import { sessionEventClass } from '../src/host/readonly.ts'

describe('DSH 0.2.1-alpha.3 session events', () => {
  it('classifies every known event type', () => {
    expect(KNOWN_SESSION_EVENT_TYPES.size).toBeGreaterThan(0)
    const unseen: string[] = []
    for (const type of KNOWN_SESSION_EVENT_TYPES) {
      if (sessionEventClass(type) === 'unknown') unseen.push(type)
    }
    expect(unseen).toEqual([])
  })
})
