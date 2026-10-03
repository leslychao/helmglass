import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { readOperatorInputs } from '../operator-inputs.mjs';
import { secretInput } from '../custody.mjs';
import { isInside } from '../protected-files.mjs';

const passwords = {
  KEYCLOAK_ADMIN_PASSWORD: 'fixture-admin-private-value',
  KEYCLOAK_ANGELINA_PASSWORD: 'fixture-angelina-private-value',
  VAULT_CUSTODY_PASSWORD: 'fixture-custody-private-value',
};

async function fixture(context, content = JSON.stringify(passwords)) {
  const directory = await mkdtemp(join(tmpdir(), 'helm-operator-inputs-'));
  context.after(async () => {
    const canonical = await realpath(directory);
    assert.equal(canonical.toLowerCase(), resolve(directory).toLowerCase());
    assert.ok(isInside(tmpdir(), canonical) && directory.includes('helm-operator-inputs-'));
    await rm(canonical, { recursive: true });
  });
  const path = join(directory, 'operator-inputs.json');
  await writeFile(path, content, { mode: 0o600 });
  return { OPERATOR_INPUT_FILE: path, LOCAL_SECRETS_DIR: join(directory, 'bootstrap') };
}

test('file inputs are scoped, preserve exact strings and do not mutate the child environment', async context => {
  const configuration = await fixture(context);
  const environment = { UNRELATED: 'retained-only-in-original-environment' };
  const inputs = await readOperatorInputs(configuration, environment);
  assert.deepEqual(inputs, passwords);
  assert.ok(Object.isFrozen(inputs));
  assert.deepEqual(environment, { UNRELATED: 'retained-only-in-original-environment' });
  assert.equal(await secretInput('VAULT_CUSTODY_PASSWORD', 'Unused prompt', inputs), passwords.VAULT_CUSTODY_PASSWORD);
});

test('explicit environment values take precedence over the file without falling back on invalid values', async context => {
  const configuration = await fixture(context);
  const override = '  explicit-env-password-with-spaces  ';
  const inputs = await readOperatorInputs(configuration, { KEYCLOAK_ADMIN_PASSWORD: override });
  assert.equal(inputs.KEYCLOAK_ADMIN_PASSWORD, override);
  assert.equal(inputs.KEYCLOAK_ANGELINA_PASSWORD, passwords.KEYCLOAK_ANGELINA_PASSWORD);
  for (const value of ['', 123, null]) {
    await assert.rejects(readOperatorInputs(configuration, { KEYCLOAK_ADMIN_PASSWORD: value }),
      { parameter: 'KEYCLOAK_ADMIN_PASSWORD' });
  }
});

test('no file preserves environment inputs and leaves missing custody available for the legacy TTY path', async () => {
  const inputs = await readOperatorInputs({}, { KEYCLOAK_ADMIN_PASSWORD: passwords.KEYCLOAK_ADMIN_PASSWORD });
  assert.deepEqual(inputs, { KEYCLOAK_ADMIN_PASSWORD: passwords.KEYCLOAK_ADMIN_PASSWORD });
  assert.equal(inputs.VAULT_CUSTODY_PASSWORD, undefined);
  assert.deepEqual(await readOperatorInputs({ OPERATOR_INPUT_FILE: '' }, {}), {});
});

test('malformed JSON, extra keys and invalid password types fail without revealing protected content', async context => {
  const configuration = await fixture(context);
  const secret = 'protected-content-must-never-appear';
  const invalid = [
    `{"KEYCLOAK_ADMIN_PASSWORD":"${secret}",`,
    JSON.stringify({ ...passwords, [secret]: secret }),
    JSON.stringify({ KEYCLOAK_ADMIN_PASSWORD: secret }),
    JSON.stringify({ ...passwords, KEYCLOAK_ADMIN_PASSWORD: 123 }),
    JSON.stringify({ ...passwords, VAULT_CUSTODY_PASSWORD: { secret } }),
    JSON.stringify({ ...passwords, KEYCLOAK_ANGELINA_PASSWORD: ' \t ' }),
    JSON.stringify({ ...passwords, VAULT_CUSTODY_PASSWORD: `${secret}\n` }),
    'null', '[]', JSON.stringify(secret),
  ];
  for (const content of invalid) {
    await writeFile(configuration.OPERATOR_INPUT_FILE, content);
    await assert.rejects(readOperatorInputs(configuration, passwords), error => {
      assert.equal(error.parameter, 'OPERATOR_INPUT_FILE');
      assert.ok(!error.message.includes(secret));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('oversized, missing and bootstrap-contained files fail before they can supply credentials', async context => {
  const configuration = await fixture(context, 'x'.repeat(65_537));
  await assert.rejects(readOperatorInputs(configuration, {}), { parameter: 'OPERATOR_INPUT_FILE' });
  await assert.rejects(readOperatorInputs({ ...configuration,
    OPERATOR_INPUT_FILE: configuration.OPERATOR_INPUT_FILE + '.missing' }, {}), { parameter: 'OPERATOR_INPUT_FILE' });
  await writeFile(configuration.OPERATOR_INPUT_FILE, JSON.stringify(passwords));
  await assert.rejects(readOperatorInputs({ ...configuration,
    LOCAL_SECRETS_DIR: resolve(configuration.OPERATOR_INPUT_FILE, '..') }, {}), { parameter: 'OPERATOR_INPUT_FILE' });
});
