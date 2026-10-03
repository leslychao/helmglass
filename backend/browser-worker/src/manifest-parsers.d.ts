declare module 'm3u8-parser' {
  export class Parser {
    constructor(options?: { url?: string });
    push(text: string): void;
    end(): void;
    manifest: unknown;
  }
}
declare module 'mpd-parser' {
  export function parse(text: string, options: { manifestUri: string }): unknown;
}
