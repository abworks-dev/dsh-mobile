package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Keeps the document-start shim limited to what old WebViews are missing. */
class WebViewCompatibilityShimTest {
    private val shim = BROWSER_COMPATIBILITY_SHIM

    @Test
    fun shimFillsOnlyApisThatAreAbsent() {
        // Every assignment sits behind a guard, so a supported WebView keeps its
        // native implementation and a repeated injection stays a no-op.
        assertTrue(shim.contains("typeof Promise.withResolvers !== 'function'"))
        assertTrue(shim.contains("typeof AbortSignal.any !== 'function'"))
        assertEquals(1, Regex("Promise\\.withResolvers\\s*=\\s*function").findAll(shim).count())
        assertEquals(1, Regex("AbortSignal\\.any\\s*=\\s*function").findAll(shim).count())
    }

    @Test
    fun shimCoversTheApisMissingOnChrome114() {
        // Observed on a Chrome/114.0.5735.196 WebView: both APIs are absent, and
        // the resulting TypeError in the connection path closes every WebSocket
        // with code 4000 before a single frame arrives.
        assertTrue(shim.contains("Promise.withResolvers"))
        assertTrue(shim.contains("AbortSignal.any"))
        assertTrue(shim.contains("new AbortController()"))
    }

    @Test
    fun shimPreservesAbortSemantics() {
        // Spec behaviour an abort-aware caller can depend on: the first abort's
        // reason is propagated, and an already-aborted input short-circuits.
        assertTrue(shim.contains("event.target.reason"))
        assertTrue(shim.contains(".aborted"))
        assertTrue(shim.contains("{ once: true }"))
    }

    @Test
    fun shimStaysParseableByOlderEngines() {
        // No syntax newer than ES5, so the shim never becomes the reason a page
        // fails to parse on the very engines it is meant to support.
        listOf("=>", "`", "let ", "const ", "?.", "??").forEach { syntax ->
            assertFalse("shim must not use $syntax", shim.contains(syntax))
        }
    }

    @Test
    fun shimCannotEscapeAnInlineScriptContext() {
        // The same source is also usable inlined into an index response, so it
        // must not terminate or comment out a surrounding tag.
        listOf("</script", "<!--", "-->").forEach { sequence ->
            assertFalse("shim must not contain $sequence", shim.contains(sequence))
        }
    }

    @Test
    fun shimWrapsItsWorkSoItCannotThrow() {
        // Each half is wrapped on its own, and the inner cleanup is wrapped too,
        // so an exotic engine cannot break page loading from this script.
        assertTrue(shim.trimStart().startsWith("(function () {"))
        assertTrue(shim.trimEnd().endsWith("})();"))
        assertTrue(Regex("try \\{").findAll(shim).count() >= 3)
        assertTrue(Regex("catch \\(").findAll(shim).count() >= 3)
    }

    @Test
    fun shimAvoidsKotlinTemplateInterpolation() {
        // The source lives in a raw string; a stray dollar or brace would either
        // fail compilation or silently change the emitted script.
        assertFalse(shim.contains("$"))
    }
}