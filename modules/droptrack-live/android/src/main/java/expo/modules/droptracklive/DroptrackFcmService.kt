package expo.modules.droptracklive

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

// Receives data-only FCM messages and re-posts the Live Update. Runs in the
// app process even when backgrounded — this is the whole point: Android has no
// system-managed remote update, so OUR code renders every push. It has no
// access to the module's in-memory `deliveries` map (that lives in a possibly-
// dead module instance), so every field is read from the message payload.
class DroptrackFcmService : FirebaseMessagingService() {
  override fun onNewToken(token: String) {
    // The dispatch server scrapes this line from `adb logcat`.
    Log.i(DeliveryNotifier.TAG, "[DropTrack] fcm token: $token")
  }

  override fun onMessageReceived(message: RemoteMessage) {
    val d = message.data
    val activityId = d["activityId"] ?: return
    val event = d["event"] ?: "update"
    DeliveryNotifier.ensureChannel(this)
    DeliveryNotifier.post(
      ctx = this,
      activityId = activityId,
      orderId = d["orderId"] ?: "",
      status = d["status"] ?: "",
      progress = d["progress"]?.toDoubleOrNull() ?: 0.0,
      etaEpochMillis = d["etaEpochMillis"]?.toDoubleOrNull() ?: 0.0,
      stopsRemaining = d["stopsRemaining"]?.toIntOrNull() ?: 0,
      courierName = d["courierName"] ?: "",
      riderReassigned = d["riderReassigned"]?.toBoolean() ?: false,
      ongoing = event != "end",
    )
    if (event == "end") {
      DeliveryNotifier.cancelAfter(this, activityId, 30_000L)
    }
  }
}
