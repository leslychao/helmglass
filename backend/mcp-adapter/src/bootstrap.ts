import { open, mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';

const bootstrapSchema = z.strictObject({ schemaVersion: z.literal(1), tls: z.strictObject({
  certificatePem: z.string().includes('BEGIN CERTIFICATE').max(65_536),
  privateKeyPem: z.string().includes('PRIVATE KEY').max(65_536),
  caPem: z.string().includes('BEGIN CERTIFICATE').max(65_536),
}) });
async function readBootstrap(): Promise<z.infer<typeof bootstrapSchema>> {
  try {
    const handle = await open(process.env.BOOTSTRAP_FILE ?? '/run/secrets/mcp_adapter_identity', 'r');
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > 262_144) throw new Error('INVALID_BOOTSTRAP_SIZE');
      const encoded = await handle.readFile();
      try { return bootstrapSchema.parse(JSON.parse(encoded.toString('utf8'))); }
      finally { encoded.fill(0); }
    } finally { await handle.close(); }
  } catch { throw new Error('INVALID_MCP_BOOTSTRAP'); }
}
const bootstrap = await readBootstrap();
const directory = '/run/helm-mcp';
await mkdir(directory, { recursive: true, mode: 0o700 });
for (const [name, content] of Object.entries({ cert: bootstrap.tls.certificatePem, key: bootstrap.tls.privateKeyPem, ca: bootstrap.tls.caPem })) {
  await writeFile(`${directory}/${name}.pem`, content, { mode: 0o600, flag: 'wx' });
}
process.env.MTLS_CERT_FILE = `${directory}/cert.pem`;
process.env.MTLS_KEY_FILE = `${directory}/key.pem`;
process.env.MTLS_CA_FILE = `${directory}/ca.pem`;
await import('./main.js');
