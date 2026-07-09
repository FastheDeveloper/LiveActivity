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
