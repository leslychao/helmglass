import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { digest, WorkerError } from './protocol.js';
import type { Assignment } from './protocol.js';

interface AriaNode {
  role: string;
  name?: string | undefined;
  text?: string | undefined;
  ref?: string | undefined;
  checked?: boolean | 'mixed' | undefined;
  disabled?: boolean | undefined;
  expanded?: boolean | undefined;
  active?: boolean | undefined;
  invalid?: boolean | string | undefined;
  level?: number | undefined;
  pressed?: boolean | 'mixed' | undefined;
  selected?: boolean | undefined;
  url?: string | undefined;
  placeholder?: string | undefined;
  cursor?: string | undefined;
  children?: AriaChild[] | undefined;
  box?: { x: number; y: number; width: number; height: number } | undefined;
}
type AriaChild = AriaNode | string;
const nodeSchema: z.ZodType<AriaNode> = z.lazy(() => z.object({
  role: z.string(), name: z.string().optional(), text: z.string().optional(),
  ref: z.string().optional(), checked: z.union([z.boolean(), z.literal('mixed')]).optional(),
  disabled: z.boolean().optional(), expanded: z.boolean().optional(), active: z.boolean().optional(),
  invalid: z.union([z.boolean(), z.string()]).optional(), level: z.number().optional(),
  pressed: z.union([z.boolean(), z.literal('mixed')]).optional(), selected: z.boolean().optional(),
  url: z.string().optional(), placeholder: z.string().optional(), cursor: z.string().optional(),
  children: z.array(z.union([nodeSchema, z.string()])).optional(),
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
}));
export const nativeSnapshotSchema = z.array(z.union([nodeSchema, z.string()]));
const inputRoles = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

function sanitizeText(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"']+/gi, (url) => safeUrl(url));
}
export function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'about:blank';
    return `${url.origin}${url.pathname}`;
  } catch { return ''; }
}

/** Projection of upstream nodes, never a separate DOM/ARIA extractor or ref generator. */
export function projectSnapshot(raw: unknown, maxCharacters = 64_000): { nodes: AriaChild[]; truncated: boolean } {
  const parsed = nativeSnapshotSchema.safeParse(raw);
  if (!parsed.success) throw new WorkerError('UPSTREAM_SNAPSHOT_INCOMPATIBLE');
  let remaining = maxCharacters;
  let truncated = false;
  function project(nodes: AriaChild[], depth: number): AriaChild[] {
    const result: AriaChild[] = [];
    for (const node of nodes) {
      if (remaining <= 0 || depth > 30) { truncated = true; break; }
      if (typeof node === 'string') {
        const clean = sanitizeText(node).slice(0, 8192);
        remaining -= JSON.stringify(clean).length;
        if (remaining < 0) { truncated = true; break; }
        result.push(clean);
        continue;
      }
      const { children, text, url, ...fields } = node;
      const clean: AriaNode = { ...fields };
      if (clean.name !== undefined) clean.name = sanitizeText(clean.name).slice(0, 4096);
      if (clean.placeholder !== undefined) clean.placeholder = sanitizeText(clean.placeholder).slice(0, 1024);
      if (url !== undefined) clean.url = safeUrl(url);
      // Input values and descendants can contain credentials; names/states remain useful.
      if (!inputRoles.has(node.role)) {
        if (text !== undefined) clean.text = sanitizeText(text).slice(0, 8192);
        if (children !== undefined) clean.children = project(children, depth + 1);
      }
      remaining -= JSON.stringify({ ...clean, children: undefined }).length;
      if (remaining < 0) { truncated = true; break; }
      result.push(clean);
    }
    return result;
  }
  return { nodes: project(parsed.data, 0), truncated };
}

export interface BrowserObservation {
  schemaVersion: 1;
  observationId: string;
  taskId: string | null;
  browserSessionId: string;
  pageId: string;
  runtimeGeneration: string;
  controlEpoch: number;
  pageEpoch: number;
  privacyEpoch: number;
  capturedAt: string;
  sequence: number;
  url: string;
  title: string;
  snapshotFormat: 'playwright-aria-json-1.64';
  snapshot: AriaChild[];
  coverage: 'SCOPED' | 'UNKNOWN';
  truncated: boolean;
  media: { mediaRef: string; kind: 'AUDIO' | 'VIDEO'; durationSeconds: number | null }[];
}
export class ObservationBindings {
  private binding: { observation: BrowserObservation; expiresAt: number; refs: Map<string, string> } | undefined;
  invalidate(): void { this.binding = undefined; }

  issue(assignment: Assignment, pageId: string, runtimeGeneration: string, sequence: number,
    raw: unknown, url: string, title: string, frameCount: number): BrowserObservation {
    const projection = projectSnapshot(raw);
    const observation: BrowserObservation = {
      schemaVersion: 1, observationId: randomUUID(), taskId: assignment.taskId,
      browserSessionId: assignment.browserSessionId, pageId, runtimeGeneration,
      controlEpoch: assignment.controlEpoch, pageEpoch: assignment.pageEpoch,
      privacyEpoch: assignment.privacyEpoch, capturedAt: new Date().toISOString(), sequence,
      url: safeUrl(url), title: sanitizeText(title).slice(0, 512),
      snapshotFormat: 'playwright-aria-json-1.64', snapshot: projection.nodes,
      coverage: frameCount > 1 ? 'UNKNOWN' : 'SCOPED', truncated: projection.truncated, media: [],
    };
    this.binding = { observation, expiresAt: performance.now() + 60_000, refs: this.references(projection.nodes) };
    return observation;
  }

  require(observationId: string, target: string, current: Assignment): string {
    const binding = this.binding;
    if (!binding || binding.expiresAt <= performance.now() || binding.observation.observationId !== observationId
        || binding.observation.controlEpoch !== current.controlEpoch || binding.observation.pageEpoch !== current.pageEpoch
        || binding.observation.privacyEpoch !== current.privacyEpoch) throw new WorkerError('STALE_OBSERVATION');
    const evidence = binding.refs.get(target);
    if (!evidence) throw new WorkerError('REF_NOT_GRANTED');
    return evidence;
  }

  verifyTarget(raw: unknown, target: string, expected: string): void {
    const actual = this.references(projectSnapshot(raw).nodes).get(target);
    if (actual !== expected) throw new WorkerError('STALE_OBSERVATION');
  }

  private references(nodes: AriaChild[]): Map<string, string> {
    const refs = new Map<string, string>();
    function visit(children: AriaChild[]): void {
      for (const node of children) {
        if (typeof node === 'string') continue;
        if (node.ref) refs.set(node.ref, digest({ role: node.role, name: node.name ?? '', disabled: node.disabled ?? false, url: node.url ?? '' }));
        if (node.children) visit(node.children);
      }
    }
    visit(nodes);
    return refs;
  }
}
