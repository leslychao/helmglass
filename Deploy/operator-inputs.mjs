import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ConfigurationError } from './configuration.mjs';
import { isInside, readProtectedFile } from './protected-files.mjs';

const INPUT_NAMES = ['KEYCLOAK_ADMIN_PASSWORD', 'KEYCLOAK_ANGELINA_PASSWORD', 'VAULT_CUSTODY_PASSWORD'];
const repository = fileURLToPath(new URL('../', import.meta.url));

function validateSecret(value, parameter) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) {
    throw new ConfigurationError(parameter, 'operator passwords must be non-empty single-line strings');
  }
  return value;
}

/** Operator-only inputs: callers must not merge file passwords into child-process environments. */
export async function readOperatorInputs(configuration, environment = process.env) {
  let stored = {};
  if (configuration.OPERATOR_INPUT_FILE) {
    try {
      const path = await realpath(configuration.OPERATOR_INPUT_FILE);
      if (isInside(repository, path) || isInside(configuration.LOCAL_SECRETS_DIR, path)) {
        throw new Error('Invalid operator input location');
      }
      stored = JSON.parse((await readProtectedFile(configuration.OPERATOR_INPUT_FILE, 65_536)).toString('utf8'));
    } catch {
      throw new ConfigurationError('OPERATOR_INPUT_FILE',
        'requires a readable bounded JSON file outside the repository and service bootstrap');
    }
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)
        || Object.keys(stored).length !== INPUT_NAMES.length
        || Object.keys(stored).some(name => !INPUT_NAMES.includes(name))) {
      throw new ConfigurationError('OPERATOR_INPUT_FILE', 'requires exactly the three documented password keys');
    }
    for (const name of INPUT_NAMES) validateSecret(stored[name], 'OPERATOR_INPUT_FILE');
  }

  const inputs = {};
  for (const name of INPUT_NAMES) {
    const value = environment[name] === undefined ? stored[name] : environment[name];
    if (value !== undefined) inputs[name] = validateSecret(value, name);
  }
  return Object.freeze(inputs);
}
