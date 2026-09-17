/** @module features/vault/status/VaultDisabled — the one "vault is off" panel for `/vault` and `/vault/log`: what the vault does, three steps to enable it */

import { Link } from '@tanstack/react-router';
import { buttonVariants } from '@/components/ui/button.tsx';
import { ICONS } from '@/lib/icons.ts';
import { docsUrl } from '@/lib/links.ts';

const STEPS = [
  {
    title: 'Start the server with a backend',
    body: (
      <>
        Add <code className="font-mono text-sm">--vault bitwarden</code>. The backend holds the
        secrets; BrowserHive only references entries by name.
      </>
    ),
  },
  {
    title: 'Unlock it on this page',
    body: (
      <>
        Run <code className="font-mono text-sm">bw unlock --raw</code> in your own terminal and
        paste the session token here, or start the server with{' '}
        <code className="font-mono text-sm">BW_SESSION</code> exported. BrowserHive never asks for
        your master password, and secrets are never displayed: only entry names, allowed origins and
        audit records.
      </>
    ),
  },
  {
    title: 'Decide what agents may fill',
    body: (
      <>
        Allow or reject a whole folder, or bind one item to the origins and session slugs it may
        fill. Turn on <code className="font-mono text-sm">dashboard_confirm</code> to approve each
        fill from here.
      </>
    ),
  },
];

/** Disabled panel. `page` tailors the opening sentence. */
export function VaultDisabled({ page = 'vault' }: { readonly page?: 'vault' | 'log' }) {
  const Lock = ICONS.lock;
  const External = ICONS.external;
  return (
    <section
      aria-labelledby="vault-off-title"
      className="flex flex-col gap-6 rounded-xl border bg-card p-6 shadow-xs sm:p-8 dark:shadow-none"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-vault-bg text-vault-text">
          <Lock aria-hidden="true" className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="vault-off-title" className="text-md font-semibold">
            Vault backend is off
          </h2>
          <p className="max-w-2xl text-base text-pretty text-muted-foreground">
            {page === 'log'
              ? 'Every vault_fill writes one secret-free audit row here: entry, outcome, origin check and page. '
              : 'The vault lets an agent fill a credential into a page without the secret ever passing through the model or this dashboard. '}
            No backend is attached to this daemon, so nothing can be filled yet.
          </p>
        </div>
      </div>
      <ol aria-label="Enable the vault" className="grid gap-4 md:grid-cols-3 sm:pl-14">
        {STEPS.map((step, index) => (
          <li key={step.title} className="flex gap-3 md:flex-col md:gap-2">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium tabular-nums dark:bg-white/[0.07]">
              {index + 1}
            </span>
            <div className="flex min-w-0 flex-col gap-0.5">
              <h3 className="text-base font-medium">{step.title}</h3>
              <p className="text-sm text-pretty text-muted-foreground">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2 sm:pl-14">
        {page === 'log' ? (
          <Link to="/vault" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
            Go to Vault
          </Link>
        ) : null}
        <a
          href={docsUrl('vault')}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ variant: page === 'log' ? 'ghost' : 'outline', size: 'sm' })}
        >
          Read the vault guide
          <External aria-hidden="true" />
        </a>
      </div>
    </section>
  );
}
