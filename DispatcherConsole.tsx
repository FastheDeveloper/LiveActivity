import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { STEPS, DELIVERED, RIDERS, ORDER, toDeliveryState, type Rider } from './delivery';
import { connectDispatch, sendPush, type PushResult, type Platform } from './src/dispatchClient';

// The "delivered" option ends the activity; every other selection is an update.
const DELIVERED_KEY = 'delivered';

export default function DispatcherConsole() {
  const [online, setOnline] = useState(false);
  const [activityId, setActivityId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [courier, setCourier] = useState<string>(RIDERS[0]);
  const [reassign, setReassign] = useState(false);
  // Compose-then-send: pick a step (or "delivered"), then hit Send. Nothing
  // fires until the button is pressed. null = nothing staged yet.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [platform, setPlatform] = useState<Platform>('ios');
  const [log, setLog] = useState<PushResult[]>([]);
  const activityRef = useRef<string | null>(null);
  activityRef.current = activityId;
  // Read in the SSE callback (which is bound once) without reconnecting.
  const platformRef = useRef(platform);
  platformRef.current = platform;

  useEffect(() => {
    const disconnect = connectDispatch({
      onOpen: () => setOnline(true),
      onError: () => setOnline(false),
      onToken: (id, tok, tokPlatform) => {
        // Only adopt the token for the platform currently selected.
        if (tokPlatform !== platformRef.current) return;
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

  const isEnd = selectedKey === DELIVERED_KEY;
  const selectedStep =
    selectedKey == null ? null : isEnd ? DELIVERED : STEPS[Number(selectedKey)];
  const canSend = !!activityId && !!selectedStep && !sending;

  // The one action that actually pushes. Everything above it just stages state.
  const send = async () => {
    if (!activityId || !selectedStep) return;
    const rider: Rider = { name: courier, justReassigned: reassign };
    setSending(true);
    try {
      await sendPush(
        activityId,
        { ...toDeliveryState(selectedStep, rider), orderId: ORDER.orderId },
        isEnd ? 'end' : 'update',
        platform
      );
    } finally {
      setSending(false);
      setReassign(false); // a reassignment is a one-shot treatment
    }
  };

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Text style={styles.title}>DropTrack <Text style={styles.accent}>dispatcher</Text></Text>

      <View style={styles.card}>
        <Text style={styles.heading}>Platform</Text>
        <View style={styles.riders}>
          {(['ios', 'android'] as const).map((p) => (
            <Pressable
              key={p}
              onPress={() => { setPlatform(p); setActivityId(null); setToken(null); }}
              style={[styles.chip, platform === p && styles.chipActive]}
            >
              <Text style={[styles.chipText, platform === p && styles.chipTextActive]}>
                {p === 'ios' ? 'iOS' : 'Android'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

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
        <Text style={styles.heading}>1 · Courier</Text>
        <View style={styles.riders}>
          {RIDERS.map((name) => (
            <Pressable
              key={name}
              onPress={() => setCourier(name)}
              style={[styles.chip, courier === name && styles.chipActive]}
            >
              <Text style={[styles.chipText, courier === name && styles.chipTextActive]}>{name}</Text>
            </Pressable>
          ))}
        </View>
        <View style={styles.toggleRow}>
          <Text style={styles.toggleLabel}>Mark as rider reassignment</Text>
          <Switch value={reassign} onValueChange={setReassign} />
        </View>
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>2 · Update to send</Text>
        {STEPS.map((step, i) => {
          const key = String(i);
          const active = selectedKey === key;
          return (
            <Pressable
              key={key}
              onPress={() => setSelectedKey(key)}
              style={[styles.step, active && styles.stepSelected]}
            >
              <Text style={styles.stepText}>{i}. {step.status}</Text>
              {active && <Text style={styles.checkmark}>✓</Text>}
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => setSelectedKey(DELIVERED_KEY)}
          style={[styles.deliver, isEnd && styles.deliverSelected]}
        >
          <Text style={styles.deliverText}>Delivered 🎉 (ends activity){isEnd ? '  ✓' : ''}</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.heading}>3 · Send</Text>
        <Text style={styles.preview}>
          {selectedStep
            ? `“${selectedStep.status}” · ${courier}${reassign ? ' · reassignment' : ''}${isEnd ? ' · ends activity' : ''}`
            : 'Pick an update above.'}
        </Text>
        <Pressable
          disabled={!canSend}
          onPress={send}
          style={[styles.sendBtn, !canSend && styles.sendDisabled]}
        >
          <Text style={styles.sendText}>{sending ? 'Sending…' : 'Send notification'}</Text>
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
  step: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#26262c',
    borderWidth: 1,
    borderColor: 'transparent',
  },
  stepSelected: { backgroundColor: '#3a2a15', borderColor: '#ff7a1a' },
  stepText: { color: '#fff', fontWeight: '500' },
  checkmark: { color: '#ff7a1a', fontWeight: '700' },
  deliver: {
    paddingVertical: 14,
    borderRadius: 10,
    backgroundColor: '#1f7a3d',
    alignItems: 'center',
    marginTop: 4,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  deliverSelected: { borderColor: '#7dffa8' },
  deliverText: { color: '#fff', fontWeight: '700' },
  preview: { color: '#cfcfd6', fontSize: 15 },
  sendBtn: { paddingVertical: 15, borderRadius: 10, backgroundColor: '#ff7a1a', alignItems: 'center' },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: '#111', fontWeight: '800', fontSize: 16 },
  hint: { color: '#6f6f78', fontSize: 12 },
  logLine: { fontFamily: 'monospace', fontSize: 13 },
});
