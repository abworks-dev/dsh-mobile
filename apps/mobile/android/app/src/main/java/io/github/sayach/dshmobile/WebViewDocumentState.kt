package io.github.sayach.dshmobile

import java.net.URI

/** Tracks whether the existing WebView still contains a successfully loaded DSH document. */
internal class WebViewDocumentState(private val origin: GatewayOrigin) {
    private var failed = false
    var usable: Boolean = false
        private set

    fun started() {
        usable = false
        failed = false
    }

    fun failed() {
        usable = false
        failed = true
    }

    fun finished(url: String, currentUrl: String): Boolean {
        val successful = !failed && isDshDocumentUrl(origin, url) && isDshDocumentUrl(origin, currentUrl)
        usable = successful
        return successful
    }
}

/** Only the root DSH shell is a page whose JavaScript state we may retain. */
internal fun isDshDocumentUrl(origin: GatewayOrigin, url: String): Boolean {
    if (!GatewayUrlPolicy.isSameOrigin(origin, url)) return false
    val path = runCatching { URI(url).path }.getOrNull() ?: return false
    return path == "/" || path.isEmpty()
}

/** Match a completed main-frame callback to the WebView's current page, including a normalized root slash. */
internal fun sameMainDocumentUrl(origin: GatewayOrigin, currentUrl: String, finishedUrl: String): Boolean {
    if (!GatewayUrlPolicy.isSameOrigin(origin, currentUrl)
        || !GatewayUrlPolicy.isSameOrigin(origin, finishedUrl)
    ) return false
    val current = runCatching { URI(currentUrl) }.getOrNull() ?: return false
    val finished = runCatching { URI(finishedUrl) }.getOrNull() ?: return false
    return current.rawPath.orEmpty().ifEmpty { "/" } == finished.rawPath.orEmpty().ifEmpty { "/" }
        && current.rawQuery == finished.rawQuery
}

/** Ignore stale renewals; keep a live document, or rebuild an invalid one. */
internal enum class RenewedDocumentAction { IGNORE, KEEP, RELOAD }

/** The WebView JavaScript result is true only after the dedicated React shell mounts. */
internal const val MOUNTED_DSH_PROBE = "document.querySelector('.dshm-shell') !== null"
internal fun mountedDshProbeResult(result: String?): Boolean = result == "true"

/** Ask the current page to close one mobile-owned layer before native navigation. */
internal const val MOBILE_BACK_SCRIPT = "(() => { const event = new Event('dsh-mobile:native-back', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented })()"
internal enum class MobileBackEvaluation { CONSUMED, UNHANDLED, UNAVAILABLE }
internal fun mobileBackEvaluation(result: String?): MobileBackEvaluation = when (result) {
    "true" -> MobileBackEvaluation.CONSUMED
    "false" -> MobileBackEvaluation.UNHANDLED
    else -> MobileBackEvaluation.UNAVAILABLE
}

internal enum class MobileBackAction { IGNORE, PAGE_HANDLED, NATIVE_BACK, RETRY }

/** A late page response cannot navigate a replacement WebView or document. */
internal fun mobileBackAction(
    expectedGeneration: Int,
    currentGeneration: Int,
    sameWebView: Boolean,
    sameDocument: Boolean,
    activityActive: Boolean,
    evaluation: MobileBackEvaluation,
): MobileBackAction = when {
    expectedGeneration != currentGeneration || !sameWebView || !sameDocument || !activityActive -> MobileBackAction.IGNORE
    evaluation == MobileBackEvaluation.CONSUMED -> MobileBackAction.PAGE_HANDLED
    evaluation == MobileBackEvaluation.UNHANDLED -> MobileBackAction.NATIVE_BACK
    else -> MobileBackAction.RETRY
}

internal fun renewedDocumentAction(
    expectedGeneration: Int,
    currentGeneration: Int,
    sameWebView: Boolean,
    sameOrigin: Boolean,
    mounted: Boolean,
): RenewedDocumentAction = when {
    expectedGeneration != currentGeneration || !sameWebView -> RenewedDocumentAction.IGNORE
    !sameOrigin -> RenewedDocumentAction.RELOAD
    mounted -> RenewedDocumentAction.KEEP
    else -> RenewedDocumentAction.RELOAD
}

/** An exhausted retry keeps only a mounted page; stale callbacks cannot change screens. */
internal enum class ExhaustedRecoveryAction { IGNORE, KEEP_PAGE, SHOW_CONNECTIONS }

internal fun exhaustedRecoveryAction(
    expectedGeneration: Int,
    currentGeneration: Int,
    sameWebView: Boolean,
    mounted: Boolean,
): ExhaustedRecoveryAction = when {
    expectedGeneration != currentGeneration || !sameWebView -> ExhaustedRecoveryAction.IGNORE
    mounted -> ExhaustedRecoveryAction.KEEP_PAGE
    else -> ExhaustedRecoveryAction.SHOW_CONNECTIONS
}
