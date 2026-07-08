import ActivityKit
import Foundation

// The "contract" for our Live Activity, split in two:
//  - static attributes: set once when the activity starts, never change
//  - ContentState: the dynamic part — every update pushes a new one
//
// IMPORTANT: the widget extension (added in Phase 1b) must compile an
// IDENTICAL copy of this struct. ActivityKit matches the app's activity to
// the widget's UI by the attribute type's name and its Codable shape, so the
// two definitions have to stay in lockstep.
//
// HISTORY: courierName started life as a static attribute — then Phase 2's
// rider-reassignment feature proved couriers *do* change mid-delivery, and
// the compiler made us move it here. The static half is a bet that a field
// can never change; lose the bet and every layer of the contract moves.
struct DeliveryAttributes: ActivityAttributes {
  public struct ContentState: Codable, Hashable {
    /// Human-readable status, e.g. "Picked up", "2 stops away"
    var status: String
    /// Overall delivery progress, 0.0 ... 1.0
    var progress: Double
    /// Estimated arrival time
    var eta: Date
    /// Stops before the courier reaches the user
    var stopsRemaining: Int
    /// Courier display name — dynamic since riders can be reassigned mid-run
    var courierName: String
    /// True right after a reassignment; drives the "new rider" treatment
    var riderReassigned: Bool
  }

  /// Order identifier shown on the card — the only truly immutable fact
  var orderId: String
}
