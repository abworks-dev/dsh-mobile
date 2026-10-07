package io.github.sayach.dshmobile

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Checks Activity wiring that pure preview/zoom tests cannot exercise on the JVM. */
class ScannerSourceContractTest {
    private val source: String by lazy {
        val relative = "src/main/java/io/github/sayach/dshmobile/ScanActivity.kt"
        val paths = listOf(relative, "app/$relative", "apps/mobile/android/app/$relative")
        generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .flatMap { base -> paths.asSequence().map { File(base, it) } }
            .first { it.isFile }.readText()
    }

    @Test
    fun surfaceCallbacksUseTheSeparateViewportInsteadOfTheirOwnExpandedDimensions() {
        val callback = source.substringAfter("override fun surfaceChanged").substringBefore("override fun surfaceDestroyed")
        assertTrue(callback.contains("updatePreviewGeometry()"))
        assertFalse(callback.contains("applyPreviewFrame(width, height)"))
        val layout = source.substringAfter("private fun updatePreviewGeometry").substringBefore("private fun onPreviewFrame")
        assertTrue(layout.contains("previewContainer.width - previewContainer.paddingLeft"))
        assertTrue(layout.contains("previewContainer.height - previewContainer.paddingTop"))
        assertFalse(layout.contains("preview.width"))
        assertFalse(layout.contains("preview.height"))
    }

    @Test
    fun scannerConsumesTouchSequencesAndOffersAccessibleButtonAlternatives() {
        val gestures = source.substringAfter("private fun installGestures").substringBefore("private fun applyZoom")
        assertTrue(gestures.contains("GestureDetector(this"))
        assertTrue(gestures.contains("preview.performClick()"))
        assertTrue(gestures.contains("MotionEvent.ACTION_CANCEL"))
        assertTrue(gestures.contains("            true\n        }"))
        assertFalse(gestures.contains("else false"))
        assertTrue(source.contains("LinearLayout.LayoutParams(dp(48), dp(48))"))
        assertTrue(source.contains("R.string.scan_zoom_in"))
        assertTrue(source.contains("R.string.scan_zoom_out"))
        assertTrue(source.contains("R.string.scan_close"))
        assertTrue(source.contains("applySafeAreaInsets(previewContainer)"))
    }

    @Test
    fun pausedOrAlreadyOpenCameraDoesNotAcquireAnotherCamera() {
        val opening = source.substringAfter("private fun openCamera").substringBefore("private fun displayOrientation")
        assertTrue(opening.contains("!resumed || !previewReady || camera != null"))
        assertFalse(opening.contains("setDisplayOrientation(90)"))
        val pause = source.substringAfter("override fun onPause").substringBefore("override fun surfaceCreated")
        assertTrue(pause.indexOf("resumed = false") < pause.indexOf("releaseCamera()"))
    }
}
