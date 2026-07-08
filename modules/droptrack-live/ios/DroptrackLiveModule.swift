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
        pushType: nil  // local updates only; push-driven updates are a follow-up
      )
      return activity.id
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
