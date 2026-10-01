/**
 * What the mobile surface must do for the duration of a dictation.
 *
 * A phone with a 15-30 s screen timeout turns the display off mid-dictation, and
 * on Android that also stops the touch input the user is about to need. The
 * transcriber is still running, so the recording is not lost — but the user comes
 * back to a locked screen having no idea whether it worked.
 *
 * The DSH voice-input component publishes its state as `data-voice-activity` on
 * its capture row, which is the only signal this needs: no coupling to that
 * plugin's internals, no native bridge, and it keeps working if that component is
 * re-rendered.
 *
 * Uses the Screen Wake Lock API, which needs a secure context and Chromium 84+.
 * The Android app loads https only (`GatewayUrlPolicy`), so it qualifies — but
 * every call is feature-detected, because a browser without the API must simply
 * behave as it does today rather than break the surface it runs in.
 */

/** Voice phases during which the user is dictating. */
const DICTATING_PHASES: readonly string[] = ['requesting', 'recording', 'transcribing']

/**
 * Whether this voice-input phase means the user is dictating.
 *
 * Exact membership, not a substring test: `transcribing-failed` and
 * `not-recording` are not phases this ships, and treating an unrecognized value
 * as active would hold the screen on forever and fight the keyboard.
 */
export function phaseIsDictating(phase: string | null | undefined): boolean {
  return typeof phase === 'string' && DICTATING_PHASES.includes(phase)
}

/** The subset of the Screen Wake Lock API this uses. */
interface WakeLockSentinel {
  released: boolean
  release(): Promise<void>
  addEventListener(type: 'release', listener: () => void): void
}

/** The wake lock API, or undefined where the browser does not offer it. */
function wakeLockApi(): { request(type: 'screen'): Promise<WakeLockSentinel> } | undefined {
  const api = (navigator as Navigator & {
    wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> }
  }).wakeLock
  return api === undefined ? undefined : api
}

/**
 * Apply every dictation-time behaviour: hold the screen on, and keep the soft
 * keyboard down.
 *
 * Returns a disposer that also releases any lock still held, so unloading the
 * plugin cannot leave a device unable to sleep.
 */
export function installVoiceSession(): () => void {
  const api = wakeLockApi()
  if (api === undefined) return () => {}

  let sentinel: WakeLockSentinel | null = null
  let disposed = false

  /** Release anything held. Safe to call when nothing is held. */
  const release = (): void => {
    const held = sentinel
    sentinel = null
    if (held !== null && !held.released) void held.release().catch(() => {})
  }

  /** Acquire if the current phase wants it and nothing is held yet. */
  const acquireIfWanted = (): void => {
    if (disposed || sentinel !== null) return
    if (!phaseIsDictating(currentPhase())) return
    // A rejection is expected and harmless: the page may be hidden, which is
    // exactly when the browser refuses. The visibility listener below retries.
    void api.request('screen').then((lock) => {
      // The browser releases the lock itself when the page becomes hidden, and
      // fires this event when it does. Clearing the reference here is what lets
      // the visibility listener acquire a new one — without it the module would
      // still believe it held a lock that is long gone, and the screen would be
      // free to sleep again for the rest of the recording.
      lock.addEventListener('release', () => { if (sentinel === lock) sentinel = null })
      // The phase can also end while the request is in flight.
      if (disposed || !phaseIsDictating(currentPhase())) void lock.release().catch(() => {})
      else sentinel = lock
    }, () => {})
  }

  const currentPhase = (): string | null =>
    document.querySelector('[data-voice-activity]')?.getAttribute('data-voice-activity') ?? null

  /**
   * Treat a focused text field as one that will raise the soft keyboard.
   *
   * On the Android WebView, an explicit `focus()` raises the IME again even when
   * the user had already dismissed it with Back — the element keeps DOM focus, so
   * the keyboard's absence is not visible in `document.activeElement`.
   */
  const isTextField = (node: Element | null): node is HTMLElement =>
    node instanceof HTMLElement
    && (node.isContentEditable || node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement)

  /**
   * Drop focus from whatever text field holds it, so the keyboard goes with it.
   *
   * Only called on a phase *transition* into dictating. A standing guard that
   * blurred on every `focusin` would fight the composer's own auto-focus effect
   * in a loop, and the composer re-focuses only when its own state changes —
   * which is the transition this catches.
   */
  const dismissKeyboard = (): void => {
    const active = document.activeElement
    if (isTextField(active)) active.blur()
  }

  let lastPhase: string | null = null
  const apply = (): void => {
    const phase = currentPhase()
    // Entering a dictating phase is the moment the composer re-focuses its editor
    // and the keyboard appears, so that is the moment to take focus away.
    if (phaseIsDictating(phase) && !phaseIsDictating(lastPhase)) dismissKeyboard()
    lastPhase = phase

    if (phaseIsDictating(phase)) acquireIfWanted()
    else release()
  }

  // The attribute only changes when that component re-renders, which is exactly
  // when the phase changes, so a child-list observer sees every transition.
  const observer = new MutationObserver(apply)
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-voice-activity'],
  })

  // The browser drops the lock whenever the page becomes hidden — backgrounding
  // the app, switching tabs, or the screen going off on its own. Re-acquiring on
  // the way back is what makes this survive more than the first timeout.
  const onVisibility = (): void => { if (!document.hidden) apply() }
  document.addEventListener('visibilitychange', onVisibility)

  apply()

  return () => {
    disposed = true
    observer.disconnect()
    document.removeEventListener('visibilitychange', onVisibility)
    release()
  }
}
