#!/usr/bin/env node
// TSK-3: push a Live Activity update through APNs — no app involvement.
// Thin CLI over scripts/apns.mjs (which holds the signing + HTTP/2 core).
//
// Usage:
//   node scripts/push-update.mjs <push-token> [step 0-6 | delivered] [options]
//   node scripts/push-update.mjs 806f… 4                # replay step 4
//   node scripts/push-update.mjs 806f… delivered        # end the activity
//   node scripts/push-update.mjs 806f… 3 --courier Tunde --reassigned
//   node scripts/push-update.mjs 806f… --status "Custom" --progress 0.5 --stops 1 --eta-min 3
//
// Env overrides: APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_HOST.

import { config, pushLiveActivity, toAppleEpochSeconds } from './apns.mjs';

// Mirrors STEPS in delivery.ts so a scripted delivery can be replayed over push.
const STEPS = [
  { status: 'Order placed', progress: 0.05, stopsRemaining: 4, etaMinutes: 25 },
  { status: 'Courier assigned', progress: 0.15, stopsRemaining: 4, etaMinutes: 22 },
  { status: 'Picked up your order', progress: 0.35, stopsRemaining: 3, etaMinutes: 18 },
  { status: 'On the way', progress: 0.55, stopsRemaining: 2, etaMinutes: 12 },
  { status: '2 stops away', progress: 0.7, stopsRemaining: 2, etaMinutes: 8 },
  { status: 'Next stop: you', progress: 0.85, stopsRemaining: 1, etaMinutes: 4 },
  { status: 'Arriving now 🛵', progress: 0.95, stopsRemaining: 0, etaMinutes: 1 },
];
const DELIVERED = { status: 'Delivered 🎉', progress: 1, stopsRemaining: 0, etaMinutes: 0 };

const [token, ...rest] = process.argv.slice(2);
if (!token || token.startsWith('--')) {
  console.error('Usage: node scripts/push-update.mjs <push-token> [step 0-6 | delivered] [--status s] [--progress p] [--stops n] [--eta-min m] [--courier name] [--reassigned] [--end]');
  process.exit(1);
}

const flags = {};
let preset = null;
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === 'delivered') preset = DELIVERED;
  else if (/^\d+$/.test(a)) preset = STEPS[Number(a)] ?? DELIVERED;
  else if (a === '--reassigned') flags.reassigned = true;
  else if (a === '--end') flags.end = true;
  else if (a.startsWith('--')) flags[a.slice(2)] = rest[++i];
}
if (preset === DELIVERED) flags.end = true;

const base = preset ?? STEPS[3];
const etaMinutes = flags['eta-min'] != null ? Number(flags['eta-min']) : base.etaMinutes;

const contentState = {
  status: flags.status ?? base.status,
  progress: flags.progress != null ? Number(flags.progress) : base.progress,
  eta: toAppleEpochSeconds(new Date(Date.now() + etaMinutes * 60_000)),
  stopsRemaining: flags.stops != null ? Number(flags.stops) : base.stopsRemaining,
  courierName: flags.courier ?? 'Ade',
  riderReassigned: Boolean(flags.reassigned),
};

const event = flags.end ? 'end' : 'update';
console.log(`→ ${event} via ${config.host}`);
console.log(JSON.stringify(contentState, null, 2));

try {
  const { status, reason } = await pushLiveActivity({ token, contentState, event });
  if (status === 200) {
    console.log('✅ 200 — APNs accepted the push');
  } else {
    // 400 BadDeviceToken = sandbox/prod mismatch or stale token;
    // 403 InvalidProviderToken = wrong key/team/kid; 410 = activity gone.
    console.error(`❌ ${status} ${reason ?? ''}`);
    process.exitCode = 1;
  }
} catch (err) {
  console.error('HTTP/2 connection failed:', err.message);
  process.exit(1);
}
