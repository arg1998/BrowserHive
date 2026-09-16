/** @module infra/ids/ulid — small monotonic ULID (Crockford base32, 48-bit time + 80-bit entropy) with injected clock. */

/** Crockford base32 alphabet used by ULID (no I, L, O, U). */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Length of the time component. */
const TIME_LENGTH = 10;

/** Length of the random component. */
const RANDOM_LENGTH = 16;

/** Highest time value encodable in 48 bits. */
const MAX_TIME = 2 ** 48 - 1;

/** A ULID factory: mints the next 26-char Crockford base32 id, lexicographically time-sortable. */
export type UlidFactory = () => string;

/** Options for {@link createUlidFactory}. */
export interface UlidFactoryOptions {
  /** Epoch-ms source; injected so ids are deterministic in tests. */
  readonly now: () => number;
  /** Entropy source; defaults to `crypto.getRandomValues`. */
  readonly randomBytes?: (size: number) => Uint8Array;
}

/**
 * Builds a monotonic ULID factory: within one millisecond the 80-bit random component is
 * incremented instead of re-drawn, so ids minted in the same tick still sort in creation order.
 * If the clock goes backwards the last timestamp is reused, keeping the sequence monotonic.
 */
export function createUlidFactory(options: UlidFactoryOptions): UlidFactory {
  const randomBytes = options.randomBytes ?? defaultRandomBytes;
  let lastTime = -1;
  const lastRandom = new Uint8Array(10);

  return () => {
    const nowMs = Math.floor(options.now());
    const time = Math.min(Math.max(nowMs, 0), MAX_TIME);
    if (time <= lastTime) {
      incrementRandom(lastRandom);
    } else {
      lastTime = time;
      lastRandom.set(randomBytes(10));
    }
    return `${encodeTime(lastTime)}${encodeRandom(lastRandom)}`;
  };
}

/** True when `value` is a syntactically valid ULID (26 Crockford base32 chars, first ≤ `7`). */
export function isUlid(value: string): boolean {
  return /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
}

function defaultRandomBytes(size: number): Uint8Array {
  const out = new Uint8Array(size);
  crypto.getRandomValues(out);
  return out;
}

function incrementRandom(bytes: Uint8Array): void {
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    const next = ((bytes[i] ?? 0) + 1) & 0xff;
    bytes[i] = next;
    if (next !== 0) return;
  }
  // Wrapped around 2^80 within one millisecond: astronomically unlikely; fall through to zeros.
}

function encodeTime(time: number): string {
  let value = time;
  let out = '';
  for (let i = 0; i < TIME_LENGTH; i += 1) {
    out = `${ENCODING[value % 32] ?? '0'}${out}`;
    value = Math.floor(value / 32);
  }
  return out;
}

/** Encodes 80 bits (10 bytes) as 16 base32 characters, MSB first. */
function encodeRandom(bytes: Uint8Array): string {
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < RANDOM_LENGTH; i += 1) {
    out = `${ENCODING[Number(bits & 31n)] ?? '0'}${out}`;
    bits >>= 5n;
  }
  return out;
}
