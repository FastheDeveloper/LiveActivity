import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { STEPS, DELIVERED, RIDERS, toDeliveryState, type Rider } from './delivery';
import { connectDispatch, sendPush, type PushResult } from './src/dispatchClient';

export default function DispatcherConsole() {
  const [online, setOnline] = useState(false);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [rider, setRider] = useState<Rider>({ name: RIDERS[0], justReassigned: false });
  const [reassignNext, setReassignNext] = useState(false);
  const [log, setLog] = useState<PushResult[]>([]);
  const activityRef = useRef<string | null>(null);
  activityRef.current = activityId;

  useEffect(() => {
    const disconnect = connectDispatch({
      onOpen: () => setOnline(true),
      onError: () => setOnline(false),
      onToken: (id, tok) => {
        setActivityId(id);
        setToken(tok);
      },
      onActivityGone: (id) => {
        if (activityRef.current === id) {
          setActivityId(null);
          setToken(null);
        }
      },
      onPushResult: (r) => setLog((prev) => [r, ...prev].slice(0, 20)),
    });
    return disconnect;
  }, []);

  const push = async (step: typeof STEPS[number], event: 'update' | 'end') => {
    if (!activityId) return;
    const effectiveRider = reassignNext
      ? { name: nextRider(rider.name), justReassigned: true }
      : { ...rider, justReassigned: false };
    setRider(effectiveRider);
    setReassignNext(false);
    await sendPush(activityId, toDeliveryState(step, effectiveRider), event);
  };

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.title}>DropTrack <Text style={styles.accent}>dispatcher</Text></Text>

      <View style={styles.card}>
        <Row label="Dispatch server" value={online ? 'online' : 'offline'} good={online} />
        <Row label="Activity" value={activityId ? activityId.slice(0, 8) + '…' : 'waiting for phone…'} good={!!activityId} />
        <Row label="Push token" value={token ? token.slice(0, 8) + '…' : '—'} good={!!token} />
      </View>

      {!online && (
        <Text style={styles.warn}>
          Dispatch server offline. Run{' '}
          <Text style={styles.mono}>npm run dispatch</Text> and start an activity on the phone.
        </Text>
      )}

      <View style={styles.card}>
        <Text style={styles.heading}>Courier</Text>
        <View style={styles.riders}>
          {RIDERS.map((name) => (
            <Pressable
              key={name}
              onPress={() => setRider({ name, justReassigned: false })}
              style={[styles.chip, rider.name === name && styles.chipActive]}
            >
              <Text style={[styles.chipText, rider.name === name && styles.chipTextActive]}>{name}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Reassign rider on next push</Text>
          <Switch value={reassignNext} onValueChange={setReassignNext} />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>Delivery steps</Text>
        {STEPS.map((step, i) => (
          <Pressable
            key={i}
            disabled={!activityId}
            onPress={() => push(step, 'update')}
            style={[styles.step, !activityId && styles.stepDisabled]}
          >
            <Text style={styles.stepText}>{i}. {step.status}</Text>
          </Pressable>
        ))}
        <Pressable
          disabled={!activityId}
          onPress={() => push(DELIVERED, 'end')}
          style={[styles.deliver, !activityId && styles.stepDisabled]}
        >
          <Text style={styles.deliverText}>Deliver (end activity)</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>APNs responses</Text>
        <Text style={styles.hint}>200 = APNs accepted the bytes — confirm the widget on the phone.</Text>
        {log.length === 0 && <Text style={styles.hint}>No pushes yet.</Text>}
        {log.map((r, i) => (
          <Text key={i} style={[styles.logLine, r.status === 200 ? styles.ok : styles.bad]}>
            {new Date(r.at).toLocaleTimeString()} — {r.status}{r.reason ? ` ${r.reason}` : ''}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}

function nextRider(current: string): string {
  return RIDERS[(RIDERS.indexOf(current) + 1) % RIDERS.length];
}

function Row({ label, value, good }: { label: string; value: string; good: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, good ? styles.ok : styles.muted]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { backgroundColor: '#0d0d0f' },
  content: { padding: 24, maxWidth: 560, width: '100%', alignSelf: 'center', gap: 16 },
  title: { color: '#fff', fontSize: 28, fontWeight: '700' },
  accent: { color: '#ff7a1a' },
  card: { backgroundColor: '#17171b', borderRadius: 14, padding: 16, gap: 10 },
  heading: { color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 4 },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  rowLabel: { color: '#9a9aa2' },
  rowValue: { fontWeight: '600' },
  ok: { color: '#39d353' },
  bad: { color: '#ff5c5c' },
  muted: { color: '#9a9aa2' },
  warn: { color: '#ffb84d' },
  mono: { fontFamily: 'monospace', color: '#fff' },
  riders: { flexDirection: 'row', gap: 8 },
  chip: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 999, backgroundColor: '#26262c' },
  chipActive: { backgroundColor: '#ff7a1a' },
  chipText: { color: '#cfcfd6', fontWeight: '600' },
  chipTextActive: { color: '#111' },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  toggleLabel: { color: '#cfcfd6' },
  step: { paddingVertical: 12, paddingHorizontal: 14, borderRadius: 10, backgroundColor: '#26262c' },
  stepDisabled: { opacity: 0.4 },
  stepText: { color: '#fff', fontWeight: '500' },
  deliver: { paddingVertical: 14, borderRadius: 10, backgroundColor: '#1f7a3d', alignItems: 'center', marginTop: 4 },
  deliverText: { color: '#fff', fontWeight: '700' },
  hint: { color: '#6f6f78', fontSize: 12 },
  logLine: { fontFamily: 'monospace', fontSize: 13 },
});
