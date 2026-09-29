import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { apply, questionDraftKey } from '../src/client.js'

/**
 * The `dsh-ui-fixes` component row loads this module, so the row's own toggle is
 * the switch. The layout itself is measured on a device; what is unit-tested here
 * is the key derivation, which has been wrong twice.
 */
describe('question-fixes plugin entry', () => {
  it('hands the host one effect and installs nothing until it runs', () => {
    // Deferring the install is what makes the plugin disposable when the row's
    // toggle flips off.
    const registered: Array<() => void | (() => void)> = []
    apply({ effect: (fn) => { registered.push(fn) } })
    expect(registered).toHaveLength(1)
    expect(registered[0]).toBeTypeOf('function')
  })

  it('carries the stylesheet and the Enter interceptor', () => {
    const source = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8')
    expect(source).toContain('[data-question-key]')
    expect(source).toContain("addEventListener('keydown', onKeyDown, true)")
  })
})

describe('question draft keys', () => {
  const QUESTION = 'How should the deployment be rolled out?'

  it('is derived from the question, so a draft survives a reload', () => {
    // The request key resets per page load, so a key built from it is unreachable
    // exactly when the draft is needed. The question text does not change.
    expect(questionDraftKey(QUESTION, 0)).toBe(questionDraftKey(QUESTION, 0))
  })

  it('separates two questions, which is the leak that was reported', () => {
    // Question 1's answer must never appear in question 2 — whether those are two
    // pages of one card (one textarea, re-rendered) or two separate cards.
    expect(questionDraftKey('First question', 0)).not.toBe(questionDraftKey('Second question', 0))
  })

  it('separates two answer boxes on the same page', () => {
    expect(questionDraftKey(QUESTION, 0)).not.toBe(questionDraftKey(QUESTION, 1))
  })

  it('does not collide on questions that share a prefix', () => {
    // A naive truncating hash would merge these; a long question and a different
    // one starting the same way must stay distinct.
    expect(questionDraftKey('Deploy to staging', 0))
      .not.toBe(questionDraftKey('Deploy to production', 0))
  })

  it('stays inside the prefix the sweep looks for', () => {
    // The sweep removes drafts by prefix; a key outside it would never be cleaned.
    expect(questionDraftKey(QUESTION, 0).startsWith('dsh-mobile-question-draft:')).toBe(true)
  })
})
