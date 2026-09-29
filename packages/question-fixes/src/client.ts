
/**
 * Experimental question-card fixes, carried by dsh-mobile.
 *
 * DSH's `ask_user_question` card caps itself at `min(60vh, 520px)` with
 * `overflow: hidden` while `.header` (the question text) is `flex-shrink: 0`.
 * A question taller than that cap therefore cannot shrink, the options body
 * below it absorbs the whole shortfall and collapses to zero height, and the
 * card clips what is left — so a long question hides its own answers and
 * neither half can be scrolled to. `packages/client/ui-user-questions` owns
 * that bug and it is reported upstream; it is not mobile-specific.
 *
 * It lives here, off by default, because the fix has to reach into another
 * plugin's DOM: it enforces layout with inline `!important` (a stylesheet
 * override of `max-height` on this card was measurably beaten by the shipped
 * rule on a phone), re-writes the header's typography, intercepts Enter in the
 * answer box and mirrors drafts into `localStorage`. That is too invasive to
 * switch on for every user, so it is a preference.
 *
 * UPSTREAM EXIT: the card rules stand down on their own once DSH removes the
 * cap — the feature detection below measures the shipped `max-height` per card
 * and stops fighting when it computes to `none`.
 */

/** Whether the experimental question-card layout fixes are on. Default off. */
export const QUESTION_FIXES_STORAGE_KEY = 'dsh-mobile-question-fixes'

/** Read the stored preference. Anything but the exact opt-in string means off. */
export function questionFixesEnabled(): boolean {
  try {
    return localStorage.getItem(QUESTION_FIXES_STORAGE_KEY) === 'on'
  } catch {
    return false
  }
}

/** Persist the preference and apply it with a reload, since inline styles cannot be un-written. */
export function setQuestionFixesEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(QUESTION_FIXES_STORAGE_KEY, enabled ? 'on' : 'off')
  } catch {
    // Private mode or a full quota: the toggle simply will not persist.
  }
}

/** Stylesheet half of the fixes. A first pass; the effects below enforce where CSS loses. */
export const QUESTION_FIX_CSS = `/* ---------------------------------------------------------------------------
 * 1. QuestionComposer: show the whole question, nothing pinned inside it.
 *    First pass only; the JavaScript half enforces this where CSS loses.
 * ------------------------------------------------------------------------- */
[data-question-key] *:has(> [data-question-scroll]) {
  display: flex !important;
  flex-direction: column !important;
  max-height: none !important;
  overflow: visible !important;
}

[data-question-key] *:has(> [data-question-scroll]) > * {
  position: static !important;
  flex: 0 0 auto !important;
  max-height: none !important;
}

[data-question-key] [data-question-scroll] {
  flex: 0 0 auto !important;
  overflow-y: visible !important;
  overscroll-behavior: auto !important;
}

/* The custom answer box is measured through a hidden mirror capped at 144px, so
   the box stops growing there and grows a scrollbar of its own. */
[data-question-key] textarea {
  field-sizing: content !important;
  max-height: none !important;
  overflow-y: hidden !important;
}

[data-question-key] [class*="_fieldMirror"] {
  max-height: none !important;
}

[data-question-key] [class*="_fieldInput"] {
  overflow-y: hidden !important;
}

/* ---------------------------------------------------------------------------
 * 2. Composer text on a short viewport.
 *
 * Vanilla caps the composer text at a flat 336px. On a short window that plus
 * the toolbar occupies most of the screen and buries the conversation. Cap it
 * against the viewport too, so a tall window keeps vanilla behaviour exactly.
 *
 * The seat attribute is doubled up with the region attribute to outrank the
 * vanilla single-class rule regardless of stylesheet order.
 * ------------------------------------------------------------------------- */
[data-composer-seat][data-conversation-region="composer"] {
  --dsh-composer-text-max-height: min(336px, 45vh);
}

/* ---------------------------------------------------------------------------
 * 3. The composer and the question card scroll with the transcript.
 *
 * Vanilla floats the seat over the conversation: position sticky, bottom 0,
 * while a conversation is active, and position absolute, bottom 0, once a
 * question or plan-review card takes the composer over. Either way scrolling up
 * never yields a full screen of transcript, because the seat stays over it.
 *
 * In the hero phase the seat has no position at all, so this is a no-op there
 * and only changes the active and overlay cases.
 * ------------------------------------------------------------------------- */
[data-composer-seat] {
  position: static !important;
}

/* The overlay case also clips the conversation and pins its flex basis, which
   has to be undone or the content the seat should scroll past cannot grow. */
[data-conversation-scroll]:has([data-conversation-composer-overlay]) [class*="_viewArea"] {
  flex: 1 0 auto !important;
  min-height: auto !important;
  overflow: visible !important;
}

/* The scroll-to-bottom button sits above the composer by a measured offset.
   With the seat in flow there is nothing to sit above, so pin it to the
   viewport bottom instead, which is where the composer is not. */
[data-conversation-scroll] [class*="_toBottomSlot"] {
  bottom: 16px !important;
}

/* The colour-coded border debug that used to sit here has been removed. It
   served its purpose: the yellow heading block stopped short of the orange
   header while the cyan card reached the edge, proving the header actions
   column was reserving the width beside the question text. */

/* ---------------------------------------------------------------------------
 * 4. Question header: give the text the full card width.
 *
 * .header is a flex row, so .headingBlock (the question) and .headerActions
 * (minimise + close) are columns side by side. The actions reserve their width
 * for the entire height of the header, which was invisible while the header was
 * clipped to a couple of lines but costs a dead strip down the whole side of a
 * long question — measured on the phone as ~235px of unused width against a
 * ~1750px tall question.
 *
 * Taking the actions out of the row lets the text use the full width. They
 * overlay the top right instead, and the heading block is pushed below them so
 * nothing overlaps.
 * ------------------------------------------------------------------------- */
[data-question-key] header[class*="_header"] {
  display: block !important;
  position: relative !important;
}

[data-question-key] [class*="_headerActions"] {
  position: absolute !important;
  top: 20px !important;
  right: 16px !important;
}

[data-question-key] [class*="_headingBlock"] {`

/**
 * Apply the fixes to one card. Idempotent, so it can run on a timer.
 *
 * `stillCapped` is measured once per card element and remembered: measuring means
 * clearing our own override first, which collapses the card for a frame, so doing
 * it on every tick would flicker. It also retires the rules once upstream drops
 * the cap.
 */
function enforceQuestionCardFixes(): void {
  const frame = document.querySelector<HTMLElement>('[data-question-key]')
  if (frame === null) return
  const body = frame.querySelector<HTMLElement>('[data-question-scroll]')
  // Collapsing the card removes the body from the page, so locating the card
  // through it would bail out at exactly the moment the collapse behaviour needs
  // these rules. Fall back to the frame's own child, which is the card in both
  // states.
  const card = (body !== null ? body.parentElement : frame.firstElementChild) as HTMLElement | null

  const set = (el: Element | null, props: Record<string, string>): void => {
    if (!(el instanceof HTMLElement)) return
    for (const [name, value] of Object.entries(props)) el.style.setProperty(name, value, 'important')
  }

  let stillCapped = true
  if (card !== null) {
    const known = CARD_CAP_STATE.get(card)
    if (known === undefined) {
      card.style.removeProperty('max-height')
      stillCapped = getComputedStyle(card).maxHeight !== 'none'
      CARD_CAP_STATE.set(card, stillCapped)
    } else {
      stillCapped = known
    }
  }

  if (stillCapped) {
    set(frame, { 'max-height': 'none', height: 'auto', overflow: 'visible' })
    set(card, {
      'max-height': 'none',
      height: 'auto',
      overflow: 'visible',
      display: 'flex',
      'flex-direction': 'column',
    })
    set(body, { 'max-height': 'none', 'overflow-y': 'visible', flex: '0 0 auto' })
  }

  // Nothing inside the card may be lifted out of flow, or the pager and the
  // Skip/Next row get painted over an answer option.
  if (card !== null) {
    for (const child of card.children) {
      set(child, { 'max-height': 'none', position: 'static', flex: '0 0 auto' })
    }
  }

  // The header is a flex row, so the actions column reserves its width for the
  // whole height of the header — a dead strip beside a long question. Take the
  // actions out of the row and overlay them, then push the heading below them.
  // `position: relative` has to be inline: the stylesheet form did not take on a
  // phone, and the buttons anchored to the screen instead of the card.
  const header = card === null ? null : card.querySelector('header')
  const actions = card === null ? null : card.querySelector<HTMLElement>('[class*="_headerActions"]')
  const heading = card === null ? null : card.querySelector<HTMLElement>('[class*="_headingBlock"]')
  const eyebrow = heading === null ? null : heading.querySelector<HTMLElement>('[class*="_eyebrow"]')

  set(header, { display: 'block', position: 'relative' })
  set(actions, { position: 'absolute', top: '20px', right: '16px' })
  set(heading, { display: 'block' })

  // The label is given the buttons' own measured height and centred in it, so the
  // two line up without a hard-coded number that drifts when the buttons change.
  const actionsHeight = actions === null ? 0 : Math.round(actions.getBoundingClientRect().height)
  const clearance = actionsHeight > 0 ? `${actionsHeight}px` : '48px'
  if (eyebrow !== null) {
    set(eyebrow, { 'min-height': clearance, display: 'flex', 'align-items': 'center', 'padding-right': '108px' })
    set(heading, { 'padding-top': '0px' })
  } else {
    set(heading, { 'padding-top': clearance })
  }

  // The short header label reads as the heading and the question as the body, the
  // other way round from the shipped sizes. Line heights are tightened to compress
  // the card.
  const title = card === null ? null : card.querySelector('h2')
  set(eyebrow, {
    'font-size': '15px',
    'line-height': '20px',
    'font-weight': '500',
    color: 'var(--dsw-alias-label-primary)',
  })
  set(title, { 'font-size': '14px', 'line-height': '19px', 'font-weight': '400' })

  // Vanilla removes only the options when collapsed and keeps the header, which
  // leaves a long question occupying the screen the collapse was meant to free.
  const minimized = card !== null && /_cardMinimized/.test(card.className)
  if (title !== null) {
    if (minimized) set(title, { display: 'none' })
    else title.style.removeProperty('display')
  }

  // A collapsed card holds only the label and the button row, so it can be
  // tighter. Every value is set in both states because these are inline and would
  // otherwise stick.
  const footer = card === null ? null : card.querySelector('footer')
  set(header, {
    'padding-top': minimized ? '4px' : '20px',
    'padding-bottom': minimized ? '4px' : '0px',
  })
  set(card, { 'padding-bottom': minimized ? '2px' : '10px' })
  set(footer, { 'margin-top': minimized ? '4px' : '12px' })

  // The buttons' box sets the floor. Collapsed it shrinks to just over the icon
  // and the label is matched to it.
  const COLLAPSED_BOX = 26
  if (minimized) {
    set(actions, { height: `${COLLAPSED_BOX}px` })
    set(eyebrow, { 'min-height': `${COLLAPSED_BOX}px` })
  } else {
    if (actions !== null) actions.style.removeProperty('height')
    if (eyebrow !== null) set(eyebrow, { 'min-height': `${actionsHeight}px` })
  }

  // Line the label up with the buttons by measurement rather than arithmetic: the
  // offset is cleared first, so each tick computes the same absolute correction
  // instead of compounding the previous one.
  if (eyebrow !== null && actions !== null) {
    set(eyebrow, { 'margin-top': '0px' })
    const aBox = actions.getBoundingClientRect()
    const eBox = eyebrow.getBoundingClientRect()
    const shift = Math.round(aBox.top + aBox.height / 2 - (eBox.top + eBox.height / 2))
    if (shift !== 0) set(eyebrow, { 'margin-top': `${shift}px` })
  }
}

/** Whether the card still caps itself, measured once per card element. */
const CARD_CAP_STATE = new WeakMap<HTMLElement, boolean>()

/** Insert a newline into a controlled textarea, which ignores a plain value write. */
function insertTextareaNewline(el: HTMLTextAreaElement): void {
  if (document.execCommand('insertText', false, '\n')) return
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  if (setter === undefined) return
  const start = el.selectionStart ?? el.value.length
  setter.call(el, `${el.value.slice(0, start)}\n${el.value.slice(el.selectionEnd ?? start)}`)
  el.selectionStart = start + 1
  el.selectionEnd = start + 1
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

/**
 * Install the fixes and return their disposer.
 *
 * Prefer `installQuestionCardFixes` from the plugin body; this exists so the
 * behaviour can be exercised on its own.
 */
export function installQuestionFixes(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = 'dsh-mobile-question-fixes'
  style.textContent = QUESTION_FIX_CSS
  document.head.append(style)

  // Enter in the card's answer box submits the whole question. Vanilla does that
  // on purpose; it is wrong on a phone keyboard, where Enter is the only newline
  // key there is. React listens at its root container, so a capture-phase
  // listener on the document runs first and stopping propagation keeps the
  // component's handler from firing at all.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
    const el = event.target
    if (!(el instanceof HTMLTextAreaElement) || el.closest('[data-question-key]') === null) return
    event.preventDefault()
    event.stopPropagation()
    insertTextareaNewline(el)
  }
  document.addEventListener('keydown', onKeyDown, true)

  const timer = setInterval(enforceQuestionCardFixes, 700)
  const draftDispose = installQuestionDraftMirror()
  enforceQuestionCardFixes()

  return () => {
    clearInterval(timer)
    draftDispose()
    document.removeEventListener('keydown', onKeyDown, true)
    style.remove()
  }
}

/** Every draft this bundle owns starts with this, so the sweep can find them. */
const DRAFT_PREFIX = 'dsh-mobile-question-draft:'

/**
 * Stable identity for a question, so a draft survives a reload.
 *
 * The request key cannot serve: DSH numbers requests from a module-level counter
 * that resets on every page load, so the same pending question is `question:3`
 * before a reload and `question:1` after it. Anything keyed on it is unreachable
 * the moment the page is reloaded — which is exactly when the draft is needed.
 * The question's own text is what stays the same, so the key is a hash of it.
 *
 * Hashing also removes the paging hazard for free: each page of a card has
 * different text, so two questions can never share a draft, whether they are
 * separate pages of one card or separate cards.
 *
 * Exported because this is the part that has been wrong twice — first keyed on
 * the field's position (always 0, because the whole request is paged through one
 * textarea), then on the request key (unstable across reloads). Both are
 * unit-tested, which a DOM-driving test could not do reliably.
 */
export function questionDraftKey(questionText: string, fieldIndex: number): string {
  // FNV-1a, 32-bit. A collision would need two questions with the same hash to be
  // open at once, and the alternative is a crypto dependency for a local key.
  let hash = 0x811c9dc5
  for (let i = 0; i < questionText.length; i += 1) {
    hash ^= questionText.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `${DRAFT_PREFIX}${hash.toString(36)}:${fieldIndex}`
}

/**
 * Mirror custom answers into `localStorage`, keyed by the question's own text and
 * the field's position on its page.
 *
 * The component keeps them in page memory only, so restarting the phone app
 * loses whatever was typed. Only ever fills an empty field, so it cannot
 * overwrite what is being typed.
 */
function installQuestionDraftMirror(): () => void {
  const PREFIX = DRAFT_PREFIX
  const MAX_AGE_MS = 24 * 60 * 60 * 1000
  // A card is also absent while the app boots, so clearing on disappearance alone
  // would wipe a draft during the very restart this exists to survive.
  const ABSENT_CLEAR_MS = 45000
  let lastSeen = 0

  const write = (el: HTMLTextAreaElement, value: string): void => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    if (setter === undefined) return
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }

  /** The draft key for a field on the page the card is currently showing. */
  const keyFor = (frame: Element, field: HTMLTextAreaElement): string => {
    const title = frame.querySelector('h2')
    const text = (title === null ? '' : title.textContent ?? '').trim()
    // No readable question: fall back to the card, so the field is still saved
    // rather than silently dropped.
    const identity = text === ''
      ? `card-${frame.getAttribute('data-question-key') ?? 'unknown'}`
      : text
    // The field index still matters — one page can hold several custom answer
    // boxes, and those must not share a draft either.
    const fields = [...frame.querySelectorAll('textarea')]
    return questionDraftKey(identity, fields.indexOf(field))
  }

  const onInput = (event: Event): void => {
    const el = event.target
    if (!(el instanceof HTMLTextAreaElement)) return
    const frame = el.closest('[data-question-key]')
    if (frame === null) return
    try {
      localStorage.setItem(keyFor(frame, el), JSON.stringify({ v: el.value, t: Date.now() }))
    } catch {
      // Quota exceeded or private mode.
    }
  }

  const restore = (): void => {
    const frame = document.querySelector('[data-question-key]')
    if (frame === null) return
    for (const field of frame.querySelectorAll('textarea')) {
      if (field.value !== '') continue
      const key = keyFor(frame, field)
      let saved: { v?: unknown } | null = null
      try {
        saved = JSON.parse(localStorage.getItem(key) ?? 'null') as { v?: unknown } | null
      } catch {
        saved = null
      }
      if (saved !== null && typeof saved.v === 'string' && saved.v !== '') write(field, saved.v)
    }
  }

  // Clear the drafts once the batch is finished.
  //
  // Only a sustained absence counts. An earlier version also dropped every draft
  // that did not match the card currently on screen, and that is what broke
  // reload: the request key changes on every page load, so the sweep deleted the
  // very draft `restore` was about to fill in, and the answer never came back.
  // With keys derived from the question text there is nothing left to
  // disambiguate — two questions cannot share a draft — so the absence rule
  // alone is both sufficient and safe. It also only runs while the page is alive,
  // so closing the app overnight cannot wipe a draft.
  const clearAll = (): void => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(PREFIX)) localStorage.removeItem(key)
    }
  }
  const sweep = (): void => {
    const frame = document.querySelector('[data-question-key]')
    if (frame !== null) {
      lastSeen = Date.now()
      return
    }
    if (lastSeen !== 0 && Date.now() - lastSeen > ABSENT_CLEAR_MS) {
      clearAll()
      lastSeen = 0
    }
  }

  const now = Date.now()
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(PREFIX)) continue
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? '{}') as { t?: unknown }
      if (typeof saved.t !== 'number' || now - saved.t > MAX_AGE_MS) localStorage.removeItem(key)
    } catch {
      localStorage.removeItem(key)
    }
  }

  restore()
  document.addEventListener('input', onInput, true)

  // Fill a draft the moment its card is rendered. Waiting for the next interval
  // left the answer invisible for up to 900 ms after a reload, which reads as the
  // app having lost it. The observer is the event that actually signals "a card
  // exists now"; the interval below stays only to run the sweep and to catch a
  // card that is restored without a child-list mutation.
  // Coalesced to one pass per frame: a streaming answer mutates the transcript
  // constantly, and restore is only worth running once the DOM has settled.
  let restoreScheduled = false
  const observer = new MutationObserver(() => {
    if (restoreScheduled) return
    restoreScheduled = true
    requestAnimationFrame(() => { restoreScheduled = false; restore() })
  })
  observer.observe(document.body, { childList: true, subtree: true })

  const timer = setInterval(() => { sweep(); restore() }, 900)
  return () => {
    observer.disconnect()
    document.removeEventListener('input', onInput, true)
    clearInterval(timer)
  }
}
/**
 * Cordis plugin entry.
 *
 * The bundle's `dsh-ui-fixes` component row loads this module, so that row's own
 * toggle is the switch: enabled means the fixed card, disabled means the stock
 * DSH card. There is deliberately no in-page preference that could fall out of
 * sync with the plugin state.
 */
export function apply(ctx: { effect(effect: () => void | (() => void)): void }): void {
  ctx.effect(() => installQuestionFixes())
}
