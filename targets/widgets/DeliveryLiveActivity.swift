import ActivityKit
import SwiftUI
import WidgetKit

private let brandOrange = Color(red: 1.0, green: 0.42, blue: 0.17)
// Matches the in-app track colour (#374151) so the lock-screen bar reads as
// the same component as the dev console's.
private let trackGray = Color(red: 0.216, green: 0.255, blue: 0.318)

// Segmented progress bar mirroring the in-app one: one capsule per delivery
// step, filling left-to-right. The ContentState only carries `progress`
// (0...1), not a step index, so we derive the filled count from it — with the
// scripted step values (0.05…1.0) this fills 1→7 segments in lockstep.
private struct SegmentedProgressBar: View {
  let progress: Double
  var segments: Int = 7  // mirrors STEPS.count in the app

  private var filled: Int {
    let clamped = min(max(progress, 0), 1)
    return min(segments, Int((clamped * Double(segments)).rounded(.up)))
  }

  var body: some View {
    HStack(spacing: 5) {
      ForEach(0..<segments, id: \.self) { i in
        RoundedRectangle(cornerRadius: 3, style: .continuous)
          .fill(i < filled ? brandOrange : trackGray)
          .frame(height: 7)
      }
    }
  }
}

struct DeliveryLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: DeliveryAttributes.self) { context in
      // ── Lock screen / banner presentation ────────────────────────────
      DeliveryCardView(context: context)
        .activityBackgroundTint(Color(red: 0.07, green: 0.07, blue: 0.12))
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      DynamicIsland {
        // ── Expanded island (long-press) ────────────────────────────────
        DynamicIslandExpandedRegion(.leading) {
          Image(systemName: "bicycle")
            .font(.title2)
            .foregroundStyle(brandOrange)
            .padding(.leading, 4)
        }
        DynamicIslandExpandedRegion(.trailing) {
          Text(context.state.eta, style: .time)
            .font(.callout.bold())
            .foregroundStyle(brandOrange)
            .padding(.trailing, 4)
        }
        DynamicIslandExpandedRegion(.center) {
          Text(context.state.status)
            .font(.callout.weight(.semibold))
            .lineLimit(1)
        }
        DynamicIslandExpandedRegion(.bottom) {
          VStack(spacing: 4) {
            SegmentedProgressBar(progress: context.state.progress)
            HStack {
              CourierLabel(state: context.state, compact: true)
              Spacer()
              Text(stopsLabel(context.state.stopsRemaining))
            }
            .font(.caption2)
            .foregroundStyle(.secondary)
          }
          .padding(.horizontal, 4)
        }
      } compactLeading: {
        // ── Pill, left of the camera cutout ─────────────────────────────
        Image(systemName: "bicycle")
          .foregroundStyle(brandOrange)
      } compactTrailing: {
        // ── Pill, right of the cutout: live progress % ───────────────────
        Text("\(Int(context.state.progress * 100))%")
          .font(.caption2.bold())
          .foregroundStyle(brandOrange)
      } minimal: {
        // ── When another app's activity shares the island ────────────────
        Image(systemName: "bicycle")
          .foregroundStyle(brandOrange)
      }
      .keylineTint(brandOrange)
    }
  }
}

// One card, used for the lock screen and the notification-style banner.
private struct DeliveryCardView: View {
  let context: ActivityViewContext<DeliveryAttributes>

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Label("DropTrack", systemImage: "shippingbox.fill")
          .font(.caption.bold())
          .foregroundStyle(brandOrange)
        Spacer()
        Text("Order \(context.attributes.orderId)")
          .font(.caption2)
          .foregroundStyle(.white.opacity(0.6))
      }

      Text(context.state.status)
        .font(.title3.weight(.semibold))
        .foregroundStyle(.white)

      SegmentedProgressBar(progress: context.state.progress)

      HStack {
        CourierLabel(state: context.state, compact: false)
        Text("·")
        Text(stopsLabel(context.state.stopsRemaining))
        Spacer()
        if context.state.progress < 1 {
          Text("ETA ") + Text(context.state.eta, style: .time).bold()
        } else {
          Text("Enjoy! 🎉").bold()
        }
      }
      .font(.caption)
      .foregroundStyle(.white.opacity(0.75))
    }
    .padding(16)
  }
}

// Courier row, shared by the lock-screen card and the expanded island.
// After a reassignment the row flips to the "new rider" treatment so the
// change is glanceable — the whole point of a Live Activity.
private struct CourierLabel: View {
  let state: DeliveryAttributes.ContentState
  let compact: Bool

  var body: some View {
    if state.riderReassigned {
      Label(
        compact ? state.courierName : "New rider · \(state.courierName)",
        systemImage: "arrow.triangle.2.circlepath"
      )
      .foregroundStyle(brandOrange)
      .bold()
    } else {
      Label(state.courierName, systemImage: "bicycle")
    }
  }
}

private func stopsLabel(_ stops: Int) -> String {
  switch stops {
  case 0: return "you're next"
  case 1: return "1 stop away"
  default: return "\(stops) stops away"
  }
}
