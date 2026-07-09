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

// Shared notification builder. Called from BOTH the Expo module (JS-driven,
// local) and DroptrackFcmService (push-driven, from a background process that
// has no access to the module's in-memory state). Everything needed to render
// is passed in — no shared mutable state.
object DeliveryNotifier {
  const val TAG = "DroptrackLive"
  private const val CHANNEL_ID = "droptrack.delivery"
  private const val BRAND_ORANGE = 0xFFFF6B2C.toInt()

  private val mainHandler = Handler(Looper.getMainLooper())

  fun notificationIdFor(activityId: String) = activityId.hashCode()

  fun ensureChannel(ctx: Context) {
    val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val channel = NotificationChannel(
      CHANNEL_ID,
      "Delivery updates",
      NotificationManager.IMPORTANCE_HIGH
    ).apply { description = "Live progress of your active deliveries" }
    manager.createNotificationChannel(channel)
  }

  fun post(
    ctx: Context,
    activityId: String,
    orderId: String,
    status: String,
    progress: Double,
    etaEpochMillis: Double,
    stopsRemaining: Int,
    courierName: String,
    riderReassigned: Boolean,
    ongoing: Boolean,
  ) {
    val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val progressPercent = (progress.coerceIn(0.0, 1.0) * 100).toInt()

    val builder = NotificationCompat.Builder(ctx, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_delivery)
      .setContentTitle(status)                 // promotion REQUIRES a title
      .setContentText(courierLine(courierName, riderReassigned, stopsRemaining))
      .setSubText("Order $orderId")
      .setOngoing(ongoing)                     // promotion REQUIRES ongoing
      .setOnlyAlertOnce(true)
      .setColor(BRAND_ORANGE)
      .setShortCriticalText("$progressPercent%")
      .setRequestPromotedOngoing(ongoing)

    if (etaEpochMillis > System.currentTimeMillis()) {
      builder.setWhen(etaEpochMillis.toLong()).setShowWhen(true)
    }

    if (Build.VERSION.SDK_INT >= 36) {
      val style = NotificationCompat.ProgressStyle()
        .setStyledByProgress(true)
        .setProgress(progressPercent)
        .setProgressTrackerIcon(IconCompat.createWithResource(ctx, R.drawable.ic_delivery))
        .setProgressSegments(
          listOf(NotificationCompat.ProgressStyle.Segment(100).setColor(BRAND_ORANGE))
        )
        .setProgressPoints(
          listOf(NotificationCompat.ProgressStyle.Point(35).setColor(Color.WHITE))
        )
      builder.setStyle(style)
    } else {
      builder.setProgress(100, progressPercent, false)
    }

    val notification = builder.build()
    if (Build.VERSION.SDK_INT >= 36) {
      Log.d(TAG, "hasPromotableCharacteristics=${notification.hasPromotableCharacteristics()}")
    }
    manager.notify(notificationIdFor(activityId), notification)
  }

  fun cancelAfter(ctx: Context, activityId: String, delayMs: Long) {
    val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    mainHandler.postDelayed({ manager.cancel(notificationIdFor(activityId)) }, delayMs)
  }

  private fun stopsLabel(stops: Int) = when (stops) {
    0 -> "you're next"
    1 -> "1 stop away"
    else -> "$stops stops away"
  }

  private fun courierLine(courierName: String, riderReassigned: Boolean, stops: Int) =
    if (riderReassigned) "🔄 New rider: $courierName · ${stopsLabel(stops)}"
    else "$courierName · ${stopsLabel(stops)}"
}
