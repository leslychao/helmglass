import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(frontend, 'dist/widget/browser');
const source = await readFile(resolve(directory, 'index.html'), 'utf8');
const scripts = [...source.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)];
assert.equal(scripts.length, 1, 'The widget must have one Angular entry point');
const styles = [...source.matchAll(/<link\b[^>]*\brel="stylesheet"[^>]*\bhref="([^"]+)"[^>]*>/g)];
assert.equal(styles.length, 1, 'The widget must have one generated stylesheet');
const localPath = (name) => {
  assert.match(name, /^[A-Za-z0-9_.-]+$/, 'Generated resources must be local files');
  return resolve(directory, name);
};
const logo =
  'data:image/png;base64,' +
  (await readFile(resolve(frontend, 'public/helm-logo.png'))).toString('base64');
const result = await build({
  entryPoints: [localPath(scripts[0][1])],
  bundle: true,
  splitting: false,
  write: false,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  legalComments: 'inline',
});
assert.equal(result.outputFiles.length, 1);
const code = result.outputFiles[0].text.replaceAll('helm-logo.png', logo);
assert.ok(!/<\/script/i.test(code), 'Bundled script must escape the HTML closing tag');
const css = await readFile(localPath(styles[0][1]), 'utf8');
assert.ok(!/url\(\s*['"]?(?!data:)[^\s)'"]+/i.test(css), 'Widget CSS cannot fetch cabinet assets');
const shell = source
  .replace(scripts[0][0], '')
  .replace(styles[0][0], '')
  .replace(/<link\b[^>]*\brel="modulepreload"[^>]*>/g, '');
assert.ok(
  !/<(?:script|link)\b[^>]*(?:src|href)=/i.test(shell),
  'Widget cannot depend on external code or styles',
);
const html = shell
  .replace('</head>', () => `<style>${css}</style></head>`)
  .replace('</body>', () => `<script>${code}</script></body>`);
await writeFile(resolve(frontend, 'dist/widget/index.html'), html);
process.stdout.write(`Self-contained MCP widget: ${Buffer.byteLength(html)} bytes\n`);
