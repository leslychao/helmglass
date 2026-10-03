import { ProvisioningError } from './keycloak-client.mjs';

const OWNER_ATTRIBUTE = 'helm.provisioning.installation';
const PHASE_ATTRIBUTE = 'helm.provisioning.phase';
const USERS = [
  { username: 'admin', firstName: 'Администратор', administrative: true },
  { username: 'angelina', firstName: 'Ангелина', administrative: false },
];

function fail(code, message) {
  throw new ProvisioningError(code, message);
}

function requiredText(value, parameter) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    fail('INVALID_INPUT', `Required parameter ${parameter} is missing or invalid.`);
  }
  return value;
}

export function validatePredefinedInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('INVALID_INPUT', 'Predefined user input must be an object.');
  }
  const installationId = requiredText(input.installationId, 'installationId');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(installationId)) {
    fail('INVALID_INPUT', 'installationId contains unsupported characters.');
  }
  const users = USERS.map((definition) => {
    const profile = input[definition.username];
    if (!profile || typeof profile !== 'object') {
      fail('INVALID_INPUT', `Required profile ${definition.username} is missing.`);
    }
    const email = requiredText(profile.email, `${definition.username}.email`).trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      fail('INVALID_INPUT', `Invalid ${definition.username}.email.`);
    }
    const password = requiredText(profile.password, `${definition.username}.password`);
    const lastName = requiredText(profile.lastName, `${definition.username}.lastName`).trim();
    const attributes = profile.attributes ?? {};
    if (typeof attributes !== 'object' || Array.isArray(attributes)) {
      fail('INVALID_INPUT', `Invalid ${definition.username}.attributes.`);
    }
    for (const [name, values] of Object.entries(attributes)) {
      if (name.startsWith('helm.') || !Array.isArray(values)
          || values.some((value) => typeof value !== 'string' || !value.trim())) {
        fail('INVALID_INPUT', `Invalid ${definition.username}.attributes.`);
      }
    }
    return { ...definition, email, password, lastName, attributes };
  });
  if (users[0].email.toLowerCase() === users[1].email.toLowerCase()) {
    fail('INVALID_INPUT', 'Predefined users require distinct confirmed email addresses.');
  }
  return { installationId, users };
}

function marker(username, suffix) {
  return `helm.predefined.${username}.${suffix}`;
}

function isOwned(user, installationId) {
  return user.attributes?.[OWNER_ATTRIBUTE]?.length === 1
    && user.attributes[OWNER_ATTRIBUTE][0] === installationId;
}

async function exactUsers(client, query) {
  const users = await client.request('GET', `admin/realms/helm/users?${new URLSearchParams({ ...query, exact: 'true', max: '3' })}`);
  if (!Array.isArray(users) || users.length > 1) {
    fail('USER_CONFLICT', 'Keycloak did not return a unique account.');
  }
  return users;
}

async function saveRealmMarker(client, username, userId, complete) {
  // Read again to preserve unrelated realm settings and the other account's markers.
  const realm = await client.request('GET', 'admin/realms/helm');
  const attributes = {
    ...realm.attributes,
    [marker(username, 'id')]: userId,
    [marker(username, 'complete')]: String(complete),
  };
  try {
    await client.request('PUT', 'admin/realms/helm', { ...realm, attributes });
  } catch (error) {
    if (error.code !== 'ADMIN_RESULT_UNKNOWN') throw error;
    const observed = await client.request('GET', 'admin/realms/helm');
    if (observed.attributes?.[marker(username, 'id')] !== userId
        || observed.attributes?.[marker(username, 'complete')] !== String(complete)) throw error;
  }
}

async function putUser(client, user, replacement, expectedPhase) {
  const path = `admin/realms/helm/users/${encodeURIComponent(user.id)}`;
  try {
    await client.request('PUT', path, replacement);
  } catch (error) {
    if (error.code !== 'ADMIN_RESULT_UNKNOWN') throw error;
    const observed = await client.request('GET', path);
    if (observed.enabled !== replacement.enabled
        || observed.attributes?.[PHASE_ATTRIBUTE]?.[0] !== expectedPhase) throw error;
  }
  return client.request('GET', path);
}

async function ensureUser(client, installationId, definition, existing) {
  let user = existing;
  if (!user) {
    try {
      await client.request('POST', 'admin/realms/helm/users', {
        username: definition.username,
        enabled: false,
        email: definition.email,
        emailVerified: true,
        firstName: definition.firstName,
        lastName: definition.lastName,
        requiredActions: [],
        attributes: {
          ...definition.attributes,
          [OWNER_ATTRIBUTE]: [installationId],
          [PHASE_ATTRIBUTE]: ['created'],
        },
      });
    } catch (error) {
      if (error.code !== 'ADMIN_RESULT_UNKNOWN' && error.code !== 'ADMIN_HTTP_409') throw error;
      [user] = await exactUsers(client, { username: definition.username });
      if (!user || !isOwned(user, installationId)) throw error;
    }
    if (!user) [user] = await exactUsers(client, { username: definition.username });
    if (!user || !isOwned(user, installationId)) {
      fail('USER_RESULT_UNKNOWN', 'Account creation could not be reconciled.');
    }
  }
  const path = `admin/realms/helm/users/${encodeURIComponent(user.id)}`;
  user = await client.request('GET', path);
  await saveRealmMarker(client, definition.username, user.id, false);
  const phase = user.attributes?.[PHASE_ATTRIBUTE]?.[0];
  if (phase === 'ready') {
    // Enabling already succeeded; a lost realm receipt must not undo later user/admin edits.
    await saveRealmMarker(client, definition.username, user.id, true);
    return { username: definition.username, id: user.id, status: 'preserved' };
  }
  if (phase === 'password-pending') {
    fail('PASSWORD_RESULT_UNKNOWN', 'A previous password assignment has an unknown result; operator reconciliation is required.');
  }
  if (phase === 'created') {
    user = await putUser(client, user, {
      ...user,
      enabled: false,
      email: definition.email,
      emailVerified: true,
      firstName: definition.firstName,
      lastName: definition.lastName,
      requiredActions: [],
      attributes: {
        ...user.attributes,
        ...definition.attributes,
        [PHASE_ATTRIBUTE]: ['password-pending'],
      },
    }, 'password-pending');
    try {
      await client.request('PUT', `${path}/reset-password`, {
        type: 'password', value: definition.password, temporary: false,
      });
    } catch (error) {
      if (error.code === 'ADMIN_RESULT_UNKNOWN') {
        fail('PASSWORD_RESULT_UNKNOWN', 'Password response was lost; the account remains disabled for reconciliation.');
      }
      // A confirmed rejection has no effect. A corrected input may safely be retried.
      await putUser(client, user, {
        ...user, enabled: false,
        attributes: { ...user.attributes, [PHASE_ATTRIBUTE]: ['created'] },
      }, 'created');
      throw error;
    }
    user = await putUser(client, user, {
      ...user, enabled: false,
      attributes: { ...user.attributes, [PHASE_ATTRIBUTE]: ['password-ready'] },
    }, 'password-ready');
  }
  if (!['password-ready', 'ready'].includes(user.attributes?.[PHASE_ATTRIBUTE]?.[0])) {
    fail('USER_PHASE_INVALID', 'Managed account has an unrecognized provisioning phase.');
  }
  const roles = await client.request('GET', `${path}/role-mappings/realm`);
  const adminRole = roles.find((role) => role.name === 'platform_admin');
  if (!definition.administrative && adminRole) {
    fail('USER_ROLE_CONFLICT', 'A regular predefined account unexpectedly has administrative access.');
  }
  if (definition.administrative && !adminRole) {
    const role = await client.request('GET', 'admin/realms/helm/roles/platform_admin');
    try {
      await client.request('POST', `${path}/role-mappings/realm`, [role]);
    } catch (error) {
      if (error.code !== 'ADMIN_RESULT_UNKNOWN') throw error;
      const observedRoles = await client.request('GET', `${path}/role-mappings/realm`);
      if (!observedRoles.some((observed) => observed.id === role.id)) throw error;
    }
  }
  const credentials = await client.request('GET', `${path}/credentials`);
  if (!credentials.some((credential) => credential.type === 'password')) {
    fail('PASSWORD_MISSING', 'Managed account has no password credential.');
  }
  user = await client.request('GET', path);
  if (!user.emailVerified || user.email !== definition.email || !user.firstName || !user.lastName
      || (user.requiredActions ?? []).length !== 0 || !isOwned(user, installationId)) {
    fail('USER_VERIFICATION_FAILED', 'Managed account profile did not pass verification.');
  }
  user = await putUser(client, user, {
    ...user, enabled: true,
    attributes: { ...user.attributes, [PHASE_ATTRIBUTE]: ['ready'] },
  }, 'ready');
  await saveRealmMarker(client, definition.username, user.id, true);
  return { username: definition.username, id: user.id, status: 'prepared' };
}

export async function provisionPredefinedUsers(client, rawInput) {
  const { installationId, users } = validatePredefinedInput(rawInput);
  const realm = await client.request('GET', 'admin/realms/helm');
  if (realm.attributes?.['helm.installationId'] !== installationId) {
    fail('REALM_OWNERSHIP_CONFLICT', 'Realm belongs to a different or unmanaged installation.');
  }

  // Resolve every conflict before modifying either of the two accounts.
  const prepared = [];
  for (const definition of users) {
    const completed = realm.attributes?.[marker(definition.username, 'complete')] === 'true';
    const savedId = realm.attributes?.[marker(definition.username, 'id')];
    if (completed) {
      if (!savedId) fail('USER_MARKER_INVALID', 'Completed account has no durable identity marker.');
      const user = await client.request('GET', `admin/realms/helm/users/${encodeURIComponent(savedId)}`, undefined, { allowNotFound: true });
      if (user && !isOwned(user, installationId)) {
        fail('USER_OWNERSHIP_CONFLICT', 'Completed account no longer has the expected ownership marker.');
      }
      prepared.push({ definition, completed: true, user, savedId });
      continue;
    }
    const [user] = await exactUsers(client, { username: definition.username });
    const [emailOwner] = await exactUsers(client, { email: definition.email });
    if ((user && !isOwned(user, installationId)) || (emailOwner && emailOwner.id !== user?.id)
        || (savedId && savedId !== user?.id)) {
      fail('USER_OWNERSHIP_CONFLICT', 'Predefined username or email conflicts with another account.');
    }
    prepared.push({ definition, completed: false, user });
  }

  const results = [];
  for (const entry of prepared) {
    if (entry.completed) {
      results.push({ username: entry.definition.username, id: entry.savedId,
        status: entry.user ? 'preserved' : 'previously-removed' });
    } else {
      results.push(await ensureUser(client, installationId, entry.definition, entry.user));
    }
  }
  return results;
}
