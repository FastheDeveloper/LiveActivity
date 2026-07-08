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
