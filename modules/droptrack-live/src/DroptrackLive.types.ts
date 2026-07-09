/**
 * Static info about the delivery — set once when tracking starts,
 * cannot change for the lifetime of the activity.
 *
 * Deliberately tiny: anything that *might* change belongs in DeliveryState.
 * (courierName lived here until rider reassignment proved it dynamic.)
 */
export type DeliveryInfo = {
  /** Order identifier shown on the card, e.g. "DT-4521" */
  orderId: string;
};

/**
 * iOS only. Emitted when APNs issues (or rotates) the push token for one
 * activity. Tokens are PER-ACTIVITY: each startDelivery mints a new one,
 * and it is only valid for updating that specific activity.
 */
export type PushTokenEvent = {
  activityId: string;
  /** Hex-encoded APNs token — paste into scripts/push-update.mjs */
  token: string;
};

/**
 * Android only. Emitted when an FCM push arrives while the app is running, so
 * the UI can reflect it (the notification updates regardless). All values are
 * strings — FCM data is string-keyed; the JS handler parses them.
 */
export type DeliveryPushEvent = {
  activityId: string;
  orderId: string;
  status: string;
  progress: string;
  etaEpochMillis: string;
  stopsRemaining: string;
  courierName: string;
  riderReassigned: string;
  event: string;
};

/**
 * A live activity that is already running — recovered from the system rather
 * than from our own memory. `pushToken` is '' until APNs issues one.
 */
export type RunningActivity = DeliveryState & {
  activityId: string;
  orderId: string;
  pushToken: string;
};

/**
 * The dynamic part of the activity — every update sends a fresh one.
 * Keep it SMALL: iOS rejects content states over 4 KB.
 */
export type DeliveryState = {
  /** Human-readable status, e.g. "Picked up", "2 stops away" */
  status: string;
  /** Overall delivery progress, 0.0 – 1.0 */
  progress: number;
  /** Estimated arrival, as epoch milliseconds (Date.getTime()) */
  etaEpochMillis: number;
  /** Stops before the courier reaches the user */
  stopsRemaining: number;
  /** Courier display name, e.g. "Ade" — dynamic: riders get reassigned */
  courierName: string;
  /** True right after a reassignment; drives the "new rider" treatment */
  riderReassigned: boolean;
};
