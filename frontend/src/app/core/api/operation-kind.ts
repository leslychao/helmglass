import { operationKinds } from './generated/operation-kinds';

/** Recovery uses the server's idempotency scope, including its resource binding. */
export function operationKind(method: string, path: string): string | null {
  const segments = path.split('/');
  for (const operation of operationKinds) {
    if (operation.method !== method) continue;
    const template = operation.path.split('/');
    if (template.length !== segments.length) continue;
    const parameters = new Map<string, string>();
    const matches = template.every((part, index) => {
      if (!part.startsWith('{') || !part.endsWith('}')) return part === segments[index];
      if (!segments[index]) return false;
      parameters.set(part, segments[index]);
      return true;
    });
    if (!matches) continue;
    let kind: string = operation.kind;
    for (const [parameter, value] of parameters) kind = kind.replaceAll(parameter, value);
    return kind;
  }
  return null;
}
