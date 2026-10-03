import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { decryptProfile, encryptProfile } from '../src/profile-transfer.js';
import type { ProfileBinding } from '../src/profile-transfer.js';

test('encrypted profile authenticates owner and revision before exposing plaintext', () => {
  const binding: ProfileBinding = { userId: randomUUID(), connectionId: randomUUID(), profileId: randomUUID(), revision: 1,
    formatVersion: 1, scopeVersion: 1, cookieDomains: ['example.com'], storageOrigins: ['https://example.com'] };
  const key = randomBytes(32);
  const plaintext = Buffer.from('{"cookies":[{"value":"private-login"}]}');
  const encrypted = encryptProfile(plaintext, key, binding);
  assert.equal(encrypted.includes(plaintext), false);
  assert.deepEqual(decryptProfile(encrypted, key, binding), plaintext);
  assert.throws(() => decryptProfile(encrypted, key, { ...binding, userId: randomUUID() }), /PROFILE_AUTHENTICATION_FAILED/);
  assert.throws(() => decryptProfile(encrypted, key, { ...binding, revision: 2 }), /PROFILE_AUTHENTICATION_FAILED/);
  const tampered = Buffer.from(encrypted);
  tampered[20] = (tampered[20] ?? 0) ^ 1;
  assert.throws(() => decryptProfile(tampered, key, binding), /PROFILE_AUTHENTICATION_FAILED/);
  key.fill(0); plaintext.fill(0);
});
