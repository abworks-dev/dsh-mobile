/** Browser cancellation support for engines with AbortController but no AbortSignal.any. */

type SourceListeners = Map<AbortSignal, EventListener>

/** Release source subscriptions without retaining their combined signal. */
function detachSources(listeners: SourceListeners): void {
  for (const [source, listener] of listeners) source.removeEventListener('abort', listener)
  listeners.clear()
}

/** Older engines without weak references retain subscriptions until cancellation. */
function signalReference(signal: AbortSignal): { deref(): AbortSignal | undefined } {
  return typeof WeakRef === 'function' ? new WeakRef(signal) : { deref: () => signal }
}

/**
 * Install signal composition without replacing a native implementation.
 *
 * Inputs are validated with the native AbortSignal getter, including signals from
 * another frame. Listeners remain until a source really aborts; a synthetic event
 * does not cancel the result or consume its subscription.
 */
export function installAbortSignalAny(): void {
  if (typeof AbortSignal === 'undefined' || typeof AbortController === 'undefined' || typeof AbortSignal.any === 'function') return
  const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')?.get
  const reason = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'reason')?.get
  if (aborted === undefined || reason === undefined) throw new TypeError('AbortSignal getters are unavailable')
  // A live output retains its controller through this weak key. Source listeners
  // and finalizer values contain only a weak reference to that output.
  const controllers = new WeakMap<AbortSignal, AbortController>()
  const finalizer = typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<SourceListeners>(detachSources) : undefined
  const listenerFor = (
    source: AbortSignal, reference: { deref(): AbortSignal | undefined }, listeners: SourceListeners,
  ): EventListener => () => {
    const result = reference.deref()
    if (result === undefined) {
      detachSources(listeners)
      return
    }
    if (!aborted.call(source)) return
    const controller = controllers.get(result)!
    detachSources(listeners)
    finalizer?.unregister(listeners)
    controller.abort(reason.call(source))
  }
  Object.defineProperty(AbortSignal, 'any', {
    configurable: true,
    writable: true,
    value: function any(signals: Iterable<AbortSignal>): AbortSignal {
      if (signals == null || typeof signals[Symbol.iterator] !== 'function') throw new TypeError('AbortSignal.any requires an iterable')
      const sources: AbortSignal[] = []
      // WebIDL converts the complete sequence before selecting an aborted input.
      for (const source of signals) {
        aborted.call(source)
        sources.push(source)
      }
      const controller = new AbortController()
      for (const source of sources) {
        if (aborted.call(source)) {
          controller.abort(reason.call(source))
          return controller.signal
        }
      }
      const listeners: SourceListeners = new Map()
      const reference = signalReference(controller.signal)
      controllers.set(controller.signal, controller)
      if (typeof WeakRef === 'function') finalizer?.register(controller.signal, listeners, listeners)
      for (const source of sources) {
        if (listeners.has(source)) continue
        const listener = listenerFor(source, reference, listeners)
        listeners.set(source, listener)
        source.addEventListener('abort', listener)
      }
      return controller.signal
    },
  })
}
