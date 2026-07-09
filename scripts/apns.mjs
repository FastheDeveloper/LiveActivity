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
    // client.close() is idempotent, so closing on error is safe even if the
    // session is already tearing down. Failing to close leaks a connection —
    // this module is the shared core for a long-lived dispatch server.
    client.on('error', (err) => { client.close(); reject(err); });

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': `${bundleId}.push-type.liveactivity`,
      'apns-push-type': 'liveactivity',
      'apns-priority': '10', // deliver immediately (5 = opportunistic)
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
    req.on('error', (err) => { client.close(); reject(err); });
    req.end(JSON.stringify(payload));
  });
}
