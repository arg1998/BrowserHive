/** @module cli/invocation — `CliPlan`: the pure decision `planCli` reaches from argv before any side effect (spec 09 §3.3) */
import type { Channel } from '@browserhive/contracts/enums';
import type { ConfigFailure, ResolvedConfigBundle } from '@browserhive/core/config';
import type { ColorMode } from './output/style.ts';
import type { CommandName } from './registry.ts';

/** Exit codes of the CLI (spec 08 §7.3). */
export const EXIT = {
  ok: 0,
  fatal: 1,
  warnings: 2,
  policy: 3,
  usage: 64,
  interrupted: 130,
} as const;

/** One of {@link EXIT}. */
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Remote REST target for `admin tokens` (`--url` with a bearer or cookie). */
export interface RemoteTarget {
  readonly url: string;
  readonly token?: string;
  readonly cookie?: string;
}

/** A data directory resolved for `purge`, `db` and `admin`. */
export interface DataDirTarget {
  readonly dataDir: string;
}

/** What to run once planning succeeded. */
export type Invocation =
  | { readonly command: 'serve'; readonly resolved: ResolvedConfigBundle }
  | {
      readonly command: 'init';
      readonly resolved: ResolvedConfigBundle;
      readonly force: boolean;
      readonly skipBrowsers: boolean;
      readonly writeSchema: boolean;
      readonly channel: Channel | null;
      readonly installChrome: boolean;
      readonly yes: boolean;
    }
  | {
      readonly command: 'doctor';
      readonly json: boolean;
      /** `--printApparmorProfile`: print the profile for the configured browser and exit. */
      readonly printApparmorProfile: boolean;
      /** The resolver outcome; a failure is a ✗ check, not a usage error. */
      readonly resolution:
        | { readonly ok: true; readonly value: ResolvedConfigBundle }
        | { readonly ok: false; readonly error: ConfigFailure };
      /** The data directory used for disk and database checks (resolved even when config is invalid). */
      readonly dataDir: string;
    }
  | ({
      readonly command: 'purge';
      readonly all: boolean;
      readonly dryRun: boolean;
      readonly yes: boolean;
    } & DataDirTarget)
  | {
      readonly command: 'config-show';
      readonly json: boolean;
      readonly resolved: ResolvedConfigBundle;
    }
  | { readonly command: 'config-schema' }
  | { readonly command: 'config-validate'; readonly resolved: ResolvedConfigBundle }
  | ({ readonly command: 'db-status'; readonly json: boolean } & DataDirTarget)
  | ({ readonly command: 'db-backup'; readonly out: string | null } & DataDirTarget)
  | ({
      readonly command: 'db-restore';
      readonly file: string;
      readonly yes: boolean;
    } & DataDirTarget)
  | ({
      readonly command: 'db-migrate';
      readonly dryRun: boolean;
      readonly json: boolean;
    } & DataDirTarget)
  | ({ readonly command: 'admin-reset-password'; readonly json: boolean } & DataDirTarget)
  | ({
      readonly command: 'admin-tokens-list';
      readonly json: boolean;
      readonly remote: RemoteTarget | null;
    } & DataDirTarget)
  | ({
      readonly command: 'admin-tokens-create';
      readonly principal: string;
      readonly expiresInMs: number | null;
      readonly json: boolean;
      readonly remote: RemoteTarget | null;
    } & DataDirTarget)
  | ({
      readonly command: 'admin-tokens-revoke';
      readonly principal: string;
      readonly json: boolean;
      readonly remote: RemoteTarget | null;
    } & DataDirTarget)
  | { readonly command: 'version'; readonly json: boolean };

/** Help topic: the whole CLI, one command, or one subcommand. */
export interface HelpTopic {
  readonly command: CommandName | null;
  readonly subcommand: readonly string[] | null;
}

/** The planner's decision. */
export type CliPlan =
  | { readonly kind: 'help'; readonly topic: HelpTopic; readonly color: ColorMode }
  | { readonly kind: 'version'; readonly json: boolean; readonly color: ColorMode }
  | {
      /** Terminate with `lines` on stderr (usage errors, policy refusals). */
      readonly kind: 'exit';
      readonly code: ExitCode;
      readonly lines: readonly string[];
    }
  | {
      readonly kind: 'run';
      readonly invocation: Invocation;
      readonly color: ColorMode;
      /** `true` when the invocation serves stdio: all CLI output goes to stderr. */
      readonly stdio: boolean;
    };
