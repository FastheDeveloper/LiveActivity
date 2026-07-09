// Browser-side client for the dispatch server (scripts/dispatch-server.mjs).
// SSE for token/result events, fetch for pushes. Web-only.
import type { DeliveryState } from '../modules/droptrack-live';

const BASE = 'http://127.0.0.1:8787';

export type Platform = 'ios' | 'android';

export type PushResult = { activityId: string; platform: Platform; status: number; reason: string | null; at: number };

export type DispatchEvents = {
  onToken: (activityId: string, token: string, platform: Platform) => void;
  onActivityGone: (activityId: string) => void;
  onPushResult: (result: PushResult) => void;
  onError: () => void;
  onOpen: () => void;
};

export function connectDispatch(handlers: DispatchEvents): () => void {
  const es = new EventSource(`${BASE}/events`);
  es.addEventListener('open', () => handlers.onOpen());
  es.addEventListener('token', (e) => {
    const { activityId, token, platform } = JSON.parse((e as MessageEvent).data);
    handlers.onToken(activityId, token, platform);
  });
  es.addEventListener('activity-gone', (e) => {
    const { activityId } = JSON.parse((e as MessageEvent).data);
    handlers.onActivityGone(activityId);
  });
  es.addEventListener('push-result', (e) => {
    handlers.onPushResult(JSON.parse((e as MessageEvent).data));
  });
  es.addEventListener('error', () => handlers.onError());
  return () => es.close();
}

// The /push response body is just { status, reason }; the full PushResult
// (with activityId + at) arrives separately via the SSE 'push-result' event,
// which is what the UI logs. Callers can ignore this return value.
export async function sendPush(
  activityId: string,
  state: DeliveryState & { orderId?: string },
  event: 'update' | 'end',
  platform: Platform
): Promise<{ status: number; reason: string | null }> {
  const res = await fetch(`${BASE}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activityId, state, event, platform }),
  });
  return res.json();
}
