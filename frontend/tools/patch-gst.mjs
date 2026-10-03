import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../node_modules/gstwebrtc-api',
);
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (manifest.version !== '3.0.0')
  throw new Error('Review the Helm transport patch before changing gstwebrtc-api.');

// Only the transport injection changes. SDP/ICE and peer lifecycle remain upstream.
const patches = [
  [
    'src/com-channel.js',
    'constructor(url, meta, webrtcConfig) {',
    'constructor(url, meta, webrtcConfig, transportFactory) {',
  ],
  [
    'src/com-channel.js',
    'this._ws = new WebSocket(url);',
    'this._ws = transportFactory ? transportFactory(url) : new WebSocket(url);',
  ],
  [
    'src/gstwebrtc-api.js',
    'this._config.webrtcConfig\n    );',
    'this._config.webrtcConfig,\n      this._config.transportFactory\n    );',
  ],
];
for (const [filename, before, after] of patches) {
  const file = path.join(root, filename);
  const source = (await readFile(file, 'utf8')).replaceAll('\r\n', '\n');
  if (source.includes(after)) continue;
  if (source.split(before).length !== 2)
    throw new Error(`Upstream transport contract changed: ${filename}`);
  await writeFile(file, source.replace(before, after), 'utf8');
}
