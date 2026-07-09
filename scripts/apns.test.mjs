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
