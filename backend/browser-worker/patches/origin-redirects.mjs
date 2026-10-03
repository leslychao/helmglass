import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The pinned Chromium manager otherwise bypasses request routing after redirects.
// Use its existing interception path for each hop; do not re-fetch or replay requests.
const path = fileURLToPath(new URL('../node_modules/playwright-core/lib/coreBundle.js', import.meta.url));
const expected = '3a6c6eb6c91062db4fb8dec38b6b5d6e54e7196f272c343b69cd2f89444340b1';
const marker = '// Helm redirect origin enforcement v1';
let source = await readFile(path, 'utf8');
if (source.includes(marker)) {
  process.stdout.write('Pinned redirect patch already applied.\n');
  process.exit(0);
}
if (createHash('sha256').update(source).digest('hex') !== expected) {
  throw new Error('Pinned Playwright lifecycle bundle digest mismatch.');
}
const before = '          if (redirectedFrom || !this._userRequestInterceptionEnabled && this._protocolRequestInterceptionEnabled) {';
if (source.split(before).length !== 2) throw new Error('Redirect origin patch does not apply uniquely.');
source = source.replace(before, '          if (!this._userRequestInterceptionEnabled && this._protocolRequestInterceptionEnabled) {');
await writeFile(path, source + '\n' + marker + '\n');
process.stdout.write(`Applied redirect patch: ${createHash('sha256').update(source).digest('hex')}\n`);
