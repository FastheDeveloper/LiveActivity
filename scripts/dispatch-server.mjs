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

function parseJson(body) {
  try { return [JSON.parse(body), null]; }
  catch { return [null, 'invalid JSON body']; }
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

  // Test-only token injection so tests/UI work can drive the registry without a
  // device. Gated behind DISPATCH_ALLOW_DEBUG=1.
  if (req.method === 'POST' && req.url === '/debug/token' && process.env.DISPATCH_ALLOW_DEBUG === '1') {
    const [payload, parseErr] = parseJson(await readBody(req));
    if (parseErr) {
      res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: parseErr }));
    }
    const { activityId, token } = payload;
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
