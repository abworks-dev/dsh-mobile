package io.github.sayach.dshmobile

import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Pure geometry and camera-parameter math for the pairing QR scanner. Keeping it free of
 * android.* camera types lets the aspect-fill layout and zoom mapping stay unit tested.
 */
object PreviewLayoutPolicy {
    /** Resolution-independent stand-in for [android.hardware.Camera.Size]. */
    data class Size(val width: Int, val height: Int)

    /** Area of the previous fixed choice; used only as a tie-breaker between aspect matches. */
    private const val TARGET_AREA = 1280.0 * 720.0

    /**
     * Picks the preview size whose aspect best matches the (portrait) surface so the
     * aspect-fill layout crops as little as possible. The legacy camera buffer is landscape,
     * so its on-screen aspect after the 90 degree display rotation is width/height.
     */
    fun choosePreviewSize(sizes: List<Size>, surfaceWidth: Int, surfaceHeight: Int): Size? {
        if (sizes.isEmpty()) return null
        val surfaceAspect = surfaceHeight.coerceAtLeast(1).toDouble() / surfaceWidth.coerceAtLeast(1)
        return sizes.minByOrNull { size ->
            val aspect = size.width.toDouble() / size.height.coerceAtLeast(1)
            val aspectDiff = abs(aspect - surfaceAspect)
            val areaDiff = abs(size.width * size.height - TARGET_AREA) / TARGET_AREA
            aspectDiff + areaDiff * 0.05
        }
    }

    /**
     * Center-crop ("aspect fill") frame for the preview surface: scales the preview uniformly
     * until it covers the whole screen, cropping the overflow on one axis. Returns
     * [left, top, width, height] relative to the surface so the image is never distorted.
     */
    fun previewFrame(
        surfaceWidth: Int,
        surfaceHeight: Int,
        previewWidth: Int,
        previewHeight: Int,
        rotated90: Boolean = true,
    ): IntArray {
        val sw = surfaceWidth.coerceAtLeast(1)
        val sh = surfaceHeight.coerceAtLeast(1)
        val pw = previewWidth.coerceAtLeast(1)
        val ph = previewHeight.coerceAtLeast(1)
        val naturalWidth = if (rotated90) ph else pw
        val naturalHeight = if (rotated90) pw else ph
        val scale = maxOf(sw.toDouble() / naturalWidth, sh.toDouble() / naturalHeight)
        val width = (naturalWidth * scale).roundToInt().coerceAtLeast(sw)
        val height = (naturalHeight * scale).roundToInt().coerceAtLeast(sh)
        return intArrayOf((sw - width) / 2, (sh - height) / 2, width, height)
    }

    /**
     * Maps a desired zoom ratio (1x, 2x, …) to a legacy camera zoom index. Devices that
     * publish per-index zoom ratios get an exact closest match; the fallback assumes the
     * common ~4x maximum grows roughly linearly across indices.
     */
    fun zoomIndexFor(desiredRatio: Float, maxZoom: Int, zoomRatios: List<Int>?): Int {
        if (maxZoom <= 0) return 0
        val ratios = zoomRatios?.takeIf { it.isNotEmpty() }
        return if (ratios != null) {
            val target = (desiredRatio * 100).toInt()
            var best = 0
            var bestDiff = Int.MAX_VALUE
            for (index in 0..minOf(maxZoom, ratios.size - 1)) {
                val diff = abs(ratios[index] - target)
                if (diff < bestDiff) {
                    bestDiff = diff
                    best = index
                }
            }
            best
        } else {
            val clamped = clampZoomRatio(desiredRatio, DEFAULT_MAX_ZOOM_RATIO)
            (maxZoom * (clamped - 1f) / (DEFAULT_MAX_ZOOM_RATIO - 1f)).roundToInt().coerceIn(0, maxZoom)
        }
    }

    fun clampZoomRatio(ratio: Float, maxRatio: Float): Float =
        ratio.coerceIn(1f, maxRatio.coerceAtLeast(1f))

    /** Best-supported zoom ratio from a device's ratio table, or a conservative default. */
    fun maxZoomRatio(zoomRatios: List<Int>?): Float {
        val ratios = zoomRatios?.takeIf { it.isNotEmpty() } ?: return DEFAULT_MAX_ZOOM_RATIO
        return (ratios.last() / 100f).coerceAtLeast(1f)
    }

    private const val DEFAULT_MAX_ZOOM_RATIO = 4f
}
