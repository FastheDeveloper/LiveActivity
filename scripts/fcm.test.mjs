import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';

import { buildAuthJWT } from './fcm.mjs';

// A throwaway RSA key standing in for the service-account private key.
function fakeServiceAccount() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pk = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return {
    sa: {
      client_email: 'sa@droptrack.iam.gserviceaccount.com',
      private_key: pk,
      token_uri: 'https://oauth2.googleapis.com/token',
      project_id: 'droptrack-test',
    },
    publicKey,
  };
}

const b64urlToJSON = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

test('buildAuthJWT makes a valid RS256 service-account JWT', () => {
  const { sa, publicKey } = fakeServiceAccount();
  const jwt = buildAuthJWT(sa);
  const [header, claims, sig] = jwt.split('.');

  assert.deepEqual(b64urlToJSON(header), { alg: 'RS256', typ: 'JWT' });
  const c = b64urlToJSON(claims);
  assert.equal(c.iss, 'sa@droptrack.iam.gserviceaccount.com');
  assert.equal(c.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(c.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(typeof c.iat, 'number');
  assert.equal(c.exp, c.iat + 3600);

  const v = createVerify('RSA-SHA256');
  v.update(`${header}.${claims}`);
  v.end();
  assert.ok(v.verify(publicKey, Buffer.from(sig, 'base64url')), 'signature verifies');
});

// Opt-in: needs network + the real service account. Run with FCM_INTEGRATION=1.
// Proves the service account + OAuth exchange + project id are correct WITHOUT a
// device: the request must get PAST auth and be rejected at the messaging layer
// for the bad token, not at the credential layer.
//
// NOTE — FCM differs from APNs here. APNs returns 400 BadDeviceToken for any bad
// token. FCM distinguishes a MALFORMED token (400 INVALID_ARGUMENT) from a
// well-formed-but-unregistered one (404 UNREGISTERED). A fabricated token isn't
// structurally valid, so FCM rejects it as INVALID_ARGUMENT before the
// registration check. Both codes mean "auth OK, token rejected"; a bad service
// account would instead give 401/403.
test('FCM auth succeeds; a bad token is rejected at the messaging layer, not auth', { skip: process.env.FCM_INTEGRATION !== '1' }, async () => {
  const { getAccessToken, sendDataMessage } = await import('./fcm.mjs');

  // OAuth exchange must succeed (throws otherwise) — this is the auth proof.
  const accessToken = await getAccessToken();
  assert.ok(accessToken && accessToken.length > 0, 'OAuth access token obtained');

  const { status, reason } = await sendDataMessage({
    token: 'fake-token-' + 'a'.repeat(120),
    data: { status: 'test', progress: '0', event: 'update' },
  });
  // Rejected for the token (400/404), NOT for credentials (401/403).
  assert.ok([400, 404].includes(status), `expected 400/404, got ${status}`);
  assert.ok(['INVALID_ARGUMENT', 'UNREGISTERED'].includes(reason), `expected token rejection, got ${reason}`);
});
