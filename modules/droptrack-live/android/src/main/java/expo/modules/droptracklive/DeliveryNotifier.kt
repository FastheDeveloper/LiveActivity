package expo.modules.droptracklive

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.graphics.drawable.IconCompat
import org.json.JSONObject

// Shared notification builder. Called from BOTH the Expo module (JS-driven,
// local) and DroptrackFcmService (push-driven, from a background process that
// has no access to the module's in-memory state). Everything needed to render
// is passed in — no shared mutable state.
object DeliveryNotifier {
  const val TAG = "DroptrackLive"
  private const val CHANNEL_ID = "droptrack.delivery"
  private const val BRAND_ORANGE = 0xFFFF6B2C.toInt()
  private const val PREFS = "droptrack"
  private const val KEY_ACTIVE = "active_delivery"

  private val mainHandler = Handler(Looper.getMainLooper())

  fun notificationIdFor(activityId: String) = activityId.hashCode()

  // Persist the live delivery so a cold-started app (e.g. after tapping the
  // notification when the process was killed) can rehydrate its UI. Android has
  // no ActivityKit store, so the notification's backing state lives here. Ended
  // deliveries clear the record. Read back by getRunningActivities().
  private fun persist(
    ctx: Context, activityId: String, orderId: String, status: String, progress: Double,
    etaEpochMillis: Double, stopsRemaining: Int, courierName: String, riderReassigned: Boolean,
    ongoing: Boolean,
  ) {
    val prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    if (!ongoing) {
      prefs.edit().remove(KEY_ACTIVE).apply()
      return
    }
    val json = JSONObject().apply {
      put("activityId", activityId); put("orderId", orderId); put("status", status)
      put("progress", progress); put("etaEpochMillis", etaEpochMillis)
      put("stopsRemaining", stopsRemaining); put("courierName", courierName)
      put("riderReassigned", riderReassigned)
    }
    prefs.edit().putString(KEY_ACTIVE, json.toString()).apply()
  }

  // True if our notification for this activity is currently in the tray. Used
  // to detect a stale persisted record (notification dismissed/cleared, e.g. by
  // a reinstall) so we don't rehydrate a phantom.
  fun isActive(ctx: Context, activityId: String): Boolean {
    val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val id = notificationIdFor(activityId)
    return manager.activeNotifications.any { it.id == id }
  }

  // Forget the persisted delivery (without touching any notification).
  fun clear(ctx: Context) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(KEY_ACTIVE).apply()
  }

  // Tear a delivery down unconditionally: cancel the notification + clear state.
  // Safe to call for an activity this process never tracked (stale / cold start).
  fun cancel(ctx: Context, activityId: String) {
    val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.cancel(notificationIdFor(activityId))
    clear(ctx)
  }

  // The persisted live delivery as a JS-friendly map, or null if none.
  fun activeDelivery(ctx: Context): Map<String, Any?>? {
    val raw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_ACTIVE, null)
      ?: return null
    val j = JSONObject(raw)
    return mapOf(
      "activityId" to j.getString("activityId"),
      "orderId" to j.getString("orderId"),
      "status" to j.getString("status"),
      "progress" to j.getDouble("progress"),
      "etaEpochMillis" to j.getDouble("etaEpochMillis"),
      "stopsRemaining" to j.getInt("stopsRemaining"),
      "courierName" to j.getString("courierName"),
      "riderReassigned" to j.getBoolean("riderReassigned"),
      "pushToken" to "",
    )
  }

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

    // Tapping the notification opens the app. Without a content intent Android
    // has no tap target and just expands/collapses the notification.
    launchIntent(ctx, activityId)?.let { builder.setContentIntent(it) }

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
    persist(
      ctx, activityId, orderId, status, progress, etaEpochMillis,
      stopsRemaining, courierName, riderReassigned, ongoing,
    )
  }

  // PendingIntent that (re)opens the app's main activity when the notification
  // is tapped. Keyed per activity so distinct deliveries don't collide.
  private fun launchIntent(ctx: Context, activityId: String): PendingIntent? {
    val intent = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
      ?.apply { flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP }
      ?: return null
    return PendingIntent.getActivity(
      ctx,
      notificationIdFor(activityId),
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
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
