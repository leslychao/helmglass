/** Runs only on the intercepted, empty snapshot page, never on a site's document. */
export function installProfileCodec() {
  const limit = 16 * 1024 * 1024;
  const encoder = new TextEncoder();
  function encode(value: unknown): unknown {
    let bytes = 0;
    const references = new Map<object, number>();
    const charge = (text: string) => {
      bytes += encoder.encode(text).length;
      if (bytes > limit) throw new Error("PROFILE_RECORD_TOO_LARGE");
    };
    const literal = (item: unknown) => { charge(JSON.stringify(item)); return item; };
    const string = (text: string) => {
      if (text.length > limit) throw new Error("PROFILE_RECORD_TOO_LARGE");
      charge(JSON.stringify(text)); return text;
    };
    function visit(item: unknown, depth: number): unknown {
      if (depth > 32 || references.size > 50_000) throw new Error("PROFILE_COMPLEXITY_LIMIT");
      if (item === undefined) return literal({ v: "undefined" });
      if (item === null) return literal({ v: "null" });
      if (typeof item === "string") return string(item);
      if (typeof item === "boolean") return literal(item);
      if (typeof item === "number") {
        if (Number.isNaN(item)) return literal({ v: "NaN" });
        if (item === Infinity) return literal({ v: "Infinity" });
        if (item === -Infinity) return literal({ v: "-Infinity" });
        return literal(Object.is(item, -0) ? { v: "-0" } : item);
      }
      if (typeof item === "bigint") return literal({ bi: item.toString() });
      if (typeof item !== "object") throw new Error("PROFILE_UNSUPPORTED_VALUE");
      if (item instanceof Date) return literal({ d: item.toJSON() });
      if (item instanceof RegExp) return literal({ r: { p: item.source, f: item.flags } });
      const binary = (data: Uint8Array) => {
        if (data.byteLength > limit * 3 / 4) throw new Error("PROFILE_RECORD_TOO_LARGE");
        let text = "";
        for (let offset = 0; offset < data.length; offset += 8192) text += String.fromCharCode(...data.subarray(offset, offset + 8192));
        return btoa(text);
      };
      if (item instanceof ArrayBuffer) return literal({ ab: { b: binary(new Uint8Array(item)) } });
      if (ArrayBuffer.isView(item)) {
        const kinds: Record<string, string> = { Int8Array: "i8", Uint8Array: "ui8", Uint8ClampedArray: "ui8c", Int16Array: "i16", Uint16Array: "ui16", Int32Array: "i32", Uint32Array: "ui32", Float32Array: "f32", Float64Array: "f64", BigInt64Array: "bi64", BigUint64Array: "bui64" };
        const kind = kinds[item.constructor.name];
        if (!kind) throw new Error("PROFILE_UNSUPPORTED_VALUE");
        return literal({ ta: { k: kind, b: binary(new Uint8Array(item.buffer, item.byteOffset, item.byteLength)) } });
      }
      const previous = references.get(item);
      if (previous !== undefined) return literal({ ref: previous });
      const id = references.size + 1;
      references.set(item, id);
      if (Array.isArray(item) || item instanceof Set) {
        const values: unknown[] = [];
        charge(JSON.stringify(Array.isArray(item) ? { a: [], id } : { s: [], id }));
        for (const entry of item) { if (values.length) charge(","); values.push(visit(entry, depth + 1)); }
        return Array.isArray(item) ? { a: values, id } : { s: values, id };
      }
      if (item instanceof Map) {
        const values: object[] = []; charge(JSON.stringify({ m: [], id }));
        for (const [key, entry] of item) {
          if (values.length) charge(","); charge('{"k":,"v":}');
          values.push({ k: visit(key, depth + 1), v: visit(entry, depth + 1) });
        }
        return { m: values, id };
      }
      if (Object.getPrototypeOf(item) !== Object.prototype) throw new Error("PROFILE_UNSUPPORTED_VALUE");
      const entries: object[] = []; charge(JSON.stringify({ o: [], id }));
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        if (entries.length) charge(","); charge('{"k":,"v":}');
        entries.push({ k: string(key), v: visit(Reflect.get(item, key), depth + 1) });
      }
      return { o: entries, id };
    }
    return visit(value, 0);
  }
  function decode(value: unknown): unknown {
    const references = new Map<number, unknown>();
    const objectValue = (value: unknown): Record<string, unknown> => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("PROFILE_INVALID");
      return value as Record<string, unknown>;
    };
    function visit(item: unknown, depth: number): unknown {
      if (depth > 32 || references.size > 50_000) throw new Error("PROFILE_COMPLEXITY_LIMIT");
      if (item === null || typeof item !== "object") return item;
      const row = objectValue(item);
      if (typeof row.ref === "number") {
        if (!references.has(row.ref)) throw new Error("PROFILE_INVALID");
        return references.get(row.ref);
      }
      if (typeof row.v === "string") {
        const values: Record<string, unknown> = { undefined, null: null, NaN, Infinity, "-Infinity": -Infinity, "-0": -0 };
        if (!Object.hasOwn(values, row.v)) throw new Error("PROFILE_INVALID");
        return values[row.v];
      }
      if (typeof row.bi === "string") return BigInt(row.bi);
      if (typeof row.d === "string") return new Date(row.d);
      if (row.r && typeof row.r === "object") {
        const regexp = objectValue(row.r);
        if (typeof regexp.p !== "string" || typeof regexp.f !== "string") throw new Error("PROFILE_INVALID");
        return new RegExp(regexp.p, regexp.f);
      }
      if (row.ab || row.ta) {
        const encoded = objectValue(row.ab || row.ta);
        if (typeof encoded.b !== "string") throw new Error("PROFILE_INVALID");
        const bytes = Uint8Array.from(atob(encoded.b), (character) => character.charCodeAt(0));
        if (row.ab) return bytes.buffer;
        const types: Record<string, (buffer: ArrayBuffer) => ArrayBufferView> = { i8: (b) => new Int8Array(b), ui8: (b) => new Uint8Array(b), ui8c: (b) => new Uint8ClampedArray(b), i16: (b) => new Int16Array(b), ui16: (b) => new Uint16Array(b), i32: (b) => new Int32Array(b), ui32: (b) => new Uint32Array(b), f32: (b) => new Float32Array(b), f64: (b) => new Float64Array(b), bi64: (b) => new BigInt64Array(b), bui64: (b) => new BigUint64Array(b) };
        if (typeof encoded.k !== "string" || !types[encoded.k]) throw new Error("PROFILE_INVALID");
        return types[encoded.k]!(bytes.buffer);
      }
      if (typeof row.id !== "number" || !Number.isInteger(row.id) || row.id < 1 || references.has(row.id)) throw new Error("PROFILE_INVALID");
      if (Array.isArray(row.a)) {
        const array: unknown[] = []; references.set(row.id, array);
        for (const entry of row.a) array.push(visit(entry, depth + 1));
        return array;
      }
      if (Array.isArray(row.m)) {
        const map = new Map<unknown, unknown>(); references.set(row.id, map);
        for (const entry of row.m) { const pair = objectValue(entry); map.set(visit(pair.k, depth + 1), visit(pair.v, depth + 1)); }
        return map;
      }
      if (Array.isArray(row.s)) {
        const set = new Set<unknown>(); references.set(row.id, set);
        for (const entry of row.s) set.add(visit(entry, depth + 1));
        return set;
      }
      if (Array.isArray(row.o)) {
        const object: Record<string, unknown> = {}; references.set(row.id, object);
        for (const value of row.o) {
          const entry = objectValue(value);
          if (typeof entry.k !== "string") throw new Error("PROFILE_INVALID");
          Object.defineProperty(object, entry.k, { value: visit(entry.v, depth + 1), enumerable: true, writable: true, configurable: true });
        }
        return object;
      }
      throw new Error("PROFILE_INVALID");
    }
    return visit(value, 0);
  }
  window.__helmProfileCodec = { encode, decode };
}

declare global {
  interface Window {
    __helmProfileCodec: { encode(value: unknown): unknown; decode(value: unknown): unknown };
    __helmProfileWrite(text: string): Promise<void>;
    __helmProfileDatabase?: IDBDatabase;
  }
}
