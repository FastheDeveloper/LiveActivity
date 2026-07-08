import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  LogBox,
  PermissionsAndroid,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';

import * as DroptrackLive from './modules/droptrack-live';
import type { DeliveryState } from './modules/droptrack-live';

// The scripted delivery. Each step is a full snapshot of the dynamic state —
// exactly what a real backend would push, minus the courier's actual GPS.
const STEPS: { status: string; progress: number; stopsRemaining: number; etaMinutes: number }[] = [
  { status: 'Order placed', progress: 0.05, stopsRemaining: 4, etaMinutes: 25 },
  { status: 'Courier assigned', progress: 0.15, stopsRemaining: 4, etaMinutes: 22 },
  { status: 'Picked up your order', progress: 0.35, stopsRemaining: 3, etaMinutes: 18 },
  { status: 'On the way', progress: 0.55, stopsRemaining: 2, etaMinutes: 12 },
  { status: '2 stops away', progress: 0.7, stopsRemaining: 2, etaMinutes: 8 },
  { status: 'Next stop: you', progress: 0.85, stopsRemaining: 1, etaMinutes: 4 },
  { status: 'Arriving now 🛵', progress: 0.95, stopsRemaining: 0, etaMinutes: 1 },
];
const DELIVERED = { status: 'Delivered 🎉', progress: 1, stopsRemaining: 0, etaMinutes: 0 };

const ORDER = { orderId: 'DT-4521' };
// Riders the dispatcher can swap between mid-delivery.
const RIDERS = ['Ade', 'Tunde', 'Chioma'];
const AUTO_STEP_MS = 5000;

// RN's SafeAreaView deprecation notice — known, harmless in this dev harness,
// and it photobombs every article screenshot.
LogBox.ignoreLogs(['SafeAreaView has been deprecated']);

type Rider = { name: string; justReassigned: boolean };

function toDeliveryState(step: (typeof STEPS)[number], rider: Rider): DeliveryState {
  return {
    status: step.status,
    progress: step.progress,
    stopsRemaining: step.stopsRemaining,
    etaEpochMillis: Date.now() + step.etaMinutes * 60_000,
    courierName: rider.name,
    riderReassigned: rider.justReassigned,
  };
}

export default function App() {
  const [activityId, setActivityId] = useState<string | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [rider, setRider] = useState<Rider>({ name: RIDERS[0], justReassigned: false });
  const [auto, setAuto] = useState(false);
  const stepRef = useRef(stepIndex);
  stepRef.current = stepIndex;
  const riderRef = useRef(rider);
  riderRef.current = rider;

  const supported = DroptrackLive.isSupported();
  const enabled = DroptrackLive.areActivitiesEnabled();
  // Android only: will the OS promote us to the status-bar chip + lock screen?
  const promoted = DroptrackLive.canPostPromotedNotifications();
  const running = activityId != null;

  // iOS Live Activities need no permission; Android notifications do (API 33+).
  useEffect(() => {
    if (Platform.OS === 'android') {
      void PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS
      );
    }
  }, []);

  const fail = (err: unknown) =>
    Alert.alert('Live activity error', err instanceof Error ? err.message : String(err));

  const start = async () => {
    try {
      const freshRider = { name: RIDERS[0], justReassigned: false };
      const id = await DroptrackLive.startDelivery(ORDER, toDeliveryState(STEPS[0], freshRider));
      setRider(freshRider);
      setActivityId(id);
      setStepIndex(0);
    } catch (err) {
      fail(err);
    }
  };

  const goToStep = async (index: number) => {
    if (!activityId) return;
    try {
      // Advancing a step retires the "new rider" badge (a real app would
      // time it out instead).
      const settled = { ...riderRef.current, justReassigned: false };
      await DroptrackLive.updateDelivery(activityId, toDeliveryState(STEPS[index], settled));
      setRider(settled);
      setStepIndex(index);
    } catch (err) {
      fail(err);
    }
  };

  // Dispatcher swaps the rider mid-delivery — same step, new courier.
  // This is the state that forced courierName out of the static attributes.
  const reassignRider = async () => {
    if (!activityId) return;
    try {
      const next = RIDERS[(RIDERS.indexOf(riderRef.current.name) + 1) % RIDERS.length];
      const swapped = { name: next, justReassigned: true };
      await DroptrackLive.updateDelivery(
        activityId,
        toDeliveryState(STEPS[stepRef.current], swapped)
      );
      setRider(swapped);
    } catch (err) {
      fail(err);
    }
  };

  const nextStep = async () => {
    if (stepIndex < STEPS.length - 1) {
      await goToStep(stepIndex + 1);
    } else {
      await deliver();
    }
  };

  const deliver = async () => {
    if (!activityId) return;
    try {
      // Final state stays on the lock screen briefly, then dismisses itself.
      await DroptrackLive.endDelivery(
        activityId,
        toDeliveryState(DELIVERED, { ...riderRef.current, justReassigned: false }),
        30
      );
      setActivityId(null);
      setAuto(false);
    } catch (err) {
      fail(err);
    }
  };

  const cancel = async () => {
    if (!activityId) return;
    try {
      await DroptrackLive.endDelivery(
        activityId,
        {
          ...toDeliveryState(STEPS[stepIndex], { ...riderRef.current, justReassigned: false }),
          status: 'Delivery cancelled',
        },
        0 // dismiss immediately
      );
      setActivityId(null);
      setAuto(false);
    } catch (err) {
      fail(err);
    }
  };

  // Dev-only remote control: the iOS simulator has no scriptable tap (no
  // uiautomator equivalent), so the test harness drives the console through
  // deep links instead: `simctl openurl booted com.fasarticle.droptrack://drive/<action>`.
  // Stripped from release builds.
  const actionsRef = useRef<Record<string, () => void>>({});
  actionsRef.current = {
    start,
    next: nextStep,
    reassign: reassignRider,
    deliver,
    cancel,
  };
  useEffect(() => {
    if (!__DEV__) return;
    const sub = Linking.addEventListener('url', ({ url }) => {
      const action = url.split('/').pop() ?? '';
      actionsRef.current[action]?.();
    });
    return () => sub.remove();
  }, []);

  // Auto-simulate: advance one step every few seconds until delivered.
  useEffect(() => {
    if (!auto || !running) return;
    const timer = setInterval(() => {
      if (stepRef.current < STEPS.length - 1) {
        void goToStep(stepRef.current + 1);
      } else {
        void deliver();
      }
    }, AUTO_STEP_MS);
    return () => clearInterval(timer);
  }, [auto, running, activityId]);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <Text style={styles.title}>
        DropTrack <Text style={styles.titleAccent}>dev console</Text>
      </Text>

      <View style={styles.card}>
        <Row label="Platform support" value={supported ? 'yes' : 'no'} good={supported} />
        <Row label="Enabled in Settings" value={enabled ? 'yes' : 'no'} good={enabled} />
        {Platform.OS === 'android' && (
          <Row label="Live Updates promotion" value={promoted ? 'yes' : 'no'} good={promoted} />
        )}
        <Row label="Activity" value={running ? activityId!.slice(0, 8) + '…' : 'none'} good={running} />
      </View>

      <View style={styles.card}>
        <Text style={styles.stepHeading}>
          {running ? STEPS[stepIndex].status : 'Not tracking'}
        </Text>
        <View style={styles.dots}>
          {STEPS.map((_, i) => (
            <Pressable
              key={i}
              disabled={!running}
              onPress={() => goToStep(i)}
              style={[styles.dot, running && i <= stepIndex && styles.dotActive]}
            />
          ))}
        </View>
        <Text style={styles.hint}>
          {running ? 'tap a dot to jump to that step' : 'start a delivery to begin'}
        </Text>
      </View>

      {!running ? (
        <Button title="Start delivery" onPress={start} primary />
      ) : (
        <>
          <Button title={`Next step (${stepIndex + 1}/${STEPS.length})`} onPress={nextStep} primary />
          <View style={styles.buttonRow}>
            <View style={{ flex: 1 }}>
              <Button title="Restart steps" onPress={() => goToStep(0)} />
            </View>
            <View style={{ flex: 1 }}>
              <Button title="Deliver now" onPress={deliver} />
            </View>
          </View>
          <Button
            title={`Reassign rider (now: ${rider.name}${rider.justReassigned ? ' 🔄' : ''})`}
            onPress={reassignRider}
          />
          <Button title="Cancel delivery" onPress={cancel} destructive />
          <View style={styles.autoRow}>
            <Text style={styles.autoLabel}>Auto-simulate (step every 5s)</Text>
            <Switch value={auto} onValueChange={setAuto} trackColor={{ true: ORANGE }} />
          </View>
        </>
      )}

      <Text style={styles.footer}>
        Lock the device (⌘L in simulator) to see the Live Activity
      </Text>
    </SafeAreaView>
  );
}

function Row({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, { color: good ? '#4ade80' : '#f87171' }]}>{value}</Text>
    </View>
  );
}

function Button({
  title,
  onPress,
  primary,
  destructive,
}: {
  title: string;
  onPress: () => void;
  primary?: boolean;
  destructive?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        primary && styles.buttonPrimary,
        destructive && styles.buttonDestructive,
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text style={[styles.buttonText, primary && styles.buttonTextPrimary]}>{title}</Text>
    </Pressable>
  );
}

const ORANGE = '#ff6b2c';
const BG = '#12121e';
const CARD = '#1d1d2e';

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: BG, padding: 20, gap: 12 },
  title: { color: 'white', fontSize: 28, fontWeight: '800', marginTop: 8 },
  titleAccent: { color: ORANGE, fontWeight: '400' },
  card: { backgroundColor: CARD, borderRadius: 16, padding: 16, gap: 10 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  rowLabel: { color: '#9ca3af', fontSize: 14 },
  rowValue: { fontSize: 14, fontWeight: '600' },
  stepHeading: { color: 'white', fontSize: 20, fontWeight: '700' },
  dots: { flexDirection: 'row', gap: 8 },
  dot: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#374151',
  },
  dotActive: { backgroundColor: ORANGE },
  hint: { color: '#6b7280', fontSize: 12 },
  button: {
    backgroundColor: CARD,
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonPrimary: { backgroundColor: ORANGE },
  buttonDestructive: { backgroundColor: '#450a0a' },
  buttonRow: { flexDirection: 'row', gap: 12 },
  buttonText: { color: 'white', fontSize: 16, fontWeight: '600' },
  buttonTextPrimary: { color: '#12121e' },
  autoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  autoLabel: { color: '#9ca3af', fontSize: 14 },
  footer: { color: '#4b5563', fontSize: 12, textAlign: 'center', marginTop: 'auto' },
});
