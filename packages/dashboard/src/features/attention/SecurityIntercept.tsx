/** @module features/attention/SecurityIntercept — `security_intercept` requests on `/attention` (spec 13 §9.3, §9.5, §11.4 UI vocabulary): "Site check" (a challenge) or "Write approval" (a write a site pack holds), their facts as plain text (site, guard and its kind, the challenge, method and sanitized URL, the tool), never as markup or a link; options are parsed with `SecurityInterceptOptions`, never cast */
import { type OperatorRequestRow, SecurityInterceptOptions } from '@browserhive/contracts/http';
import type { StatusEntry } from '@/lib/status-registry.ts';

/** Parsed options of a security intercept, or `null` for any other request (or a malformed one). */
export function interceptOf(
  row: Pick<OperatorRequestRow, 'kind' | 'options'>,
): SecurityInterceptOptions | null {
  if (row.kind !== 'security_intercept') return null;
  const parsed = SecurityInterceptOptions.safeParse(row.options);
  return parsed.success ? parsed.data : null;
}

/** The request's label: Site check or Write approval. */
export function interceptBadge(options: SecurityInterceptOptions): StatusEntry {
  return options.reason === 'challenge'
    ? {
        label: 'Site check',
        tone: 'warn',
        icon: 'warn',
        hint: 'The site showed a page only a person can clear. Take over, clear it, then Resolve.',
      }
    : {
        label: 'Write approval',
        tone: 'vault',
        icon: 'lock',
        hint: 'A site pack holds this request until you approve or deny it.',
      };
}

const GUARD_KIND: {
  readonly [K in NonNullable<SecurityInterceptOptions['guard']>['kind']]: string;
} = {
  logout: 'sign-out',
  account: 'account and security',
  credential: 'credentials and keys',
  destructive: 'destructive',
  write: 'write',
};

const CHALLENGE_KIND: {
  readonly [K in NonNullable<SecurityInterceptOptions['challenge']>['kind']]: string;
} = {
  checkpoint: 'Checkpoint',
  captcha: 'Captcha',
  reauth: 'Sign in again',
  locked: 'Account locked',
  rejected: 'Sign-in refused',
};

/** `true`: only `/attention` can decide it (guards of kinds other than `write`, spec 13 §9.3). */
export function onlyDecidedHere(options: SecurityInterceptOptions): boolean {
  return (
    options.reason === 'write_confirm' &&
    options.guard !== undefined &&
    options.guard.kind !== 'write'
  );
}

/** The facts rows (inside the card's `<dl>`). */
export function InterceptFacts({
  options,
  pageUrl = null,
}: {
  readonly options: SecurityInterceptOptions;
  /** The request's page: a site check's address equal to it is not repeated. */
  readonly pageUrl?: string | null;
}) {
  return (
    <>
      <dt className="text-muted-foreground">Site</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">
        {options.site_title}
        {options.site_title !== options.site ? (
          <span className="text-muted-foreground"> · {options.site}</span>
        ) : null}
      </dd>
      {options.guard !== undefined ? (
        <>
          <dt className="text-muted-foreground">Guard</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">
            <span className="font-mono text-sm">{options.guard.id}</span>
            <span className="text-muted-foreground"> · {GUARD_KIND[options.guard.kind]}</span>
          </dd>
        </>
      ) : null}
      {options.challenge !== undefined ? (
        <>
          <dt className="text-muted-foreground">Check</dt>
          <dd className="min-w-0">
            {CHALLENGE_KIND[options.challenge.kind]}
            {options.challenge.action === 'stop' ? (
              <span className="text-muted-foreground"> · the site stays stopped until cleared</span>
            ) : null}
          </dd>
        </>
      ) : null}
      {options.url !== undefined && !(options.method === undefined && options.url === pageUrl) ? (
        <>
          <dt className="text-muted-foreground">Request</dt>
          <dd className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">
            {options.method !== undefined ? (
              <span className="font-semibold">{options.method} </span>
            ) : null}
            {options.url}
          </dd>
        </>
      ) : null}
      {options.tool !== undefined ? (
        <>
          <dt className="text-muted-foreground">Tool</dt>
          <dd className="min-w-0 font-mono text-sm">{options.tool}</dd>
        </>
      ) : null}
    </>
  );
}
