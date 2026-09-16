/** @module ports/static-assets — read-only asset providers for the dashboard SPA bundle and the Playwright trace viewer (spec 03 §8). */

/** One servable file. `bytes` is the identity encoding; pre-compressed variants are optional. */
export interface StaticAsset {
  /** Published path relative to the bundle root (`assets/app-abc123.js`). */
  readonly path: string;
  readonly contentType: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
  /** Strong ETag derived from the content. */
  readonly etag: string;
  /** True for content-hashed files that may be cached forever. */
  readonly immutable: boolean;
  /** Pre-compressed siblings (`<path>.gz`, `<path>.br`) when the bundle ships them. */
  readonly encodings?: {
    readonly gzip?: Uint8Array<ArrayBuffer>;
    readonly br?: Uint8Array<ArrayBuffer>;
  };
}

/** The dashboard SPA bundle. `null` from every method when no bundle is installed. */
export interface StaticAssets {
  /** True when a bundle directory with an `index.html` was found. */
  readonly available: boolean;
  /** The raw `index.html` template (templated per request by the SPA server), or `null`. */
  indexHtml(): Promise<string | null>;
  /** A bundle file by published path (no leading slash), or `null` when it does not exist. */
  get(path: string): Promise<StaticAsset | null>;
}

/** The Playwright trace viewer bundle located from `playwright-core` at runtime. */
export interface TraceViewerAssets {
  /** True when the viewer bundle was found on disk. */
  readonly available: boolean;
  /** A viewer file by path relative to the viewer root, or `null`. */
  get(path: string): Promise<StaticAsset | null>;
}

/** Facts about a file on disk. */
export interface FileFacts {
  readonly size: number;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

/** Artifact files (traces, screenshots, session dirs) read through this seam. */
export interface ArtifactFiles {
  stat(path: string): Promise<FileFacts | null>;
  read(path: string): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Streams `[start, end]` (inclusive) or the whole file. */
  stream(
    path: string,
    range?: { readonly start: number; readonly end: number },
  ): ReadableStream<Uint8Array>;
  /** Total bytes under a path (recursive); 0 when missing. */
  sizeOf(path: string): Promise<number>;
}
