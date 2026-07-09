#!/usr/bin/env node
// Local signing server for the dispatcher portal. Binds 127.0.0.1 only.
// Holds the .p8, signs + sends pushes, and streams per-activity push tokens
// (scraped from the device console in Task 5) to the browser over SSE.
//
// The .p8 NEVER leaves this process — no route returns key material.

import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config, pushLiveActivity, toAppleEpochSeconds } from './apns.mjs';
import { sendDataMessage } from './fcm.mjs';

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

// Called by the token sources: the iOS devicectl scrape and the Android adb
// logcat scrape. platform is 'ios' | 'android'.
export function registerToken(activityId, token, platform) {
  const existing = registry.get(activityId);
  if (existing && existing.token === token) return; // no change
  registry.set(activityId, { token, platform, seenAt: Date.now() });
  broadcast('token', { activityId, token, platform });
  console.log(`[dispatch] ${platform} token registered for ${activityId}: ${token.slice(0, 8)}…`);
}

function dropActivity(activityId) {
  if (registry.delete(activityId)) {
    broadcast('activity-gone', { activityId });
    console.log(`[dispatch] activity ${activityId} dropped (410 Unregistered)`);
  }
}

// CORS, computed per request. The server binds loopback only, so any browser
// origin reaching it is already local — reflect any localhost/127.0.0.1 origin
// (Expo web may serve from either host, on any port) so the console doesn't
// silently show "offline" over a host mismatch. Anything else falls back to
// the explicit WEB_ORIGIN. A single Access-Control-Allow-Origin can hold only
// one value, hence the reflect-or-fallback.
function corsFor(req) {
  const origin = req.headers.origin;
  const allow = origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    ? origin
    : WEB_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => resolve(b));
  });
}

function parseJson(body) {
  try { return [JSON.parse(body), null]; }
  catch { return [null, 'invalid JSON body']; }
}

// The shared toDeliveryState() (delivery.ts) produces the NATIVE BRIDGE shape:
// etaEpochMillis in Unix milliseconds, which the Swift module converts. But an
// APNs content-state is decoded directly by the widget's Codable ContentState,
// which expects `eta` as seconds-since-2001 (Apple epoch) and has NO
// etaEpochMillis field. Translate at this boundary — a mismatch here is the
// classic silent failure: APNs returns 200 and iOS drops the update with no
// error anywhere.
function toContentState({ etaEpochMillis, ...rest }) {
  return { ...rest, eta: toAppleEpochSeconds(new Date(etaEpochMillis)) };
}

// Resolve the target device: DEVICE_ID env, else the single connected iPhone.
// devicectl only reliably writes JSON to a real file, so use a temp file.
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
    if (m) registerToken(m[1], m[2], 'ios');
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

// Scrape the FCM registration token from `adb logcat`. The Android app logs
// `[DropTrack] fcm token: <token>` (module getFcmToken + service onNewToken) —
// the adb analog of the iOS devicectl --console scrape.
function startLogcatScraper() {
  console.log('[dispatch] attaching adb logcat for FCM tokens (Android)');
  const child = spawn('adb', ['logcat', '-s', 'DroptrackLive:I']);
  const re = /\[DropTrack\] fcm token: ([A-Za-z0-9:_\-]+)/;
  let buf = '';
  const feed = (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = buf.slice(0, i).match(re);
      // FCM tokens have no per-activity id; key the registry by a synthetic id.
      if (m) registerToken(`android-${m[1].slice(0, 8)}`, m[1], 'android');
      buf = buf.slice(i + 1);
    }
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  child.on('exit', (code) => console.error(`[dispatch] adb logcat exited (code ${code})`));
  return child;
}

const server = createServer(async (req, res) => {
  const cors = corsFor(req);
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
    for (const [activityId, { token, platform }] of registry) {
      res.write(`event: token\ndata: ${JSON.stringify({ activityId, token, platform })}\n\n`);
    }
    req.on('close', () => clients.delete(res));
    return;
  }

  // Push a Live Activity update.
  if (req.method === 'POST' && req.url === '/push') {
    const [payload, parseErr] = parseJson(await readBody(req));
    if (parseErr) {
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: parseErr }));
    }
    const { activityId, state, event } = payload;
    const entry = registry.get(activityId);
    if (!entry) {
      res.writeHead(404, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'unknown activityId' }));
    }
    const platform = payload.platform ?? entry.platform ?? 'ios';
    try {
      let result;
      if (platform === 'android') {
        // FCM data values must be strings. activityId in the payload is the
        // delivery id the service re-posts under (delivery-<orderId>).
        const data = {
          activityId: `delivery-${state.orderId ?? 'DT-4521'}`,
          orderId: String(state.orderId ?? 'DT-4521'),
          status: String(state.status),
          progress: String(state.progress),
          etaEpochMillis: String(state.etaEpochMillis),
          stopsRemaining: String(state.stopsRemaining),
          courierName: String(state.courierName),
          riderReassigned: String(!!state.riderReassigned),
          event: event ?? 'update',
        };
        result = await sendDataMessage({ token: entry.token, data });
        if (result.status === 404) dropActivity(activityId); // UNREGISTERED
      } else {
        result = await pushLiveActivity({ token: entry.token, contentState: toContentState(state), event });
        if (result.status === 410) dropActivity(activityId);
      }
      broadcast('push-result', { activityId, platform, ...result, at: Date.now() });
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(502, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: err.message }));
    }
  }

  // Test-only token injection so tests/UI work can drive the registry without a
  // device. Gated behind DISPATCH_ALLOW_DEBUG=1.
  if (req.method === 'POST' && req.url === '/debug/token' && process.env.DISPATCH_ALLOW_DEBUG === '1') {
    const [payload, parseErr] = parseJson(await readBody(req));
    if (parseErr) {
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: parseErr }));
    }
    const { activityId, token, platform } = payload;
    registerToken(activityId, token, platform ?? 'ios');
    res.writeHead(204, cors);
    return res.end();
  }

  res.writeHead(404, cors);
  res.end();
});

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
    console.error('[dispatch] server is up; iOS tokens will not auto-register until an iPhone is attached.');
  }
  // Android: attach the logcat scraper only when an adb device is present.
  try {
    const out = execFileSync('adb', ['devices'], { encoding: 'utf8' });
    if (out.split('\n').some((l) => /\tdevice$/.test(l))) startLogcatScraper();
    else console.log('[dispatch] no adb device — Android FCM token intake skipped');
  } catch {
    console.log('[dispatch] adb not found — Android FCM token intake skipped');
  }
});
