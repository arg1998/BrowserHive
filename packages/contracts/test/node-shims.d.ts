/** @module contracts/test/node-shims — minimal ambient types for the Node built-ins the test suites use (contracts keeps `types: []`) */
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readdirSync(path: string): string[];
  export function existsSync(path: string): boolean;
  export function statSync(path: string): { isDirectory(): boolean; isFile(): boolean };
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}
declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function resolve(...parts: string[]): string;
}
declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}
interface ImportMeta {
  readonly url: string;
  readonly dir: string;
  readonly path: string;
}
