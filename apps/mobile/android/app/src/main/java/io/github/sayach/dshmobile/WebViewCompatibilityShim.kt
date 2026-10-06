package io.github.sayach.dshmobile

import android.webkit.WebView
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Install the browser-compatibility shim before any page script runs.
 *
 * DSH's client bundle and the host's inline boot-readiness script use
 * `Promise.withResolvers` (Chrome 119+) and `AbortSignal.any` (Chrome 116+).
 * On an older system WebView — a HarmonyOS Android-compat layer ships
 * Chrome/114.0.5735.196 — the missing APIs make every WebSocket close right
 * after the handshake (code 4000, zero frames). The shell still renders and
 * the home statistics still come from the page snapshot, so the only visible
 * symptom is an empty workspace and session list, with no error on screen.
 *
 * Document-start injection is the only placement that precedes the host's
 * inline readiness script: the plugin's own custom script is fetched after
 * `load` (observed `document.readyState === 'complete'`) and cannot repair it.
 *
 * The shim is additive and idempotent: it fills in an API only when it is
 * absent, so supported WebViews keep their native implementation.
 *
 * @param webView the browser being prepared for the gateway origin.
 * @return whether the shim was installed; false when the WebView lacks the feature.
 */
internal fun installBrowserCompatibilityShim(webView: WebView): Boolean {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return false
    return runCatching {
        // The shim only adds two standard, side-effect-free constructors, so it
        // is applied to every origin the paired page may load.
        WebViewCompat.addDocumentStartJavaScript(webView, BROWSER_COMPATIBILITY_SHIM, setOf("*"))
        true
    }.getOrDefault(false)
}

/**
 * ES5-only source for the document-start shim.
 *
 * Kept free of arrow functions, `let`/`const`, template literals and `$` so it
 * parses on engines far older than the ones missing these APIs, and free of
 * `</script` so it can be inlined safely by a host that injects it as markup.
 */
internal const val BROWSER_COMPATIBILITY_SHIM = """
(function () {
  try {
    if (typeof Promise.withResolvers !== 'function') {
      Promise.withResolvers = function () {
        var resolve, reject;
        var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
        return { promise: promise, resolve: resolve, reject: reject };
      };
    }
  } catch (e) {}
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
      AbortSignal.any = function (signals) {
        var controller = new AbortController();
        var sources = Array.prototype.slice.call(signals);
        var onAbort = function (event) {
          for (var index = 0; index < sources.length; index += 1) {
            try { sources[index].removeEventListener('abort', onAbort); } catch (e) {}
          }
          try { controller.abort(event.target.reason); } catch (e) { controller.abort(); }
        };
        for (var index = 0; index < sources.length; index += 1) {
          if (sources[index].aborted) {
            onAbort({ target: sources[index] });
            return controller.signal;
          }
          sources[index].addEventListener('abort', onAbort, { once: true });
        }
        return controller.signal;
      };
    }
  } catch (e) {}
})();
""".trimIndent()