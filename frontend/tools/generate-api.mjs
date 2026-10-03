import { readFile, writeFile, mkdir } from 'node:fs/promises';
import openapiTS, { astToString } from './api-types/node_modules/openapi-typescript/dist/index.mjs';
import Ajv from './api-types/node_modules/ajv/dist/2020.js';
import addFormats from './api-types/node_modules/ajv-formats/dist/index.js';
import standaloneCode from './api-types/node_modules/ajv/dist/standalone/index.js';
import { build } from './api-types/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';

const source = new URL('../../backend/api/src/main/resources/openapi.json', import.meta.url);
const schema = JSON.parse(await readFile(source, 'utf8'));
const directory = new URL('../src/app/core/api/generated/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL('schema.ts', directory), astToString(await openapiTS(source)));
const operations = [];
const responses = [];
const responseSchemas = {};
const schemaNames = new Map();
for (const [path, methods] of Object.entries(schema.paths)) {
  for (const [method, operation] of Object.entries(methods)) {
    const successful = Object.entries(operation.responses ?? {}).find(([status]) =>
      /^2\d\d$/.test(status),
    );
    const responseSchema = successful?.[1].content?.['application/json']?.schema;
    if (responseSchema) {
      const fingerprint = JSON.stringify(responseSchema);
      const name = schemaNames.get(fingerprint) ?? `response${schemaNames.size}`;
      schemaNames.set(fingerprint, name);
      responses.push({
        method: method.toUpperCase(),
        path: path.replace(/^\/api\/v1/, ''),
        validator: name,
      });
      responseSchemas[name] = responseSchema;
    }
    if (!operation['x-operation-kind']) continue;
    operations.push({
      method: method.toUpperCase(),
      path: path.replace(/^\/api\/v1/, ''),
      kind: operation['x-operation-kind'],
    });
  }
}
await writeFile(
  new URL('operation-kinds.ts', directory),
  `// Generated from canonical OpenAPI x-operation-kind. Do not edit.\nexport const operationKinds = ${JSON.stringify(operations, null, 2)} as const;\n`,
);
const ajv = new Ajv({ code: { source: true, esm: true }, inlineRefs: false });
addFormats(ajv);
const schemaId = 'https://helm-glass.invalid/contracts';
const definitions = JSON.parse(
  JSON.stringify({ ...schema.components.schemas, ...responseSchemas }, (key, value) =>
    key === '$ref' && typeof value === 'string'
      ? value.replace(/^#\/components\/schemas\//, '#/$defs/')
      : value,
  ),
);
ajv.addSchema({ $id: schemaId, $defs: definitions });
const validators = Object.fromEntries(
  responses.map((response) => [response.validator, `${schemaId}#/$defs/${response.validator}`]),
);
const generatedCode = standaloneCode(ajv, validators);
const bundle = await build({
  stdin: {
    contents: generatedCode,
    resolveDir: fileURLToPath(new URL('./api-types/', import.meta.url)),
    loader: 'js',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
});
await writeFile(new URL('response-validators.js', directory), bundle.outputFiles[0].text);
await writeFile(
  new URL('response-validators.d.ts', directory),
  Array.from(schemaNames.values())
    .map((name) => `export function ${name}(value: unknown): boolean;`)
    .join('\n') + '\n',
);
await writeFile(
  new URL('response-contracts.ts', directory),
  `// Generated from canonical OpenAPI. Do not edit.\nexport const responseContracts = ${JSON.stringify(responses, null, 2)} as const;\n`,
);
