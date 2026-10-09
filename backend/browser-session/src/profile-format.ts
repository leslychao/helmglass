import { once } from "node:events";
import type { Writable } from "node:stream";

export const profileLimits = { total: 256 * 1024 * 1024, record: 16 * 1024 * 1024, chunk: 64 * 1024 };
export class ProfileExportError extends Error {
  constructor(readonly status: 409 | 413 | 422, message: string, readonly code = "PROFILE_SAVE_FAILED") { super(message); }
}

export async function writeProfileChunk(output: Writable, bytes: Uint8Array): Promise<void> {
  for (let offset = 0; offset < bytes.byteLength; offset += profileLimits.chunk) {
    if (output.destroyed) throw new ProfileExportError(409, "Profile transfer interrupted");
    if (!output.write(bytes.subarray(offset, offset + profileLimits.chunk))) await once(output, "drain");
  }
}

export async function* profileRecords(input: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  let total = 0;
  let length = 0;
  let parts: Buffer[] = [];
  for await (const raw of input) {
    const chunk = Buffer.from(raw);
    total += chunk.length;
    if (total > profileLimits.total) throw new ProfileExportError(413, "Profile exceeds 256 MiB", "PROFILE_TOO_LARGE");
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      length += part.length;
      if (length + (newline < 0 ? 0 : 1) > profileLimits.record) throw new ProfileExportError(413, "Profile record exceeds 16 MiB", "PROFILE_RECORD_TOO_LARGE");
      if (part.length) parts.push(part);
      if (newline < 0) break;
      if (!length) throw new ProfileExportError(422, "Empty profile record", "PROFILE_INVALID");
      const text = Buffer.concat(parts, length).toString("utf8");
      parts = []; length = 0;
      yield JSON.parse(text);
      start = newline + 1;
    }
  }
  if (length) throw new ProfileExportError(422, "Incomplete profile", "PROFILE_INVALID");
}
