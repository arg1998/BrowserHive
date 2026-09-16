/** @module kernel/redact — redaction pipeline: key heuristics, value patterns and the windowed SecretRegistry (spec 10 §9, D-20). */

import { isSecret, SECRET_PLACEHOLDER } from './secret.ts';

/** Placeholder written in place of a redacted value or literal. */
export const REDACTED = '[REDACTED]';

/** Marker written for a subtree deeper than the depth cap. */
export const TRUNCATED = '[TRUNCATED]';

/** Marker written for an object already visited on the current walk. */
export const CIRCULAR = '[CIRCULAR]';

/** Literals shorter than this are ignored: redacting `a` would erase every log line. */
export const MIN_SECRET_LENGTH = 3;

/**
 * Case-insensitive substrings that mark a key as credential-bearing. Deliberately broad — a false
 * positive only hides a field from a log line, which is the safe failure direction.
 * Includes `passphrase` (vault unlock) and `set-cookie` (response headers).
 */
export const SENSITIVE_KEY_PATTERNS: readonly string[] = [
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'api_key',
  'apikey',
  'authorization',
  'auth_token',
  'cookie',
  'credential',
  'private_key',
  'master',
];

/** True when `key` looks credential-bearing under {@link SENSITIVE_KEY_PATTERNS}. */
export function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase();
  return SENSITIVE_KEY_PATTERNS.some((p) => k.includes(p));
}

/**
 * Deep-clones `value`, replacing any sensitive-keyed value with {@link REDACTED} and any
 * `Secret<T>` with its placeholder. Primitives pass through. Arrays are walked element-wise.
 * Guards against cycles and caps depth so a pathological payload cannot blow the stack.
 */
export function redactKeys(value: unknown, maxDepth = 8): unknown {
  return walk(value, maxDepth, new WeakSet());
}

function walk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (isSecret(value)) return SECRET_PLACEHOLDER;
  if (value === null || typeof value !== 'object') return value;
  if (depth <= 0) return TRUNCATED;
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => walk(v, depth - 1, seen));
  }
  if (value instanceof Error) {
    // Errors are serialized by `serializeError`; here we only avoid dropping them silently.
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k) ? REDACTED : walk(v, depth - 1, seen);
  }
  return out;
}

/**
 * Free-text shapes that are credentials regardless of the key they sit under. Kept narrow to avoid
 * shredding ordinary prose: bearer/basic authorization values and URL userinfo.
 */
export const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
];

/** Replaces every {@link SECRET_VALUE_PATTERNS} match in `text` with {@link REDACTED}. */
export function scrubPatterns(text: string): string {
  let out = text;
  const [auth, userinfo] = SECRET_VALUE_PATTERNS;
  if (auth !== undefined) out = out.replace(auth, (_m, scheme: string) => `${scheme} ${REDACTED}`);
  if (userinfo !== undefined) {
    out = out.replace(userinfo, (_m, scheme: string) => `${scheme}${REDACTED}@`);
  }
  return out;
}

/** Upper bound on scrub passes; a replacement can expose a literal that straddled a boundary. */
const MAX_SCRUB_PASSES = 4;

interface SecretWindow {
  readonly secrets: Set<string>;
  expiresAt: number;
}

/** Constructor options for {@link SecretRegistry}. */
export interface SecretRegistryOptions {
  /** Injected clock read (`clock.now`). Windows expire lazily against it. */
  readonly now: () => number;
}

/**
 * The set of secret literals that must never reach a sink. Two populations:
 *
 * - **always-on** entries ({@link SecretRegistry.add}): tokens, seed passwords, OTLP headers —
 *   registered at birth and released explicitly;
 * - **windowed** entries ({@link SecretRegistry.openWindow}): a per-session set with an expiry,
 *   ref-counted so two sessions sharing a literal do not unredact each other's output.
 *
 * `scrub` replaces every active literal, longest first, repeating until no literal survives.
 */
export class SecretRegistry {
  private readonly now: () => number;
  private readonly alwaysOn = new Set<string>();
  private readonly windows = new Map<string, SecretWindow>();
  /** Ref-count of each windowed literal across all open windows. */
  private readonly refs = new Map<string, number>();

  constructor(options: SecretRegistryOptions) {
    this.now = options.now;
  }

  /** Registers an always-on literal. Ignored when shorter than {@link MIN_SECRET_LENGTH}. */
  add(secret: string): void {
    if (secret.length >= MIN_SECRET_LENGTH) this.alwaysOn.add(secret);
  }

  /** Removes an always-on literal (a revoked token). Windowed copies are unaffected. */
  delete(secret: string): void {
    this.alwaysOn.delete(secret);
  }

  /** Drops every always-on literal and closes every window. */
  clear(): void {
    this.alwaysOn.clear();
    this.windows.clear();
    this.refs.clear();
  }

  /** Number of distinct active literals (always-on plus unexpired windows). */
  size(): number {
    return this.activeLiterals().length;
  }

  /** True when `literal` is currently active through either population. */
  has(literal: string): boolean {
    return this.activeLiterals().includes(literal);
  }

  /**
   * Opens (or re-arms) the window for `sessionId`, covering `secrets` until `now + ttlMs`.
   * Re-arming extends the deadline and unions the secret set.
   */
  openWindow(sessionId: string, secrets: readonly string[], ttlMs: number): void {
    const meaningful = secrets.filter((s) => s.length >= MIN_SECRET_LENGTH);
    if (meaningful.length === 0) return;
    const existing = this.windows.get(sessionId);
    const set = existing?.secrets ?? new Set<string>();
    for (const s of meaningful) {
      if (!set.has(s)) {
        set.add(s);
        this.refs.set(s, (this.refs.get(s) ?? 0) + 1);
      }
    }
    this.windows.set(sessionId, { secrets: set, expiresAt: this.now() + ttlMs });
  }

  /** Closes the window for `sessionId`, releasing its literals. Idempotent. */
  closeWindow(sessionId: string): void {
    const win = this.windows.get(sessionId);
    if (win === undefined) return;
    for (const s of win.secrets) {
      const count = this.refs.get(s) ?? 0;
      if (count <= 1) this.refs.delete(s);
      else this.refs.set(s, count - 1);
    }
    this.windows.delete(sessionId);
  }

  /** Closes every window (shutdown, test teardown). */
  closeAllWindows(): void {
    for (const id of [...this.windows.keys()]) this.closeWindow(id);
  }

  /** True when `sessionId` has an unexpired window. Expired windows are closed on the way. */
  isWindowOpen(sessionId: string): boolean {
    const win = this.windows.get(sessionId);
    if (win === undefined) return false;
    if (this.now() > win.expiresAt) {
      this.closeWindow(sessionId);
      return false;
    }
    return true;
  }

  /** Expiry (epoch ms) of the session's window, or `undefined` when none is open. */
  windowExpiresAt(sessionId: string): number | undefined {
    return this.isWindowOpen(sessionId) ? this.windows.get(sessionId)?.expiresAt : undefined;
  }

  /**
   * Replaces every active literal in `text` with {@link REDACTED}. Returns `text` unchanged when
   * nothing is registered (the hot path is a size check).
   */
  scrub(text: string): string {
    const literals = this.activeLiterals();
    if (literals.length === 0 || text.length === 0) return text;
    let out = text;
    for (let pass = 0; pass < MAX_SCRUB_PASSES; pass += 1) {
      let changed = false;
      for (const literal of literals) {
        if (out.includes(literal)) {
          out = out.split(literal).join(REDACTED);
          changed = true;
        }
      }
      if (!changed) break;
    }
    return out;
  }

  /** Deep variant of {@link SecretRegistry.scrub}: every string leaf of `value` is scrubbed. */
  scrubValue(value: unknown, maxDepth = 8): unknown {
    if (this.size() === 0) return value;
    return this.scrubWalk(value, maxDepth, new WeakSet());
  }

  private scrubWalk(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (typeof value === 'string') return this.scrub(value);
    if (value === null || typeof value !== 'object') return value;
    if (depth <= 0) return TRUNCATED;
    if (seen.has(value)) return CIRCULAR;
    seen.add(value);
    if (Array.isArray(value)) return value.map((v) => this.scrubWalk(v, depth - 1, seen));
    if (value instanceof Error) return value;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = this.scrubWalk(v, depth - 1, seen);
    return out;
  }

  /** Active literals, longest first, with expired windows closed lazily. */
  private activeLiterals(): string[] {
    const now = this.now();
    for (const [id, win] of [...this.windows]) {
      if (now > win.expiresAt) this.closeWindow(id);
    }
    const all = new Set<string>(this.alwaysOn);
    for (const literal of this.refs.keys()) all.add(literal);
    return [...all].sort((a, b) => b.length - a.length);
  }
}

/** The two redaction operations every sink applies, bundled for injection. */
export interface Redactor {
  /** Scrubs registered literals and credential-shaped patterns from free text. */
  scrubText(text: string): string;
  /** Applies key heuristics, `Secret` placeholders and literal scrubbing to structured fields. */
  redactValue(value: unknown): unknown;
}

/**
 * Builds a {@link Redactor} over `registry` (omit for a key-and-pattern-only redactor in tests).
 */
export function createRedactor(registry?: SecretRegistry): Redactor {
  return {
    scrubText(text) {
      const scrubbed = registry === undefined ? text : registry.scrub(text);
      return scrubPatterns(scrubbed);
    },
    redactValue(value) {
      const keyed = redactKeys(value);
      return registry === undefined ? keyed : registry.scrubValue(keyed);
    },
  };
}
