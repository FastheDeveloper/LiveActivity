import { NativeModule, requireNativeModule } from 'expo';

import type {
  DeliveryInfo,
  DeliveryState,
  DeliveryPushEvent,
  PushTokenEvent,
  RunningActivity,
} from './DroptrackLive.types';

type DroptrackLiveEvents = {
  /** iOS only — never fires on Android. */
  onPushTokenReceived(event: PushTokenEvent): void;
  /** Android only — an FCM push arrived while the app is running. */
  onDeliveryPush(event: DeliveryPushEvent): void;
};

declare class DroptrackLiveModule extends NativeModule<DroptrackLiveEvents> {
  isSupported: boolean;
  /** Android only — true when running on Android 16+ (API 36). */
  supportsLiveUpdates?: boolean;
  areActivitiesEnabled(): boolean;
  /** Android only — absent on iOS, where promotion doesn't exist. */
  canPostPromotedNotifications?(): boolean;
  startDelivery(info: DeliveryInfo, state: DeliveryState): Promise<string>;
  /** iOS only — hex APNs token for the activity, or null if not issued yet. */
  getPushToken?(activityId: string): Promise<string | null>;
  /** Android only — the FCM registration token for this install. */
  getFcmToken?(): Promise<string>;
  /** iOS only — activities still running, started by any previous launch. */
  getRunningActivities?(): Promise<RunningActivity[]>;
  /** iOS only — dev helper: end every running activity immediately. */
  endAll?(): Promise<void>;
  updateDelivery(activityId: string, state: DeliveryState): Promise<void>;
  endDelivery(
    activityId: string,
    state: DeliveryState,
    dismissAfterSeconds?: number
  ): Promise<void>;
}

export default requireNativeModule<DroptrackLiveModule>('DroptrackLive');
