// FCM HTTP v1 client for Android Live Update pushes. Zero dependencies
// (node:crypto + global fetch). The Android counterpart to apns.mjs.
//
// Auth: a service-account RS256 JWT, exchanged for a short-lived OAuth access
// token, used as a bearer against the v1 send endpoint. Unlike APNs (HTTP/2 +
// .p8 ES256), FCM v1 is plain HTTPS + an RS256 service-account key.

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

export const config = {
  serviceAccountPath: process.env.FCM_SERVICE_ACCOUNT ?? 'fcm-service-account.json',
};

function loadServiceAccount(path = config.serviceAccountPath) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

// RS256 JWT asserting the service account, scoped to FCM send.
export function buildAuthJWT(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: sa.token_uri,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const sig = createSign('RSA-SHA256').update(signingInput).sign(sa.private_key);
  return `${signingInput}.${b64url(sig)}`;
}

let cachedToken = null; // { token, exp }

// Exchange the JWT for an OAuth access token (cached until ~1 min before expiry).
export async function getAccessToken(sa = loadServiceAccount()) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;
  const jwt = buildAuthJWT(sa);
  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`OAuth token exchange failed: ${res.status} ${JSON.stringify(body)}`);
  cachedToken = { token: body.access_token, exp: now + (body.expires_in ?? 3600) };
  return cachedToken.token;
}

// Send one high-priority, data-only message. Resolves { status, reason }.
// reason is the FCM error `status` (e.g. UNREGISTERED, INVALID_ARGUMENT) or null.
export async function sendDataMessage({ token, data, sa = loadServiceAccount() }) {
  const accessToken = await getAccessToken(sa);
  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: { token, data, android: { priority: 'high' } },
      }),
    }
  );
  const body = await res.json().catch(() => ({}));
  const reason = body?.error?.status ?? null;
  return { status: res.status, reason };
}
