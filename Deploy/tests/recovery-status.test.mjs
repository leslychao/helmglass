import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { parseRecoveryStatus } from '../recovery-evidence.mjs';

test('Lost-response reconciliation accepts only the matching durable recovery owner receipt', () => {
  const state = { recoveryId: randomUUID(), proofSha256: 'a'.repeat(64) };
  const receipt = { recoveryId: state.recoveryId, proofHash: state.proofSha256,
    state: 'READY', admissionState: 'READY', finishedAt: '2026-10-03T01:00:00Z' };
  const line = (value, logger = 'com.helmglass.bootstrap.RecoveryApplication') => JSON.stringify({
    log: { logger }, message: 'HELM_RECOVERY_STATUS ' + JSON.stringify(value) });
  assert.deepEqual(parseRecoveryStatus('other diagnostic\n' + line(receipt), state), receipt);
  assert.throws(() => parseRecoveryStatus(line({ ...receipt, recoveryId: randomUUID() }), state));
  assert.throws(() => parseRecoveryStatus(line({ ...receipt, proofHash: 'b'.repeat(64) }), state));
  assert.throws(() => parseRecoveryStatus(line(receipt, 'other.component'), state));
  assert.throws(() => parseRecoveryStatus(line(receipt) + '\n' + line(receipt), state));
  assert.throws(() => parseRecoveryStatus('Helm recovery completed; admission is ready', state));
  assert.equal(parseRecoveryStatus(line({ ...receipt, state: 'PURGING', admissionState: 'RECOVERING', finishedAt: null }), state).state, 'PURGING');
});
