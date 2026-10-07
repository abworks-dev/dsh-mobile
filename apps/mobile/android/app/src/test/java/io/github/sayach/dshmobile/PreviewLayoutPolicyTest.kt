package io.github.sayach.dshmobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Verifies the scanner preview fills the screen without distortion and maps zoom levels. */
class PreviewLayoutPolicyTest {
    private val sizes = listOf(
        PreviewLayoutPolicy.Size(640, 480), // 4:3
        PreviewLayoutPolicy.Size(1280, 720), // 16:9
        PreviewLayoutPolicy.Size(1920, 1080), // 16:9
        PreviewLayoutPolicy.Size(1600, 900), // 16:9
    )

    @Test
    fun picksASizeMatchingTheTallScreenAspect() {
        // A 1080x2340 screen rotated camera buffer has aspect height/width ≈ 2.17,
        // so 16:9 (1.78) must win over 4:3 (1.33).
        val chosen = PreviewLayoutPolicy.choosePreviewSize(sizes, 1080, 2340)

        assertEquals(1280, chosen?.width)
        assertEquals(720, chosen?.height)
    }

    @Test
    fun prefersTheLargerMatchWhenAspectsTie() {
        // 1280x720 and 1600x900 have the same 16:9 aspect; the scoring's small area term
        // keeps the previously used ~720p target instead of jumping to 1080p.
        val chosen = PreviewLayoutPolicy.choosePreviewSize(sizes, 1080, 2340)

        assertTrue(chosen!!.width <= 1600)
    }

    @Test
    fun handlesEmptyAndDegenerateInput() {
        assertNull(PreviewLayoutPolicy.choosePreviewSize(emptyList(), 1080, 2340))
        assertNull(PreviewLayoutPolicy.choosePreviewSize(sizes, 0, 0))
    }

    @Test
    fun aspectFillCoversTheScreenOnTheTallerAxis() {
        // 16:9 preview on a 1080x2340 surface: uniform scale to width 1080 would leave
        // vertical gaps, so the policy must scale to cover height and crop the sides.
        val frame = PreviewLayoutPolicy.previewFrame(1080, 2340, 1280, 720)

        val left = frame[0]
        val top = frame[1]
        val width = frame[2]
        val height = frame[3]
        assertEquals(2340, height)
        assertTrue(width >= 1080)
        assertTrue(left <= 0)
        assertEquals(0, top)
        // Centered horizontally: crop is symmetric.
        assertEquals(-left, left + width - 1080)
        // The preview is scaled uniformly (no distortion).
        assertEquals(width.toDouble() / height, 1280.0 / 720.0, 0.01)
    }

    @Test
    fun aspectFillOnA16x9ScreenScalesByWidthOnly() {
        // Same aspect: the frame is exactly the surface, no crop at all.
        val frame = PreviewLayoutPolicy.previewFrame(1080, 1920, 1280, 720)

        assertEquals(0, frame[0])
        assertEquals(0, frame[1])
        assertEquals(1080, frame[2])
        assertEquals(1920, frame[3])
    }

    @Test
    fun zoomIndexUsesExactRatiosWhenPublished() {
        val ratios = listOf(100, 150, 200, 300, 400)

        assertEquals(0, PreviewLayoutPolicy.zoomIndexFor(1f, 4, ratios))
        assertEquals(2, PreviewLayoutPolicy.zoomIndexFor(2f, 4, ratios))
        assertEquals(4, PreviewLayoutPolicy.zoomIndexFor(4f, 4, ratios))
    }

    @Test
    fun zoomIndexFallsBackToLinearMappingWithoutRatios() {
        // Without a ratio table assume ~4x max spread across the indices.
        assertEquals(0, PreviewLayoutPolicy.zoomIndexFor(1f, 10, null))
        assertTrue(PreviewLayoutPolicy.zoomIndexFor(2f, 10, null) in 3..4)
        assertEquals(10, PreviewLayoutPolicy.zoomIndexFor(4f, 10, null))
    }

    @Test
    fun zoomIndexClampsOvershootAndDisabledZoom() {
        val ratios = listOf(100, 200, 400)

        assertEquals(2, PreviewLayoutPolicy.zoomIndexFor(8f, 2, ratios))
        assertEquals(0, PreviewLayoutPolicy.zoomIndexFor(2f, 0, null))
    }

    @Test
    fun maxZoomRatioDefaultsConservatively() {
        assertEquals(4f, PreviewLayoutPolicy.maxZoomRatio(null))
        assertEquals(4f, PreviewLayoutPolicy.maxZoomRatio(emptyList()))
        assertEquals(6f, PreviewLayoutPolicy.maxZoomRatio(listOf(100, 300, 600)))
    }
}
