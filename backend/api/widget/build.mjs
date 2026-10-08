import { build } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const result = await build({ entryPoints: ['src/main.ts'], bundle: true, minify: true,
  format: 'esm', target: 'es2022', write: false });
const script = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
const template = await readFile('src/index.html', 'utf8');
const html = template.replace('<!--SCRIPT-->', () => `<script type="module">${script}</script>`);
if (Buffer.byteLength(html) > 1024 * 1024) throw new Error('Widget bundle exceeds its bound');
await mkdir('../src/main/resources/mcp-widget', { recursive: true });
await writeFile('../src/main/resources/mcp-widget/index.html', html);
