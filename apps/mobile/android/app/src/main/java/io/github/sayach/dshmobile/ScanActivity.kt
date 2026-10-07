package io.github.sayach.dshmobile

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.hardware.Camera
import android.os.Bundle
import android.view.Gravity
import android.view.ScaleGestureDetector
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast
import kotlin.math.abs

/**
 * Full-screen QR scanner for the low-friction pairing path. Uses the legacy
 * android.hardware.Camera API plus ZXing so the shell stays free of AndroidX
 * dependencies; the CAMERA permission is requested by MainActivity before launch.
 *
 * The preview is laid out aspect-fill (uniform scale, center crop) so it never looks
 * squeezed on tall screens, and supports pinch zoom plus double-tap to toggle 1x/2x.
 */
class ScanActivity : Activity(), SurfaceHolder.Callback {
    private var camera: Camera? = null
    private var previewWidth = 0
    private var previewHeight = 0
    private var previewReady = false
    private var decoding = false
    private var finished = false
    private lateinit var preview: SurfaceView

    // Zoom state: maxRatio comes from the device's own zoom table when it publishes one.
    private var maxZoomIndex = 0
    private var maxZoomRatio = PreviewLayoutPolicy.DEFAULT_MAX_ZOOM_RATIO
    private var zoomRatios: List<Int>? = null
    private var zoomRatio = 1f

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildInterface())
        preview.holder.addCallback(this)
        installGestures()
    }

    override fun onResume() {
        super.onResume()
        if (previewReady && camera == null) openCamera()
    }

    override fun onPause() {
        releaseCamera()
        super.onPause()
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        previewReady = true
        openCamera()
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        // Reapply the aspect-fill frame on size changes (rotation, folding, resize).
        applyPreviewFrame(width, height)
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        previewReady = false
        releaseCamera()
    }

    private fun installGestures() {
        val scaleDetector = ScaleGestureDetector(
            this,
            object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
                override fun onScale(detector: ScaleGestureDetector): Boolean {
                    applyZoom(zoomRatio * detector.scaleFactor)
                    return true
                }
            },
        )
        preview.setOnTouchListener { _, event ->
            scaleDetector.onTouchEvent(event)
            if (!scaleDetector.isInProgress) detectorDoubleTap(event) else false
        }
    }

    private var lastTapTime = 0L
    private var lastTapX = 0f
    private var lastTapY = 0f

    private fun detectorDoubleTap(event: android.view.MotionEvent): Boolean {
        if (event.actionMasked != android.view.MotionEvent.ACTION_UP) return false
        val now = event.eventTime
        val quick = now - lastTapTime < TAP_TIMEOUT_MS
        val near = abs(event.x - lastTapX) < DOUBLE_TAP_SLOP_PX &&
            abs(event.y - lastTapY) < DOUBLE_TAP_SLOP_PX
        if (quick && near) {
            lastTapTime = 0L
            applyZoom(if (zoomRatio > 1.5f) 1f else 2f)
            return true
        }
        lastTapTime = now
        lastTapX = event.x
        lastTapY = event.y
        return false
    }

    /** Applies a zoom ratio within device limits via the legacy camera zoom parameter. */
    private fun applyZoom(desired: Float) {
        val cam = camera ?: return
        val clamped = PreviewLayoutPolicy.clampZoomRatio(desired, maxZoomRatio)
        if (abs(clamped - zoomRatio) < ZOOM_EPSILON) return
        val params = cam.parameters ?: return
        val index = PreviewLayoutPolicy.zoomIndexFor(clamped, maxZoomIndex, zoomRatios)
        if (params.isZoomSupported && index != params.zoom) {
            params.zoom = index
            runCatching {
                cam.parameters = params
                zoomRatio = clamped
            }
        }
    }

    private fun buildInterface(): View {
        val density = resources.displayMetrics.density
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        val surface = SurfaceView(this)
        preview = surface
        root.addView(surface, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

        val frameDrawable = GradientDrawable().apply {
            setColor(Color.TRANSPARENT)
            setStroke((2 * density).toInt(), Color.WHITE)
        }
        val frameView = View(this).apply { background = frameDrawable }
        val frameSize = (260 * density).toInt()
        root.addView(
            frameView,
            FrameLayout.LayoutParams(frameSize, frameSize, Gravity.CENTER),
        )

        val hint = TextView(this).apply {
            text = getString(R.string.scan_hint)
            setTextColor(Color.WHITE)
            textSize = 15f
            gravity = Gravity.CENTER
        }
        root.addView(
            hint,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL,
            ).apply {
                bottomMargin = (48 * density).toInt()
            },
        )

        val close = ImageButton(this).apply {
            setImageResource(android.R.drawable.ic_menu_close_clear_cancel)
            setBackgroundColor(Color.TRANSPARENT)
            setOnClickListener { finish() }
        }
        root.addView(
            close,
            FrameLayout.LayoutParams(
                (48 * density).toInt(),
                (48 * density).toInt(),
                Gravity.TOP or Gravity.START,
            ).apply {
                topMargin = (24 * density).toInt()
                marginStart = (16 * density).toInt()
            },
        )
        return root
    }

    private fun openCamera() {
        if (finished) return
        val cam = runCatching { Camera.open(0) }.getOrNull()
        if (cam == null) {
            runOnUiThread { Toast.makeText(this, R.string.camera_unavailable, Toast.LENGTH_LONG).show() }
            finish()
            return
        }
        camera = cam
        try {
            val params = cam.parameters
            val supported = params.supportedFocusModes
            if (supported != null && supported.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                params.focusMode = Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE
            } else if (supported != null && supported.contains(Camera.Parameters.FOCUS_MODE_AUTO)) {
                params.focusMode = Camera.Parameters.FOCUS_MODE_AUTO
            }
            // Choose the preview size whose aspect matches this screen so aspect-fill
            // crops the least; the previous fixed 720p choice squeezed the picture.
            val sizes = params.supportedPreviewSizes
                ?.map { PreviewLayoutPolicy.Size(it.width, it.height) }
                .orEmpty()
            val size = PreviewLayoutPolicy.choosePreviewSize(sizes, preview.width.coerceAtLeast(1), preview.height.coerceAtLeast(1))
                ?: params.previewSize?.let { PreviewLayoutPolicy.Size(it.width, it.height) }
                ?: throw IllegalStateException("camera has no preview size")
            params.setPreviewSize(size.width, size.height)

            // Remember the device's zoom capabilities for double-tap and pinch zoom.
            maxZoomIndex = if (params.isZoomSupported) params.maxZoom else 0
            zoomRatios = params.zoomRatios?.toList()
            maxZoomRatio = PreviewLayoutPolicy.maxZoomRatio(zoomRatios)
            zoomRatio = 1f

            cam.parameters = params
            previewWidth = size.width
            previewHeight = size.height
            cam.setDisplayOrientation(90)
            cam.setPreviewDisplay(preview.holder)
            applyPreviewFrame(preview.width, preview.height)
            cam.setPreviewCallback { data, _ -> onPreviewFrame(data) }
            cam.startPreview()
        } catch (error: Exception) {
            releaseCamera()
            runOnUiThread { Toast.makeText(this, R.string.camera_unavailable, Toast.LENGTH_LONG).show() }
            finish()
        }
    }

    /** Lays the surface-frame-independent preview out as center-crop aspect fill. */
    private fun applyPreviewFrame(surfaceWidth: Int, surfaceHeight: Int) {
        if (previewWidth <= 0 || previewHeight <= 0) return
        val frame = PreviewLayoutPolicy.previewFrame(surfaceWidth, surfaceHeight, previewWidth, previewHeight)
        val lp = preview.layoutParams as? FrameLayout.LayoutParams ?: return
        if (lp.leftMargin != frame[0] || lp.topMargin != frame[1] ||
            lp.width != frame[2] || lp.height != frame[3]
        ) {
            lp.leftMargin = frame[0]
            lp.topMargin = frame[1]
            lp.width = frame[2]
            lp.height = frame[3]
            preview.layoutParams = lp
        }
    }

    private fun onPreviewFrame(data: ByteArray) {
        if (decoding || finished || camera == null) return
        decoding = true
        try {
            val text = QrDecoder.decodeNv21(data, previewWidth, previewHeight)
            if (text != null) {
                finished = true
                setResult(RESULT_OK, Intent().putExtra(EXTRA_QR_RESULT, text))
                finish()
            }
        } finally {
            decoding = false
        }
    }

    private fun releaseCamera() {
        val cam = camera ?: return
        camera = null
        runCatching { cam.setPreviewCallback(null) }
        runCatching { cam.stopPreview() }
        cam.release()
    }

    companion object {
        const val EXTRA_QR_RESULT = "qr_result"
        private const val TAP_TIMEOUT_MS = 300L
        private const val DOUBLE_TAP_SLOP_PX = 100
        private const val ZOOM_EPSILON = 0.01f
    }
}
