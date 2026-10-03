/** The MCP resource owner supplies this public address; the host iframe origin is unrelated. */
export function widgetOrigin(document: Document): string {
  const config = document.getElementById('helm-runtime-config');
  if (!(config instanceof HTMLScriptElement) || config.type !== 'application/json')
    throw new Error('Отсутствует адрес сервиса Helm Glass');
  const value: unknown = JSON.parse(config.textContent ?? '');
  if (
    !value ||
    typeof value !== 'object' ||
    !('publicOrigin' in value) ||
    typeof value.publicOrigin !== 'string'
  )
    throw new Error('Некорректный адрес сервиса Helm Glass');
  const url = new URL(value.publicOrigin);
  if (url.protocol !== 'https:' || url.origin !== value.publicOrigin)
    throw new Error('Некорректный адрес сервиса Helm Glass');
  return url.origin;
}
