import { afterEach, describe, expect, it } from 'vitest';
import { widgetOrigin } from './widget-config';

describe('MCP widget public address', () => {
  afterEach(() => document.getElementById('helm-runtime-config')?.remove());

  it('uses the resource configuration independently of the host document address', () => {
    const script = document.createElement('script');
    script.id = 'helm-runtime-config';
    script.type = 'application/json';
    script.textContent = JSON.stringify({ publicOrigin: 'https://helm.example.test:8443' });
    document.head.append(script);
    expect(widgetOrigin(document)).toBe('https://helm.example.test:8443');
    script.textContent = JSON.stringify({ publicOrigin: 'https://helm.example.test/path' });
    expect(() => widgetOrigin(document)).toThrow();
    script.textContent = JSON.stringify({ publicOrigin: 'http://helm.example.test' });
    expect(() => widgetOrigin(document)).toThrow();
  });

  it('fails closed when the resource owner has not supplied configuration', () => {
    expect(() => widgetOrigin(document)).toThrow();
  });
});
