/** @module cli/invocation — `CliPlan`: the pure decision `planCli` reaches from argv before any side effect (spec 09 §3.3) */
import type { Channel, TemplateReloginMethod } from '@browserhive/contracts/enums';
import type { TemplateInput } from '@browserhive/contracts/http';
import type {
  PreviewSample,
  StartupNotificationChannel,
} from '@browserhive/contracts/notifications';
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
  | {
      readonly command: 'serve';
      readonly resolved: ResolvedConfigBundle;
      /** `--notificationChannel` values, parsed (spec 08 §5.7). */
      readonly startupChannels: readonly StartupNotificationChannel[];
      /** Warnings of the channel flags (a literal ntfy.sh topic), logged at boot. */
      readonly channelWarnings: readonly string[];
    }
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
      /** Raw `--notificationChannel` values (checked by the doctor, never a usage error there). */
      readonly notificationChannels: readonly string[];
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
  | {
      readonly command: 'channels-list';
      readonly json: boolean;
      readonly remote: RemoteTarget;
    }
  | {
      readonly command: 'channels-test';
      readonly name: string;
      readonly json: boolean;
      readonly remote: RemoteTarget;
    }
  | {
      readonly command: 'channels-preview';
      readonly name: string;
      readonly sample: PreviewSample;
      readonly json: boolean;
      readonly remote: RemoteTarget;
    }
  | {
      readonly command: 'templates-list';
      readonly json: boolean;
      readonly remote: RemoteTarget;
    }
  | {
      readonly command: 'templates-create';
      readonly name: string;
      /** The `POST /templates` body built from the flags. */
      readonly input: TemplateInput;
      /** `--noLogin`: create and exit without opening a sign-in window. */
      readonly noLogin: boolean;
      /** `--timeout` in milliseconds (default 30 min). */
      readonly timeoutMs: number;
      /** `--fromState <file>` (absolute): seed from a storage state instead of a sign-in window. */
      readonly fromState: string | null;
      /** `--yes`: approve the sites' site packs without asking (spec 13 §9.6 first use). */
      readonly yes: boolean;
      readonly json: boolean;
      readonly remote: RemoteTarget;
    }
  | {
      readonly command: 'templates-finish';
      readonly name: string;
      readonly json: boolean;
      readonly remote: RemoteTarget;
    }
  | {
      readonly command: 'templates-rm';
      readonly name: string;
      readonly force: boolean;
      readonly yes: boolean;
      readonly json: boolean;
      readonly remote: RemoteTarget;
    }
  | ({ readonly command: 'templates-show' } & TemplateTarget)
  | ({
      readonly command: 'templates-seed';
      /** The storage-state file, absolute. */
      readonly file: string;
      readonly yes: boolean;
    } & TemplateTarget)
  | ({ readonly command: 'templates-versions' } & TemplateTarget)
  | ({ readonly command: 'templates-save' } & TemplateTarget)
  | ({
      readonly command: 'templates-restore';
      /** A version number, or `latest` (the rolling checkpoint). */
      readonly version: number | 'latest';
      readonly forceClose: boolean;
      readonly yes: boolean;
    } & TemplateTarget)
  | ({
      readonly command: 'templates-host';
      readonly action: TemplateHostAction;
    } & TemplateTarget)
  | ({
      readonly command: 'templates-clipboard';
      /** `deny` (true) or `allow` (false): the "Deny clipboard writes" switch (D18). */
      readonly deny: boolean;
    } & TemplateTarget)
  | ({ readonly command: 'templates-disable' } & TemplateTarget)
  | ({ readonly command: 'templates-enable' } & TemplateTarget)
  | ({
      readonly command: 'templates-login';
      /** `--site`: the site to sign in to again (a registrable domain, lower-cased). */
      readonly site: string;
      /** `--method`: a window on the server's machine (default), or a fill with the linked vault binding. */
      readonly method: TemplateReloginMethod;
      /** `--timeout` in milliseconds (default 30 min): how long the command waits. */
      readonly timeoutMs: number;
      /** `--letAgentsContinue`: do not pause the template's agents while the window is open. */
      readonly letAgentsContinue: boolean;
    } & TemplateTarget)
  | ({
      readonly command: 'templates-probe';
      /** `--site`: check only this site; `null` checks every enabled site. */
      readonly site: string | null;
    } & TemplateTarget)
  | ({
      readonly command: 'templates-rekey';
      /** The variable that holds the old key (never the key itself). */
      readonly oldKeyEnv: string;
      /** `templateKey` as resolved (environment, reference, file or flag), else `null`. */
      readonly templateKey: string | null;
      /** `templateKeyPrevious` as resolved, else `null`. */
      readonly templateKeyPrevious: string | null;
      readonly json: boolean;
    } & DataDirTarget)
  | {
      readonly command: 'sitepacks';
      readonly action: SitePacksAction;
      readonly json: boolean;
      readonly remote: RemoteTarget;
    }
  | {
      /** `sitepacks verify <path>`: offline, no server (spec 13 §11.5). */
      readonly command: 'sitepacks-verify';
      /** Absolute path of the pack file. */
      readonly path: string;
      readonly json: boolean;
    }
  | { readonly command: 'version'; readonly json: boolean };

/** `?source=` of `sitepacks list` (`registry` is the remote source). */
export type SitePacksSource = 'local' | 'registry' | 'bundled' | 'import';

/**
 * One `sitepacks` subcommand over the REST API (spec 13 §11.5). `version: null` on `apply` and
 * `reject` takes the single pending version; `to: null` on `diff` takes the single pending version
 * or the local file waiting for approval. `sitepacks verify` is offline and is its own invocation.
 */
export type SitePacksAction =
  | {
      readonly kind: 'list';
      readonly sources: readonly SitePacksSource[];
      readonly pending: boolean;
    }
  | { readonly kind: 'show'; readonly packId: string }
  | { readonly kind: 'diff'; readonly packId: string; readonly to: number | 'local' | null }
  | {
      readonly kind: 'apply';
      readonly packId: string;
      readonly version: number | null;
      readonly yes: boolean;
    }
  | { readonly kind: 'reject'; readonly packId: string; readonly version: number | null }
  | { readonly kind: 'revert'; readonly packId: string; readonly yes: boolean }
  | { readonly kind: 'pin'; readonly packId: string; readonly version: number }
  | { readonly kind: 'unpin'; readonly packId: string }
  | { readonly kind: 'follow'; readonly packId: string; readonly follow: boolean | null }
  | { readonly kind: 'approve-local'; readonly packId: string; readonly yes: boolean }
  | { readonly kind: 'enable'; readonly packId: string }
  | { readonly kind: 'disable'; readonly packId: string; readonly yes: boolean }
  | { readonly kind: 'reload' }
  | {
      readonly kind: 'import';
      /** The file or folder, absolute. */
      readonly path: string;
    };

/** The template a `templates` subcommand acts on, by name, over the REST API. */
export interface TemplateTarget {
  readonly name: string;
  readonly json: boolean;
  readonly remote: RemoteTarget;
}

/** `templates host <name> start|stop|restart`. */
export const TEMPLATE_HOST_ACTIONS = ['start', 'stop', 'restart'] as const;
/** One of {@link TEMPLATE_HOST_ACTIONS}. */
export type TemplateHostAction = (typeof TEMPLATE_HOST_ACTIONS)[number];

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
