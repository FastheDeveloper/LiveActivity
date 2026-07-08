import { NativeModule, requireNativeModule } from 'expo';

import type { DeliveryInfo, DeliveryState } from './DroptrackLive.types';

declare class DroptrackLiveModule extends NativeModule {
  isSupported: boolean;
  /** Android only — true when running on Android 16+ (API 36). */
  supportsLiveUpdates?: boolean;
  areActivitiesEnabled(): boolean;
  /** Android only — absent on iOS, where promotion doesn't exist. */
  canPostPromotedNotifications?(): boolean;
  startDelivery(info: DeliveryInfo, state: DeliveryState): Promise<string>;
  updateDelivery(activityId: string, state: DeliveryState): Promise<void>;
  endDelivery(
    activityId: string,
    state: DeliveryState,
    dismissAfterSeconds?: number
  ): Promise<void>;
}

export default requireNativeModule<DroptrackLiveModule>('DroptrackLive');
