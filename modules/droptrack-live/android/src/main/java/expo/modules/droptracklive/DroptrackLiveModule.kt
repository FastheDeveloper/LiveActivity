package expo.modules.droptracklive

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.graphics.drawable.IconCompat
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

// Mirrors the iOS Records — Expo validates the JS payload against these
// fields before the function body runs, on both platforms.
class DeliveryInfoRecord : Record {
  @Field var orderId: String = ""
}

class DeliveryStateRecord : Record {
  @Field var status: String = ""
  @Field var progress: Double = 0.0
  @Field var etaEpochMillis: Double = 0.0
  @Field var stopsRemaining: Int = 0
  // Courier is dynamic state, not a static attribute — riders get reassigned.
  @Field var courierName: String = ""
  @Field var riderReassigned: Boolean = false
}

class NoContextException :
  CodedException("React application context is not available")

class ActivityNotFoundException(id: String) :
  CodedException("No live delivery found with id '$id' — it may have ended")

private const val TAG = "DroptrackLive"
private const val CHANNEL_ID = "droptrack.delivery"
private const val BRAND_ORANGE = 0xFFFF6B2C.toInt()

// Android has no ActivityKit — "the activity" is just a notification we keep
// re-posting under the same ID. The OS treats an in-place re-post as an
// update; a different ID would spawn a second notification instead.
//
// Everything goes through NotificationCompat (androidx.core 1.17): on
// Android 16+ it emits the real ProgressStyle + promotion request; below
// that it silently degrades to a standard notification, and we add our own
// classic progress bar so pre-16 users still see *something* move.
class DroptrackLiveModule : Module() {
  private val deliveries = mutableMapOf<String, DeliveryInfoRecord>()
  private val mainHandler = Handler(Looper.getMainLooper())

  override fun definition() = ModuleDefinition {
    Name("DroptrackLive")

    Constants(
      // Notifications work everywhere we run; what varies is the treatment.
      "isSupported" to true,
      // Full Live Updates (status-bar chip, lock-screen slot) need Android 16.
      "supportsLiveUpdates" to (Build.VERSION.SDK_INT >= 36)
    )

    Function("areActivitiesEnabled") {
      return@Function notificationManager?.areNotificationsEnabled() ?: false
    }

    // Whether the OS will actually promote our notifications (chip on the
    // status bar, lock-screen slot). Reflects the per-app "Live updates"
    // toggle in Settings — distinct from plain notification permission.
    Function("canPostPromotedNotifications") {
      val manager = notificationManager ?: return@Function false
      if (Build.VERSION.SDK_INT < 36) return@Function false
      return@Function runCatching { manager.canPostPromotedNotifications() }
        .getOrDefault(false) // method is absent on pre-QPR Android 16 builds
    }

    AsyncFunction("startDelivery") { info: DeliveryInfoRecord, state: DeliveryStateRecord ->
      ensureChannel()
      val activityId = "delivery-${info.orderId}"
      deliveries[activityId] = info
      postDelivery(activityId, info, state, ongoing = true)
      return@AsyncFunction activityId
    }

    AsyncFunction("updateDelivery") { activityId: String, state: DeliveryStateRecord ->
      val info = deliveries[activityId] ?: throw ActivityNotFoundException(activityId)
      postDelivery(activityId, info, state, ongoing = true)
    }

    AsyncFunction("endDelivery") { activityId: String, state: DeliveryStateRecord, dismissAfterSeconds: Double? ->
      val info = deliveries.remove(activityId) ?: throw ActivityNotFoundException(activityId)
      // Final state: no longer ongoing, so the user can swipe it away —
      // mirroring how iOS leaves the final card on the lock screen.
      postDelivery(activityId, info, state, ongoing = false)
      if (dismissAfterSeconds != null) {
        val notificationId = notificationIdFor(activityId)
        val delayMs = (dismissAfterSeconds * 1000).toLong()
        mainHandler.postDelayed({ notificationManager?.cancel(notificationId) }, delayMs)
      }
    }
  }

  private val context: Context?
    get() = appContext.reactContext

  private val notificationManager: NotificationManager?
    get() = context?.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager

  // Same string in → same int out → in-place notification updates.
  private fun notificationIdFor(activityId: String) = activityId.hashCode()

  private fun ensureChannel() {
    val manager = notificationManager ?: throw NoContextException()
    // Promotion requires importance above IMPORTANCE_MIN.
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Delivery updates",
      NotificationManager.IMPORTANCE_HIGH
    ).apply {
      description = "Live progress of your active deliveries"
    }
    manager.createNotificationChannel(channel)
  }

  private fun postDelivery(
    activityId: String,
    info: DeliveryInfoRecord,
    state: DeliveryStateRecord,
    ongoing: Boolean
  ) {
    val ctx = context ?: throw NoContextException()
    val progressPercent = (state.progress.coerceIn(0.0, 1.0) * 100).toInt()

    val builder = NotificationCompat.Builder(ctx, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_delivery)
      .setContentTitle(state.status)                      // promotion REQUIRES a title
      .setContentText(courierLine(state))
      .setSubText("Order ${info.orderId}")
      .setOngoing(ongoing)                                 // promotion REQUIRES ongoing
      .setOnlyAlertOnce(true)                              // buzz once, update silently
      .setColor(BRAND_ORANGE)
      // Status-bar chip text next to our icon while promoted (~7 chars fit).
      .setShortCriticalText("$progressPercent%")
      // The promotion request itself — compat sets the request extra, which
      // QPR1+ systems honor; older systems ignore it. Harmless elsewhere.
      .setRequestPromotedOngoing(ongoing)

    if (state.etaEpochMillis > System.currentTimeMillis()) {
      // A future `when` renders as the ETA in the header; a past value can
      // get the update skipped entirely (see GOTCHAS).
      builder.setWhen(state.etaEpochMillis.toLong()).setShowWhen(true)
    }

    if (Build.VERSION.SDK_INT >= 36) {
      // The Android 16 Live Updates treatment: segmented ProgressStyle bar.
      val style = NotificationCompat.ProgressStyle()
        .setStyledByProgress(true)
        .setProgress(progressPercent)
        .setProgressTrackerIcon(IconCompat.createWithResource(ctx, R.drawable.ic_delivery))
        .setProgressSegments(
          listOf(NotificationCompat.ProgressStyle.Segment(100).setColor(BRAND_ORANGE))
        )
        .setProgressPoints(
          // A milestone dot at "picked up" — purely to show Points exist.
          listOf(NotificationCompat.ProgressStyle.Point(35).setColor(Color.WHITE))
        )
      builder.setStyle(style)
    } else {
      // Below 16, compat drops ProgressStyle entirely (no bar at all), so
      // give those users the classic determinate bar instead.
      builder.setProgress(100, progressPercent, false)
    }

    val notification = builder.build()

    if (Build.VERSION.SDK_INT >= 36) {
      // Structural eligibility check — the single most useful promotion
      // debugging signal (all-or-nothing: ANY missing requirement = false).
      Log.d(TAG, "hasPromotableCharacteristics=${notification.hasPromotableCharacteristics()}")
    }

    notificationManager?.notify(notificationIdFor(activityId), notification)
  }

  private fun stopsLabel(stops: Int) = when (stops) {
    0 -> "you're next"
    1 -> "1 stop away"
    else -> "$stops stops away"
  }

  // Android has no per-field UI hooks like the SwiftUI card — the "new rider"
  // treatment is just words in the content line.
  private fun courierLine(state: DeliveryStateRecord) =
    if (state.riderReassigned) {
      "🔄 New rider: ${state.courierName} · ${stopsLabel(state.stopsRemaining)}"
    } else {
      "${state.courierName} · ${stopsLabel(state.stopsRemaining)}"
    }
}
