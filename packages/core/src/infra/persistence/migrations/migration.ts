/** @module infra/persistence/migrations/migration — the shape of one forward-only migration (D-04). */

/** One embedded, parameter-free migration. */
export interface Migration {
  /** Monotonic schema version this migration produces. */
  readonly version: number;
  /** Short kebab-case name for the audit row and backup file. */
  readonly name: string;
  /**
   * True when purely additive: older binaries can still read the resulting schema, so
   * `meta.min_reader_version` is not bumped.
   */
  readonly compatible: boolean;
  /** Multi-statement SQL executed with `db.exec` inside one transaction. */
  readonly sql: string;
}
