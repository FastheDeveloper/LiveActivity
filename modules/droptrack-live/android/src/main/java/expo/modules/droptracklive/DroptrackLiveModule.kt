package expo.modules.droptracklive

import android.app.NotificationManager
import android.content.Context
import android.os.Build
import android.util.Log
import com.google.firebase.messaging.FirebaseMessaging
import expo.modules.kotlin.Promise
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

// Android has no ActivityKit — "the activity" is just a notification we keep
// re-posting under the same ID (see DeliveryNotifier). The JS-driven path lives
// here; the push-driven path lives in DroptrackFcmService. Both render through
// the shared DeliveryNotifier so they produce an identical notification.
class DroptrackLiveModule : Module() {
  private val deliveries = mutableMapOf<String, DeliveryInfoRecord>()

  override fun definition() = ModuleDefinition {
    Name("DroptrackLive")

    // Emitted when the module observes an FCM registration token (getFcmToken).
    Events("onFcmTokenReceived")

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

    // FCM registration token for this install. Also logged so the dispatch
    // server can scrape it from `adb logcat` (mirrors the iOS devicectl scrape).
    AsyncFunction("getFcmToken") { promise: Promise ->
      FirebaseMessaging.getInstance().token
        .addOnSuccessListener { token ->
          Log.i(DeliveryNotifier.TAG, "[DropTrack] fcm token: $token")
          sendEvent("onFcmTokenReceived", mapOf("token" to token))
          promise.resolve(token)
        }
        .addOnFailureListener { e ->
          promise.reject("E_FCM_TOKEN", e.message ?: "token fetch failed", e)
        }
    }

    AsyncFunction("startDelivery") { info: DeliveryInfoRecord, state: DeliveryStateRecord ->
      val ctx = context ?: throw NoContextException()
      DeliveryNotifier.ensureChannel(ctx)
      val activityId = "delivery-${info.orderId}"
      deliveries[activityId] = info
      postState(ctx, activityId, info, state, ongoing = true)
      return@AsyncFunction activityId
    }

    AsyncFunction("updateDelivery") { activityId: String, state: DeliveryStateRecord ->
      val ctx = context ?: throw NoContextException()
      val info = deliveries[activityId] ?: throw ActivityNotFoundException(activityId)
      postState(ctx, activityId, info, state, ongoing = true)
    }

    AsyncFunction("endDelivery") { activityId: String, state: DeliveryStateRecord, dismissAfterSeconds: Double? ->
      val ctx = context ?: throw NoContextException()
      val info = deliveries.remove(activityId) ?: throw ActivityNotFoundException(activityId)
      postState(ctx, activityId, info, state, ongoing = false)
      if (dismissAfterSeconds != null) {
        DeliveryNotifier.cancelAfter(ctx, activityId, (dismissAfterSeconds * 1000).toLong())
      }
    }
  }

  private val context: Context?
    get() = appContext.reactContext

  private val notificationManager: NotificationManager?
    get() = context?.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager

  // Unpacks the Expo Records into the shared builder used by both entry points.
  private fun postState(
    ctx: Context,
    activityId: String,
    info: DeliveryInfoRecord,
    state: DeliveryStateRecord,
    ongoing: Boolean,
  ) {
    DeliveryNotifier.post(
      ctx, activityId, info.orderId, state.status, state.progress,
      state.etaEpochMillis, state.stopsRemaining, state.courierName,
      state.riderReassigned, ongoing,
    )
  }
}
