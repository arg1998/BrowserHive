/** @module ports/id-generator — identifier minting capability (D-23 id formats). */

/**
 * Mints every identifier that crosses a boundary. The production adapter is the only
 * `nanoid`/ULID call site outside tests.
 */
export interface IdGenerator {
  /** `<slug>-<nanoid8>`; the slug is already sanitized by the caller. */
  sessionId(slug: string): string;
  /** `t-<nanoid6>` */
  tabId(): string;
  /** `e-<ulid>` — time-sortable. */
  eventId(): string;
  /** `a-<nanoid12>` — operator requests (attention, vault confirm). */
  operatorRequestId(): string;
  /** Generic opaque id of `size` URL-safe characters (tokens, connection ids, request ids). */
  opaque(size: number): string;
}
