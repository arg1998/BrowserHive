/** @module features/system/tokens/TokensSection — System › Agent tokens: how agents authenticate (and whether auth is on), create (plaintext shown once), list, revoke with confirm; operator-only (403 renders a disabled explanation) (docs/guide/security.md, spec 03 §4.1) */
import type { AuthMode } from '@browserhive/contracts/enums';
import type { ApiTokenSummary, CreateTokenResponse } from '@browserhive/contracts/http';
import { useCallback, useState } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { DataPanel } from '@/components/shared/DataPanel.tsx';
import { EmptyState } from '@/components/shared/EmptyState.tsx';
import { Panel } from '@/components/shared/Section.tsx';
import { SkeletonKv } from '@/components/shared/Skeletons.tsx';
import { formatNumber } from '@/lib/format/bytes.ts';
import { ICONS } from '@/lib/icons.ts';
import { docsUrl } from '@/lib/links.ts';
import { isForbidden, useCreateToken, useRevokeToken, useTokens } from './api.ts';
import { CreateTokenForm } from './CreateTokenForm.tsx';
import { type CreatedToken, TokenCreatedDialog } from './TokenCreatedDialog.tsx';
import { TokenTable } from './TokenTable.tsx';

/** Props. */
export interface TokensSectionProps {
  /** Origin for the snippets; defaults to {@link agentOrigin}. */
  readonly origin?: string;
  /** `/system.auth_mode`, when known: `off` explains that tokens are not enforced yet. */
  readonly authMode?: AuthMode | undefined;
  /** `/system` bind address, used under the Vite dev server (whose port is not the daemon's). */
  readonly daemon?: { readonly host: string; readonly port: number } | undefined;
}

/**
 * Where agents should reach `/mcp`. In the built dashboard that is the page's own origin (it may sit
 * behind a proxy, so the bind address is not authoritative). Under the Vite dev server the page is on
 * Vite's port, so snippets point at the daemon's bind address instead.
 */
export function agentOrigin(
  pageOrigin: string,
  daemon: { readonly host: string; readonly port: number } | undefined,
  dev: boolean,
): string {
  if (!dev || daemon === undefined) return pageOrigin;
  const host = daemon.host === '0.0.0.0' || daemon.host === '::' ? '127.0.0.1' : daemon.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${daemon.port}`;
}

function Mono({ children }: { readonly children: string }) {
  return <code className="font-mono text-sm">{children}</code>;
}

/** Tokens section. */
export function TokensSection({ origin, authMode, daemon }: TokensSectionProps) {
  const snippetOrigin = origin ?? agentOrigin(window.location.origin, daemon, import.meta.env.DEV);
  const tokens = useTokens();
  const confirm = useConfirm();
  const revoke = useRevokeToken();
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const onCreated = useCallback(
    (response: CreateTokenResponse, display: string) =>
      setCreated({ credentialId: response.credential_id, token: response.token, display }),
    [],
  );
  const create = useCreateToken(onCreated);
  const forbidden = isForbidden(tokens.error);

  const close = () => {
    setCreated(null);
    create.forget();
  };

  const onRevoke = async (token: ApiTokenSummary) => {
    const ok = await confirm({
      title: 'Revoke token?',
      description: `The token ${token.public_prefix}… for ${token.subject} stops working immediately. Agents using it get HTTP 401 on their next request.`,
      confirmLabel: 'Revoke',
      danger: true,
    });
    if (ok) revoke.mutate(token.credential_id);
  };

  const count = tokens.data?.data.length;
  return (
    <div className="flex flex-col gap-6">
      {authMode === 'off' ? (
        <Callout tone="info" title="Agent authentication is off">
          This daemon serves <Mono>/mcp</Mono> without a token. Tokens you create here take effect
          once it runs with <Mono>--auth token</Mono>.
        </Callout>
      ) : null}
      <Panel
        title={
          <span className="flex items-center gap-2">
            Agent tokens
            {count !== undefined && count > 0 ? (
              <span className="rounded-full bg-muted px-2 text-xs leading-5 font-medium text-muted-foreground tabular-nums dark:bg-white/[0.07]">
                {formatNumber(count)}
              </span>
            ) : null}
          </span>
        }
        description={
          <>
            Agents send <Mono>Authorization: Bearer &lt;token&gt;</Mono> to <Mono>/mcp</Mono>.
            Create one token per agent and revoke it when the agent is retired.
          </>
        }
        info={
          <>
            <p>
              Tokens only matter when the daemon runs with <code>--auth token</code>, which a
              non-loopback bind requires. Each token is shown once when it is created; store it in
              the agent's MCP client configuration.
            </p>
            <p>Revoking a token rejects the agent's next request.</p>
          </>
        }
        infoDocs="agentTokens"
        padding="none"
      >
        {forbidden ? (
          <EmptyState
            kind="not-enabled"
            title="Token management needs an operator"
            description="You are signed in with a credential that cannot list or issue API tokens. Sign in to the dashboard with the operator password, or use browserhive admin tokens on the server."
            size="sm"
          />
        ) : (
          <>
            <div className="px-5 pt-1 pb-5">
              <CreateTokenForm
                pending={create.isPending}
                disabled={tokens.isError}
                onCreate={(display, done) => create.create(display, { onSuccess: done })}
              />
            </div>
            <DataPanel
              query={tokens}
              skeleton={
                <div className="border-t px-5 py-4">
                  <SkeletonKv count={3} />
                </div>
              }
              empty={
                // One line: the panel description and the form hint already explain the header and
                // the principal.
                <p className="flex items-start gap-2 border-t px-5 py-3.5 text-base text-muted-foreground">
                  <ICONS.lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  <span>
                    No agent tokens yet. The{' '}
                    <a
                      href={docsUrl('agentTokens')}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-accent-text underline-offset-4 hover:underline"
                    >
                      MCP clients guide
                    </a>{' '}
                    shows where an agent puts one.
                  </span>
                </p>
              }
            >
              {(data) => <TokenTable tokens={data.data} onRevoke={(t) => void onRevoke(t)} />}
            </DataPanel>
          </>
        )}
      </Panel>
      <TokenCreatedDialog created={created} origin={snippetOrigin} onClose={close} />
    </div>
  );
}
