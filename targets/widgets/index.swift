import SwiftUI
import WidgetKit

// The extension's entry point. A WidgetBundle can host several widgets;
// ours has just the delivery Live Activity for now.
@main
struct DropTrackWidgets: WidgetBundle {
  var body: some Widget {
    DeliveryLiveActivity()
  }
}
