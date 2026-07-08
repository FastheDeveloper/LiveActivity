import DroptrackLiveModule from './src/DroptrackLiveModule';
import type { DeliveryInfo, DeliveryState } from './src/DroptrackLive.types';

export type { DeliveryInfo, DeliveryState };

/**
 * Whether this device can show live delivery tracking at all
 * (iOS 16.2+ for Live Activities; Android 16+ for Live Updates in Phase 2).
 */
export function isSupported(): boolean {
  return DroptrackLiveModule.isSupported ?? false;
}

/**
 * Supported by the OS *and* not turned off by the user in Settings.
 */
export function areActivitiesEnabled(): boolean {
  if (!isSupported()) return false;
  return DroptrackLiveModule.areActivitiesEnabled();
}

/**
 * Android only: whether the OS will give our notifications the full
 * Live Updates treatment (status-bar chip, lock-screen slot). Requires
 * Android 16 QPR1+ AND the user not disabling "Live updates" for the app.
 * Always false on iOS — Live Activities have no promotion concept.
 */
export function canPostPromotedNotifications(): boolean {
  return DroptrackLiveModule.canPostPromotedNotifications?.() ?? false;
}

/**
 * Start live tracking. Resolves to an activity id — hold on to it,
 * every subsequent update/end call needs it.
 */
export async function startDelivery(
  info: DeliveryInfo,
  state: DeliveryState
): Promise<string> {
  return DroptrackLiveModule.startDelivery(info, state);
}

/** Push a new state onto the lock screen / Dynamic Island. */
export async function updateDelivery(
  activityId: string,
  state: DeliveryState
): Promise<void> {
  return DroptrackLiveModule.updateDelivery(activityId, state);
}

/**
 * End tracking with a final state (e.g. "Delivered 🎉").
 * By default iOS keeps the final card on the lock screen for a while;
 * pass `dismissAfterSeconds` to remove it sooner.
 */
export async function endDelivery(
  activityId: string,
  state: DeliveryState,
  dismissAfterSeconds?: number
): Promise<void> {
  return DroptrackLiveModule.endDelivery(activityId, state, dismissAfterSeconds);
}
