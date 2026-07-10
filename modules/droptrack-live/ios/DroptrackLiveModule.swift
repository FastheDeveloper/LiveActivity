import ActivityKit
import ExpoModulesCore

// Records give us type-safe bridging: Expo validates the JS object against
// these fields before the function body ever runs.
struct DeliveryInfoRecord: Record {
  @Field var orderId: String = ""
}

struct DeliveryStateRecord: Record {
  @Field var status: String = ""
  @Field var progress: Double = 0
  // Dates cross the bridge as epoch milliseconds (JS Date.getTime()).
  @Field var etaEpochMillis: Double = 0
  @Field var stopsRemaining: Int = 0
  // Courier is dynamic state, not a static attribute — riders get reassigned.
  @Field var courierName: String = ""
  @Field var riderReassigned: Bool = false

  @available(iOS 16.2, *)
  func toContentState() -> DeliveryAttributes.ContentState {
    DeliveryAttributes.ContentState(
      status: status,
      progress: min(max(progress, 0), 1),
      eta: Date(timeIntervalSince1970: etaEpochMillis / 1000),
      stopsRemaining: stopsRemaining,
      courierName: courierName,
      riderReassigned: riderReassigned
    )
  }
}

final class LiveActivityUnsupportedException: Exception {
  override var reason: String {
    "Live Activities require iOS 16.2 or later"
  }
}

final class ActivityNotFoundException: GenericException<String> {
  override var reason: String {
    "No live activity found with id '\(param)' — it may have ended or been dismissed by the user"
  }
}

public class DroptrackLiveModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DroptrackLive")

    // Fired whenever APNs (re)issues a push token for an activity. Tokens are
    // per-activity, not per-device — every startDelivery gets its own, and the
    // system can rotate it mid-flight, hence a stream and not a return value.
    Events("onPushTokenReceived")

    Constant("isSupported") {
      if #available(iOS 16.2, *) { return true }
      return false
    }

    // Users can turn Live Activities off per-app in Settings; a well-behaved
    // app checks this before offering the feature.
    Function("areActivitiesEnabled") { () -> Bool in
      guard #available(iOS 16.2, *) else { return false }
      return ActivityAuthorizationInfo().areActivitiesEnabled
    }

    AsyncFunction("startDelivery") { (info: DeliveryInfoRecord, state: DeliveryStateRecord) -> String in
      guard #available(iOS 16.2, *) else {
        throw LiveActivityUnsupportedException()
      }
      let attributes = DeliveryAttributes(orderId: info.orderId)
      let content = ActivityContent(state: state.toContentState(), staleDate: nil)
      let activity = try Activity.request(
        attributes: attributes,
        content: content,
        pushType: .token  // ask APNs for a per-activity update token
      )
      self.observePushToken(of: activity)
      return activity.id
    }

    // Live Activities outlive the process that started them: they belong to the
    // system, not to us. So a fresh launch (including one caused by TAPPING the
    // activity) has no activityId in JS state and would otherwise render as
    // "not tracking" while the card is still on the lock screen. Re-attach here.
    AsyncFunction("getRunningActivities") { () -> [[String: Any]] in
      guard #available(iOS 16.2, *) else { return [] }
      return Activity<DeliveryAttributes>.activities.map { activity in
        // Re-subscribe: the previous process's pushTokenUpdates loop died with it,
        // so without this a token rotation after relaunch would go unnoticed.
        self.observePushToken(of: activity)
        let state = activity.content.state
        return [
          "activityId": activity.id,
          "orderId": activity.attributes.orderId,
          "status": state.status,
          "progress": state.progress,
          "etaEpochMillis": state.eta.timeIntervalSince1970 * 1000,
          "stopsRemaining": state.stopsRemaining,
          "courierName": state.courierName,
          "riderReassigned": state.riderReassigned,
          "pushToken": activity.pushToken?.map { String(format: "%02x", $0) }.joined() ?? "",
        ]
      }
    }

    // Dev helper: a JS reload orphans activities (they live ~8h). Without this
    // the only way out is to wait them out or delete the app.
    AsyncFunction("endAll") { () in
      guard #available(iOS 16.2, *) else { return }
      for activity in Activity<DeliveryAttributes>.activities {
        await activity.end(nil, dismissalPolicy: .immediate)
      }
    }

    // Late joiner's escape hatch: after a JS reload the event may have fired
    // before any listener existed, so allow polling the current token too.
    AsyncFunction("getPushToken") { (activityId: String) -> String? in
      guard #available(iOS 16.2, *) else {
        throw LiveActivityUnsupportedException()
      }
      let activity = try Self.findActivity(id: activityId)
      return activity.pushToken?.map { String(format: "%02x", $0) }.joined()
    }

    AsyncFunction("updateDelivery") { (activityId: String, state: DeliveryStateRecord) in
      guard #available(iOS 16.2, *) else {
        throw LiveActivityUnsupportedException()
      }
      let activity = try Self.findActivity(id: activityId)
      await activity.update(
        ActivityContent(state: state.toContentState(), staleDate: nil)
      )
    }

    AsyncFunction("endDelivery") { (activityId: String, state: DeliveryStateRecord, dismissAfterSeconds: Double?) in
      guard #available(iOS 16.2, *) else {
        throw LiveActivityUnsupportedException()
      }
      let activity = try Self.findActivity(id: activityId)
      // .default lets the system keep the final state on the lock screen for
      // a while (up to 4h); a timed policy removes it sooner.
      let policy: ActivityUIDismissalPolicy
      if let seconds = dismissAfterSeconds {
        policy = .after(Date().addingTimeInterval(seconds))
      } else {
        policy = .default
      }
      await activity.end(
        ActivityContent(state: state.toContentState(), staleDate: nil),
        dismissalPolicy: policy
      )
    }
  }

  // Streams every token APNs issues for this activity (including rotations) to
  // JS, and to the system log — on a device with no Metro connection, NSLog is
  // the only way to read the token back out.
  @available(iOS 16.2, *)
  private func observePushToken(of activity: Activity<DeliveryAttributes>) {
    Task { [weak self] in
      for await tokenData in activity.pushTokenUpdates {
        let token = tokenData.map { String(format: "%02x", $0) }.joined()
        NSLog("[DropTrack] push token for %@: %@", activity.id, token)
        self?.sendEvent("onPushTokenReceived", [
          "activityId": activity.id,
          "token": token,
        ])
      }
    }
  }

  // Activities are looked up fresh on every call instead of being cached in a
  // property — activity handles live in ActivityKit itself, so this stays
  // correct across JS reloads during development.
  @available(iOS 16.2, *)
  private static func findActivity(id: String) throws -> Activity<DeliveryAttributes> {
    guard let activity = Activity<DeliveryAttributes>.activities.first(where: { $0.id == id }) else {
      throw ActivityNotFoundException(id)
    }
    return activity
  }
}
