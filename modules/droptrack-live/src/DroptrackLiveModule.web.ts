import { registerWebModule, NativeModule } from 'expo';

// Web has no Live Activity equivalent — every call is a safe no-op.
class DroptrackLiveModule extends NativeModule {
  isSupported = false;

  areActivitiesEnabled(): boolean {
    return false;
  }

  async startDelivery(): Promise<string> {
    throw new Error('Live activities are not supported on web');
  }

  async updateDelivery(): Promise<void> {}

  async endDelivery(): Promise<void> {}
}

export default registerWebModule(DroptrackLiveModule, 'DroptrackLiveModule');
