import { Platform } from 'react-native';

import DroptrackLiveModule from './src/DroptrackLiveModule';
import type {
  DeliveryInfo,
  DeliveryState,
  DeliveryPushEvent,
  PushTokenEvent,
  RunningActivity,
} from './src/DroptrackLive.types';

export type { DeliveryInfo, DeliveryState, DeliveryPushEvent, PushTokenEvent, RunningActivity };

/**
 * Whether this device can show live delivery tracking at all
 * (iOS 16.2+ for Live Activities; Android 16+ for Live Updates).
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

/**
 * iOS only: subscribe to per-activity APNs push tokens. The token shows up
 * asynchronously after startDelivery — sometimes seconds later — and may be
 * rotated by the system, so treat every event as the new source of truth.
 * Returns a remove()-able subscription; no-ops on Android.
 */
export function onPushTokenReceived(
  listener: (event: PushTokenEvent) => void
): { remove: () => void } {
  // isSupported() is also true on Android 16+, where this event doesn't exist.
  if (Platform.OS !== 'ios' || !isSupported()) return { remove: () => {} };
  return DroptrackLiveModule.addListener('onPushTokenReceived', listener);
}

/**
 * iOS only: current push token for an activity, or null if APNs hasn't
 * issued one yet (or the platform doesn't support push-driven activities).
 */
export async function getPushToken(activityId: string): Promise<string | null> {
  if (!DroptrackLiveModule.getPushToken) return null;
  return DroptrackLiveModule.getPushToken(activityId);
}

/**
 * Android only: the FCM registration token for this install (the target for a
 * remote Live Update push). Null on iOS or if unavailable. Also logged natively
 * so the dispatch server can scrape it from `adb logcat`.
 */
export async function getFcmToken(): Promise<string | null> {
  if (!DroptrackLiveModule.getFcmToken) return null;
  return DroptrackLiveModule.getFcmToken();
}

/**
 * Android only: an FCM push arrived while the app is running. The notification
 * updates regardless; subscribe to keep the in-app UI in sync too. No-op on iOS.
 */
export function onDeliveryPush(
  listener: (event: DeliveryPushEvent) => void
): { remove: () => void } {
  if (Platform.OS !== 'android') return { remove: () => {} };
  return DroptrackLiveModule.addListener('onDeliveryPush', listener);
}

/**
 * Activities still running from a previous launch of the app.
 *
 * Live Activities are owned by the system, not by your process — they survive
 * force-quit, JS reloads and relaunches. Tapping the lock-screen card or the
 * Dynamic Island cold-starts the app, so call this on mount and re-attach, or
 * the UI will claim nothing is tracking while the card is plainly on screen.
 */
export async function getRunningActivities(): Promise<RunningActivity[]> {
  if (!DroptrackLiveModule.getRunningActivities) return [];
  return DroptrackLiveModule.getRunningActivities();
}

/** Dev helper: end every running activity immediately. */
export async function endAll(): Promise<void> {
  await DroptrackLiveModule.endAll?.();
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
