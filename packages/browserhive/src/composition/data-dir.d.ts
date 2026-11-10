/** @module composition/data-dir — creates the D-24 layout with owner-only permissions. */
/** Owner-only directory mode (D-24). */
export declare const DATA_DIR_MODE = 448;
/** Subdirectories created at boot (D-24). */
export declare const DATA_SUBDIRS: readonly [
  'backups',
  'admin',
  'sessions',
  'auth-states',
  'uploads',
];
/** Resolved paths of the layout. */
export interface DataDirLayout {
  readonly root: string;
  readonly database: string;
  readonly backups: string;
  readonly admin: string;
  readonly sessions: string;
  readonly authStates: string;
  readonly uploads: string;
}
/** Paths of the D-24 layout under `root`. */
export declare function dataDirLayout(root: string): DataDirLayout;
/** The filesystem calls {@link ensureDataDir} makes (injectable for tests). */
export interface DataDirFs {
  existsSync(path: string): boolean;
  mkdirSync(
    path: string,
    options: {
      recursive: true;
      mode: number;
    },
  ): unknown;
  chmodSync(path: string, mode: number): void;
}
/** Options of {@link ensureDataDir}. */
export interface EnsureDataDirOptions {
  /** Called when a created directory could not be narrowed to 0700 (boot continues). */
  readonly onChmodFailed?: (dir: string, err: unknown) => void;
  readonly fs?: DataDirFs;
}
/**
 * Creates the data directory and its subdirectories with mode 0700. A directory created here is
 * chmod-ed explicitly (the umask may widen `mkdir`'s mode); existing directories keep their mode.
 *
 * The chmod is best effort, like the database file's: filesystems that reject mode changes
 * (CIFS/SMB shares, some container bind mounts, Windows) must not stop the server from booting.
 * The failure is reported through `onChmodFailed`, and `browserhive doctor` flags the mode.
 * Failing to create a directory is still fatal.
 *
 * @throws `DATA_DIR_UNWRITABLE`
 */
export declare function ensureDataDir(root: string, options?: EnsureDataDirOptions): DataDirLayout;
//# sourceMappingURL=data-dir.d.ts.map
