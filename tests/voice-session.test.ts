import { describe, expect, it } from 'vitest'
import { phaseIsDictating } from '../src/voice-session.js'

/**
 * Which voice-input phases count as dictating — the single predicate behind both
 * the screen wake lock and the keyboard dismissal.
 *
 * This is the whole decision the module makes, and the only part worth a unit
 * test: the request/blur wiring needs a real browser and is checked there.
 * Getting a phase wrong means a phone that sleeps mid recording, a screen that
 * never sleeps again after one, or a keyboard that fights the user.
 */
describe('screen wake phases', () => {
  it('holds the screen while audio is being captured or turned into text', () => {
    for (const phase of ['requesting', 'recording', 'transcribing']) {
      expect(phaseIsDictating(phase), phase).toBe(true)
    }
  })

  it('releases the screen for every phase where nothing is being captured', () => {
    for (const phase of [
      'idle', 'standby', 'ready', 'feedback',
      'downloading', 'cancelled', 'cancelling', 'failed',
    ]) {
      expect(phaseIsDictating(phase), phase).toBe(false)
    }
  })

  it('treats a missing or unknown phase as releasing the screen', () => {
    // The attribute is absent before the voice component mounts, and an unknown
    // value means a phase this build does not know about. Both must let the
    // screen sleep: holding it on an unrecognized value is how a phone ends up
    // never sleeping again.
    for (const phase of [null, undefined, '', 'something-new']) {
      expect(phaseIsDictating(phase), String(phase)).toBe(false)
    }
  })

  it('is not confused by a phase that merely contains a held one', () => {
    // `cancelling` contains `cancell` and `transcribing-failed` contains
    // `transcribing`; a substring match would hold the screen for both.
    expect(phaseIsDictating('transcribing-failed')).toBe(false)
    expect(phaseIsDictating('not-recording')).toBe(false)
  })
})
