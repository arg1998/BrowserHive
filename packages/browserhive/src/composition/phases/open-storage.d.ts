/** @module composition/phases/open-storage — phase 3: D-24 data dir (0700), the lock file, `openDatabase` (backups, migrations, compat window), unit of work, write queue, analytics, maintenance, durable log sink. */
import { type BootContext } from '../context.ts';
import type { PhaseHandle } from '../unwind.ts';
/** Phase `open-storage`. Errors (`DATA_DIR_LOCKED`, `DB_NEWER_THAN_BINARY`, `MIGRATION_FAILED`, …) propagate typed. */
export declare function openStoragePhase(ctx: BootContext): Promise<PhaseHandle>;
/** `select sqlite_version()` over the raw handle; `unknown` when the query fails. */
export declare function sqliteVersionOf(raw: {
  query(sql: string): {
    get(): unknown;
  };
}): string;
//# sourceMappingURL=open-storage.d.ts.map
