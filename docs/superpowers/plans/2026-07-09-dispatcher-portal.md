# DropTrack Dispatcher Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Expo web dispatcher console that drives a physical iPhone's Live Activity over APNs, backed by a zero-dependency local Node signing server that scrapes push tokens off the device console.

**Architecture:** A local Node server (`127.0.0.1:8787`) holds the `.p8`, signs ES256 JWTs, talks HTTP/2 to APNs, and tails `devicectl --console` to auto-register per-activity push tokens. An Expo web screen streams tokens over SSE and POSTs push requests. The delivery script (`STEPS`, `toDeliveryState`) is extracted to a shared module so the browser console and the phone app run the identical script.

**Tech Stack:** Node core only for the server (`node:http`, `node:http2`, `node:crypto`, `node:child_process`, `node:test`); React Native Web via `react-dom` + `react-native-web` + `@expo/metro-runtime` for the browser UI; TypeScript throughout the app.

---

## File Structure

**Server side (plain JS, `.mjs`, zero deps):**
- Create `scripts/apns.mjs` — signing + HTTP/2 transport core, extracted from `push-update.mjs`. Exports `mintJWT`, `pushLiveActivity`, `toAppleEpochSeconds`, and config constants.
- Create `scripts/apns.test.mjs` — `node --test` unit + opt-in integration tests.
- Create `scripts/dispatch-server.mjs` — the local signing server (SSE + `/push` + device-console scraper).
- Modify `scripts/push-update.mjs` — reduce to a thin CLI over `apns.mjs`.

**App side (TypeScript):**
- Create `delivery.ts` (repo root, next to `App.tsx`) — shared delivery script.
- Create `DispatcherConsole.tsx` (repo root) — the web-only console UI.
- Create `src/dispatchClient.ts` — browser-side SSE + fetch client for the server.
- Modify `App.tsx` — import from `delivery.ts`; add a `Platform.OS === 'web'` branch.
- Modify `app.json` — add web bundler config if needed.
- Modify `package.json` — add web deps + npm scripts.

**Config:**
- The server reads `APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_HOST`, `DEVICE_ID`, `PORT` from the environment, with the same defaults `push-update.mjs` uses today.

---

## Task 1: Extract the APNs core into `scripts/apns.mjs`

**Files:**
- Create: `scripts/apns.mjs`
- Test: `scripts/apns.test.mjs`

- [ ] **Step 1: Write the failing test**

Create `scripts/apns.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mintJWT, toAppleEpochSeconds } from './apns.mjs';

// A throwaway P-256 key so the test needs no real .p8.
function writeTestKey() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const dir = mkdtempSync(join(tmpdir(), 'apns-test-'));
  const path = join(dir, 'AuthKey_TEST12345.p8');
  writeFileSync(path, pem);
  return path;
}

const b64urlToJSON = (s) =>
  JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

test('mintJWT produces an ES256 JWT with the right header and claims', () => {
  const keyPath = writeTestKey();
  const jwt = mintJWT({ keyPath, keyId: 'ABC123', teamId: 'TEAM99' });
  const [header, claims, sig] = jwt.split('.');

  assert.deepEqual(b64urlToJSON(header), { alg: 'ES256', kid: 'ABC123' });
  const decodedClaims = b64urlToJSON(claims);
  assert.equal(decodedClaims.iss, 'TEAM99');
  assert.equal(typeof decodedClaims.iat, 'number');

  // The DER-vs-P1363 bug, pinned: a raw r||s P-256 signature is exactly 64 bytes.
  // Node's default DER encoding would be ~70 and variable-length.
  assert.equal(Buffer.from(sig, 'base64url').length, 64);
});

test('toAppleEpochSeconds subtracts the 2001 reference offset', () => {
  // 2001-01-01T00:00:00Z is Apple epoch 0.
  assert.equal(toAppleEpochSeconds(new Date('2001-01-01T00:00:00Z')), 0);
  // One hour later is 3600.
  assert.equal(toAppleEpochSeconds(new Date('2001-01-01T01:00:00Z')), 3600);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/apns.test.mjs`
Expected: FAIL — `Cannot find module './apns.mjs'` (or import error).

- [ ] **Step 3: Write `scripts/apns.mjs`**

Create `scripts/apns.mjs`:

```js
// APNs signing + HTTP/2 transport core for Live Activity pushes.
// Zero dependencies (node:crypto + node:http2). Extracted from push-update.mjs
// so the CLI and the dispatch server share one implementation.
//
// GOTCHAS baked in here (see GOTCHAS.md "APNs / push-driven updates"):
//  - ES256 signatures MUST be raw r||s (ieee-p1363), not DER.
//  - apns-topic is <bundle>.push-type.liveactivity, not the bare bundle id.
//  - Swift Date decodes as seconds since 2001, not the Unix epoch.
//  - APNs is HTTP/2 only; fetch() cannot reach it.

import { readFileSync } from 'node:fs';
import { createPrivateKey, sign } from 'node:crypto';
import { connect } from 'node:http2';
import { homedir } from 'node:os';

export const config = {
  keyPath: process.env.APNS_KEY_PATH ?? `${homedir()}/Downloads/AuthKey_XLZP8ZR76B.p8`,
  keyId: process.env.APNS_KEY_ID ?? 'XLZP8ZR76B',
  teamId: process.env.APNS_TEAM_ID ?? 'V993Z3KD7P',
  bundleId: process.env.APNS_BUNDLE_ID ?? 'com.fasarticle.droptrack',
  host: process.env.APNS_HOST ?? 'https://api.sandbox.push.apple.com',
};

// Swift Date(timeIntervalSinceReferenceDate:) counts from 2001-01-01, not 1970.
export const APPLE_EPOCH_OFFSET = 978_307_200;
export function toAppleEpochSeconds(date) {
  return Math.floor(date.getTime() / 1000) - APPLE_EPOCH_OFFSET;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// ES256 JWT for APNs token auth: iss = team id, kid = key id, valid ~20-60min.
export function mintJWT({ keyPath = config.keyPath, keyId = config.keyId, teamId = config.teamId } = {}) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) }));
  const signingInput = `${header}.${claims}`;
  // ieee-p1363 emits the raw r||s signature JOSE wants; DER authenticates as
  // nothing and APNs rejects it with no useful error.
  const signature = sign('sha256', Buffer.from(signingInput), {
    key: createPrivateKey(readFileSync(keyPath, 'utf8')),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64url(signature)}`;
}

// Sends one Live Activity push. Resolves to { status, reason } and never throws
// on an APNs error status — only on a transport failure.
// `event` is 'update' | 'end'. `contentState` must match the widget ContentState.
export function pushLiveActivity({
  token,
  contentState,
  event = 'update',
  host = config.host,
  bundleId = config.bundleId,
  jwt = mintJWT(),
}) {
  const payload = {
    aps: {
      // Older-than-last timestamps are discarded by APNs (ordering guard).
      timestamp: Math.floor(Date.now() / 1000),
      event,
      'content-state': contentState,
    },
  };

  return new Promise((resolve, reject) => {
    const client = connect(host);
    client.on('error', reject);

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': `${bundleId}.push-type.liveactivity`,
      'apns-push-type': 'liveactivity',
      'apns-priority': '10',
      'apns-expiration': '0',
      'content-type': 'application/json',
    });

    let body = '';
    let status;
    req.on('response', (headers) => { status = headers[':status']; });
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      client.close();
      let reason = null;
      if (body) {
        try { reason = JSON.parse(body).reason ?? null; } catch { reason = body; }
      }
      resolve({ status, reason });
    });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/apns.test.mjs`
Expected: PASS — 2 tests passing.

- [ ] **Step 5: Commit**

```bash
git add scripts/apns.mjs scripts/apns.test.mjs
git commit -m "feat: extract APNs signing + transport core with unit tests"
```

---

## Task 2: Reduce `push-update.mjs` to a thin CLI over `apns.mjs`

**Files:**
- Modify: `scripts/push-update.mjs` (full rewrite of the signing/transport half; keep the CLI arg parsing + STEPS)

- [ ] **Step 1: Rewrite `scripts/push-update.mjs`**

Replace the entire file with:

```js
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
```

- [ ] **Step 2: Verify the CLI still authenticates (the TSK-3 auth probe)**

Run: `node scripts/push-update.mjs $(node -e "process.stdout.write('ab'.repeat(32))") 3`
Expected: prints the content-state, then `❌ 400 BadDeviceToken`. A `400 BadDeviceToken`
proves the JWT/key/team/kid are all correct (APNs looked the fake token up and rejected it).
If you see `403 InvalidProviderToken`, the key config is wrong — stop and fix before continuing.

- [ ] **Step 3: Commit**

```bash
git add scripts/push-update.mjs
git commit -m "refactor: push-update.mjs uses shared apns.mjs core"
```

---

## Task 3: Add the opt-in integration test

**Files:**
- Modify: `scripts/apns.test.mjs`

- [ ] **Step 1: Append the integration test**

Add to the end of `scripts/apns.test.mjs`:

```js
// Opt-in: needs network + the real .p8. Run with APNS_INTEGRATION=1.
// Proves key + key id + team id + JWT encoding are all correct WITHOUT a device:
// a syntactically valid but unregistered token must come back 400 BadDeviceToken.
test('sandbox rejects a fake token with BadDeviceToken (auth is correct)', { skip: process.env.APNS_INTEGRATION !== '1' }, async () => {
  const { pushLiveActivity } = await import('./apns.mjs');
  const fakeToken = 'ab'.repeat(32);
  const { status, reason } = await pushLiveActivity({
    token: fakeToken,
    contentState: { status: 'test', progress: 0, eta: 0, stopsRemaining: 0, courierName: 'x', riderReassigned: false },
    event: 'update',
  });
  assert.equal(status, 400);
  assert.equal(reason, 'BadDeviceToken'); // NOT InvalidProviderToken (403 = bad key)
});
```

- [ ] **Step 2: Run the default suite (integration skipped)**

Run: `node --test scripts/apns.test.mjs`
Expected: PASS — 2 run, 1 skipped.

- [ ] **Step 3: Run the integration test against the real key**

Run: `APNS_INTEGRATION=1 node --test scripts/apns.test.mjs`
Expected: PASS — 3 passing. (Requires the `.p8` at `APNS_KEY_PATH` and network.)

- [ ] **Step 4: Commit**

```bash
git add scripts/apns.test.mjs
git commit -m "test: opt-in APNs auth probe against the sandbox"
```

---

## Task 4: Build the dispatch server — HTTP shell + SSE

**Files:**
- Create: `scripts/dispatch-server.mjs`

This task stands up the server with an in-memory registry and SSE, but a **stubbed** token
source (a `POST /debug/token` route) so it is testable before wiring the device console.
Task 5 replaces the stub with the real `devicectl` scraper.

- [ ] **Step 1: Write `scripts/dispatch-server.mjs`**

Create `scripts/dispatch-server.mjs`:

```js
#!/usr/bin/env node
// Local signing server for the dispatcher portal. Binds 127.0.0.1 only.
// Holds the .p8, signs + sends pushes, and streams per-activity push tokens
// (scraped from the device console in Task 5) to the browser over SSE.
//
// The .p8 NEVER leaves this process — no route returns key material.

import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { config, pushLiveActivity } from './apns.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:8081';

// Fail at boot, not at first push, if the signing key is missing.
if (!existsSync(config.keyPath)) {
  console.error(`[dispatch] APNs key not found at ${config.keyPath}`);
  console.error('[dispatch] set APNS_KEY_PATH or place the .p8 there. Refusing to start.');
  process.exit(1);
}

// activityId -> { token, seenAt }
const registry = new Map();
// Set of open SSE responses.
const clients = new Set();

function broadcast(type, data) {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}

// Called by the token source (stub now, devicectl scraper in Task 5).
export function registerToken(activityId, token) {
  const existing = registry.get(activityId);
  if (existing && existing.token === token) return; // no change
  registry.set(activityId, { token, seenAt: Date.now() });
  broadcast('token', { activityId, token });
  console.log(`[dispatch] token registered for ${activityId}: ${token.slice(0, 8)}…`);
}

function dropActivity(activityId) {
  if (registry.delete(activityId)) {
    broadcast('activity-gone', { activityId });
    console.log(`[dispatch] activity ${activityId} dropped (410 Unregistered)`);
  }
}

const cors = {
  'Access-Control-Allow-Origin': WEB_ORIGIN,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

const server = createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }

  // SSE stream: replay the registry, then live updates.
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      ...cors,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');
    clients.add(res);
    for (const [activityId, { token }] of registry) {
      res.write(`event: token\ndata: ${JSON.stringify({ activityId, token })}\n\n`);
    }
    req.on('close', () => clients.delete(res));
    return;
  }

  // Push a Live Activity update.
  if (req.method === 'POST' && req.url === '/push') {
    const { activityId, state, event } = JSON.parse(await readBody(req));
    const entry = registry.get(activityId);
    if (!entry) {
      res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unknown activityId' }));
    }
    try {
      const result = await pushLiveActivity({ token: entry.token, contentState: state, event });
      if (result.status === 410) dropActivity(activityId);
      broadcast('push-result', { activityId, ...result, at: Date.now() });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(502, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Test-only token injection (removed once Task 5's scraper lands? No — keep
  // behind NODE_ENV so tests can drive the registry without a device).
  if (req.method === 'POST' && req.url === '/debug/token' && process.env.DISPATCH_ALLOW_DEBUG === '1') {
    const { activityId, token } = JSON.parse(await readBody(req));
    registerToken(activityId, token);
    res.writeHead(204, cors);
    return res.end();
  }

  res.writeHead(404, cors);
  res.end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dispatch] listening on http://127.0.0.1:${PORT}`);
  console.log(`[dispatch] APNs host: ${config.host}`);
});
```

- [ ] **Step 2: Manually verify SSE + push flow with the debug route**

In terminal A:
`DISPATCH_ALLOW_DEBUG=1 node scripts/dispatch-server.mjs`
Expected: `[dispatch] listening on http://127.0.0.1:8787`.

In terminal B (SSE stream):
`curl -N http://127.0.0.1:8787/events`
Leave it open.

In terminal C (inject a fake token, then push):
```bash
curl -s -X POST http://127.0.0.1:8787/debug/token -d '{"activityId":"TEST-1","token":"abababababababababababababababababababababababababababababababab"}'
curl -s -X POST http://127.0.0.1:8787/push -H 'Content-Type: application/json' \
  -d '{"activityId":"TEST-1","event":"update","state":{"status":"On the way","progress":0.5,"eta":0,"stopsRemaining":2,"courierName":"Ade","riderReassigned":false}}'
```
Expected in terminal B: a `token` event for `TEST-1`, then a `push-result` event with
`"status":400,"reason":"BadDeviceToken"` (fake token, real auth). Terminal C's push call
prints `{"status":400,"reason":"BadDeviceToken"}`.

Stop the server (Ctrl-C in A).

- [ ] **Step 3: Commit**

```bash
git add scripts/dispatch-server.mjs
git commit -m "feat: dispatch server with SSE registry and /push (stub token source)"
```

---

## Task 5: Wire the device-console token scraper

**Files:**
- Modify: `scripts/dispatch-server.mjs`

- [ ] **Step 1: Add device resolution + console scraping**

In `scripts/dispatch-server.mjs`, add after the imports:

```js
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

Add this function above `const server = createServer(`. The JSON shape below is verified
against `xcrun devicectl list devices --json-output` (July 2026): each device has
`identifier`, `connectionProperties.tunnelState` (`"connected"` when reachable),
`hardwareProperties.marketingName` (e.g. `"iPhone 14 Pro"`), and `deviceProperties.name`.
devicectl only reliably writes JSON to a real file on disk, so we use a temp file, not
`/dev/stdout`.

```js
// Resolve the target device: DEVICE_ID env, else the single connected iPhone.
function resolveDeviceId() {
  if (process.env.DEVICE_ID) return process.env.DEVICE_ID;
  const out = join(tmpdir(), `dispatch-devices-${process.pid}.json`);
  try {
    execFileSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', out], { stdio: 'ignore' });
    const json = JSON.parse(readFileSync(out, 'utf8'));
    const devices = (json.result?.devices ?? []).filter(
      (d) =>
        d.connectionProperties?.tunnelState === 'connected' &&
        /iPhone/.test(d.hardwareProperties?.marketingName ?? d.deviceProperties?.name ?? '')
    );
    if (devices.length !== 1) {
      throw new Error(`expected exactly one connected iPhone, found ${devices.length}. Set DEVICE_ID.`);
    }
    return devices[0].identifier;
  } finally {
    rmSync(out, { force: true });
  }
}

// Spawn `devicectl … --console`, tail stdout for the NSLog token line, register each.
function startConsoleScraper() {
  const deviceId = resolveDeviceId();
  const bundleId = config.bundleId;
  console.log(`[dispatch] attaching console to ${deviceId} (${bundleId}) — this cold-starts the app; running activities survive and re-attach`);

  const child = spawn('xcrun', [
    'devicectl', 'device', 'process', 'launch',
    '--console', '--terminate-existing',
    '--device', deviceId, bundleId,
  ]);

  // Matches: [DropTrack] push token for <uuid>: <hex>
  const re = /\[DropTrack\] push token for ([0-9A-Fa-f-]+): ([0-9a-f]+)/;
  const onLine = (line) => {
    const m = line.match(re);
    if (m) registerToken(m[1], m[2]);
  };
  let buf = '';
  const feed = (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      onLine(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('exit', (code) => {
    console.error(`[dispatch] device console exited (code ${code}) — token intake stopped. Restart the server to reattach.`);
  });
  return child;
}
```

- [ ] **Step 2: Call the scraper on boot unless in debug mode**

Change the `server.listen(...)` callback body to:

```js
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[dispatch] listening on http://127.0.0.1:${PORT}`);
  console.log(`[dispatch] APNs host: ${config.host}`);
  if (process.env.DISPATCH_ALLOW_DEBUG === '1') {
    console.log('[dispatch] debug mode: /debug/token enabled, device console NOT attached');
    return;
  }
  try {
    startConsoleScraper();
  } catch (err) {
    console.error(`[dispatch] could not attach device console: ${err.message}`);
    console.error('[dispatch] server is up; tokens will not auto-register until a device is attached.');
  }
});
```

- [ ] **Step 3: Verify against the real device**

Precondition: iPhone connected, `xcrun devicectl list devices` shows exactly one connected iPhone.

Run: `node scripts/dispatch-server.mjs`
Then, on the phone, open DropTrack and tap **Start**.
Expected server log within a few seconds: `[dispatch] token registered for <uuid>: <8hex>…`.

Leave running for Task 7's end-to-end check, or Ctrl-C.

- [ ] **Step 4: Commit**

```bash
git add scripts/dispatch-server.mjs
git commit -m "feat: scrape per-activity push tokens from devicectl console"
```

---

## Task 6: Extract the shared delivery script

**Files:**
- Create: `delivery.ts`
- Modify: `App.tsx:20-53` (remove the definitions, import them instead)

- [ ] **Step 1: Create `delivery.ts`**

Create `delivery.ts` at the repo root:

```ts
import type { DeliveryState } from './modules/droptrack-live';

// The scripted delivery. Each step is a full snapshot of the dynamic state —
// exactly what a real backend would push, minus the courier's actual GPS.
// Shared by the phone dev console (App.tsx) and the web dispatcher console.
export type Step = {
  status: string;
  progress: number;
  stopsRemaining: number;
  etaMinutes: number;
};

export const STEPS: Step[] = [
  { status: 'Order placed', progress: 0.05, stopsRemaining: 4, etaMinutes: 25 },
  { status: 'Courier assigned', progress: 0.15, stopsRemaining: 4, etaMinutes: 22 },
  { status: 'Picked up your order', progress: 0.35, stopsRemaining: 3, etaMinutes: 18 },
  { status: 'On the way', progress: 0.55, stopsRemaining: 2, etaMinutes: 12 },
  { status: '2 stops away', progress: 0.7, stopsRemaining: 2, etaMinutes: 8 },
  { status: 'Next stop: you', progress: 0.85, stopsRemaining: 1, etaMinutes: 4 },
  { status: 'Arriving now 🛵', progress: 0.95, stopsRemaining: 0, etaMinutes: 1 },
];

export const DELIVERED: Step = {
  status: 'Delivered 🎉',
  progress: 1,
  stopsRemaining: 0,
  etaMinutes: 0,
};

export const ORDER = { orderId: 'DT-4521' };
export const RIDERS = ['Ade', 'Tunde', 'Chioma'];

export type Rider = { name: string; justReassigned: boolean };

export function toDeliveryState(step: Step, rider: Rider): DeliveryState {
  return {
    status: step.status,
    progress: step.progress,
    stopsRemaining: step.stopsRemaining,
    etaEpochMillis: Date.now() + step.etaMinutes * 60_000,
    courierName: rider.name,
    riderReassigned: rider.justReassigned,
  };
}
```

- [ ] **Step 2: Update `App.tsx` to import from `delivery.ts`**

In `App.tsx`, delete the `STEPS`, `DELIVERED`, `ORDER`, `RIDERS`, `Rider`, and
`toDeliveryState` definitions (currently lines ~20-53), and add to the import block near the
top (after the `DroptrackLive` import):

```ts
import { STEPS, DELIVERED, ORDER, RIDERS, toDeliveryState, type Rider } from './delivery';
```

Keep `const AUTO_STEP_MS = 5000;` and the `LogBox.ignoreLogs([...])` call in `App.tsx` — they
are app-only, not shared.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add delivery.ts App.tsx
git commit -m "refactor: extract shared delivery script to delivery.ts"
```

---

## Task 7: Add Expo web dependencies and the dispatch client

**Files:**
- Modify: `package.json` (deps + scripts, via expo install)
- Create: `src/dispatchClient.ts`

- [ ] **Step 1: Install web dependencies**

Run: `npx expo install react-dom react-native-web @expo/metro-runtime`
Expected: three packages added to `package.json` dependencies.

- [ ] **Step 2: Add npm scripts**

In `package.json`, add to `"scripts"`:

```json
"dispatch": "node scripts/dispatch-server.mjs",
"web": "expo start --web"
```

(`web` may already exist from the scaffold — leave it if so.)

- [ ] **Step 3: Create `src/dispatchClient.ts`**

```ts
// Browser-side client for the dispatch server (scripts/dispatch-server.mjs).
// SSE for token/result events, fetch for pushes. Web-only.
import type { DeliveryState } from '../modules/droptrack-live';

const BASE = 'http://127.0.0.1:8787';

export type PushResult = { activityId: string; status: number; reason: string | null; at: number };

export type DispatchEvents = {
  onToken: (activityId: string, token: string) => void;
  onActivityGone: (activityId: string) => void;
  onPushResult: (result: PushResult) => void;
  onError: () => void;
  onOpen: () => void;
};

export function connectDispatch(handlers: DispatchEvents): () => void {
  const es = new EventSource(`${BASE}/events`);
  es.addEventListener('open', () => handlers.onOpen());
  es.addEventListener('token', (e) => {
    const { activityId, token } = JSON.parse((e as MessageEvent).data);
    handlers.onToken(activityId, token);
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
  state: DeliveryState,
  event: 'update' | 'end'
): Promise<{ status: number; reason: string | null }> {
  const res = await fetch(`${BASE}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ activityId, state, event }),
  });
  return res.json();
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (If `EventSource`/`fetch` are unknown, ensure `tsconfig.json`'s `lib`
includes `"DOM"`; the Expo base config includes it. If not, add `"dom"` to `compilerOptions.lib`.)

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/dispatchClient.ts
git commit -m "feat: add expo web deps and dispatch SSE/fetch client"
```

---

## Task 8: Build the DispatcherConsole UI

**Files:**
- Create: `DispatcherConsole.tsx`

- [ ] **Step 1: Create `DispatcherConsole.tsx`**

```tsx
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
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add DispatcherConsole.tsx
git commit -m "feat: dispatcher console UI (web)"
```

---

## Task 9: Branch App.tsx to render the console on web

**Files:**
- Modify: `App.tsx` (add web branch at the top of the component)

- [ ] **Step 1: Add the web branch**

In `App.tsx`, add the import near the other local imports:

```ts
import DispatcherConsole from './DispatcherConsole';
```

Then, as the very first line inside `export default function App() {`, before any hooks:

```ts
  if (Platform.OS === 'web') return <DispatcherConsole />;
```

Note: React's rules of hooks require this early return to precede every `useState`/`useEffect`
in `App`. Placing it as the first statement is correct because on web the component always
takes this branch (the condition is constant per platform), so hook order never changes
between renders.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Start web and verify the console renders**

Run (server): `npm run dispatch` (with the phone connected, then tap Start on the phone)
Run (web): `npm run web` then open the printed localhost URL.
Expected: the dispatcher console renders; "Dispatch server" shows **online**; once you tap
Start on the phone, "Activity" and "Push token" populate.

- [ ] **Step 4: Commit**

```bash
git add App.tsx
git commit -m "feat: render dispatcher console on web"
```

---

## Task 10: End-to-end verification against the device

**Files:** none (verification only)

- [ ] **Step 1: Full path**

1. `npm run dispatch` — server up, phone connected.
2. On the phone: open DropTrack, tap **Start**. Server logs a registered token; the web
   console's Activity + Push token populate.
3. In the browser: click step **4 (“2 stops away”)**. APNs responses shows `200`.
4. **Look at the phone's lock screen / Dynamic Island** — confirm it now reads “2 stops away”.
5. Toggle **Reassign rider on next push**, click step **5**. Confirm the phone shows the new
   courier with the reassignment treatment.
6. Click **Deliver (end activity)**. Confirm the phone shows “Delivered 🎉”.

- [ ] **Step 2: Failure-mode spot checks**

- Stop the dispatch server → the web console flips to **offline** and disables the steps.
- With the activity ended, click a step → APNs returns `410`; the console drops the activity
  and greys the stepper.

- [ ] **Step 3: Update docs**

Append a short section to `DEVLOG.md` describing the portal (what it is, the browser→server→APNs
path, the SSE token intake), and add one line to `GOTCHAS.md` if anything new surfaced during
the build. Do not add the portal to the GT evidence tracker — it is test tooling.

```bash
git add DEVLOG.md GOTCHAS.md
git commit -m "docs: dispatcher portal devlog entry"
```

---

## Notes for the implementer

- **The `.p8` is never sent to the browser.** Only push tokens (per-activity capabilities)
  cross to the client. Keep it that way — no route may return key material.
- **A 200 from APNs is not proof the widget updated.** A `content-state` that mis-decodes is
  dropped silently by iOS. Every end-to-end check must include looking at the phone.
- **Bind 127.0.0.1 only.** Never `0.0.0.0`.
- The server cold-starts the app when it attaches the console; running activities survive and
  the app re-attaches via `getRunningActivities()`. Expect a brief token gap on attach.
- Run the server with `DISPATCH_ALLOW_DEBUG=1` for UI work without a device.
