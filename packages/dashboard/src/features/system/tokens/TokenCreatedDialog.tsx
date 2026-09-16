/** @module features/system/tokens/TokenCreatedDialog — the one and only display of a new token's plaintext, with copyable MCP client config and curl snippets; closing hands control back so the caller drops the secret */
import { useId } from 'react';
import { Callout } from '@/components/shared/Callout.tsx';
import { CopyButton } from '@/components/shared/CopyButton.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { curlSnippet, mcpConfigSnippet } from './snippets.ts';

/** A freshly issued token (plaintext) and the name it was issued for. */
export interface CreatedToken {
  readonly credentialId: string;
  readonly display: string;
  readonly token: string;
}

/** Props. */
export interface TokenCreatedDialogProps {
  /** `null` = closed; the plaintext lives only here. */
  readonly created: CreatedToken | null;
  /** Origin the dashboard (and `/mcp`) is served from. */
  readonly origin: string;
  readonly onClose: () => void;
}

function Snippet({ title, value, label }: { title: string; value: string; label: string }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 id={id} className="text-sm font-medium">
          {title}
        </h3>
        <CopyButton value={value} label={label} visibility="always" />
      </div>
      <pre className="rounded-lg bg-muted px-3 py-2.5 font-mono text-sm [overflow-wrap:anywhere] whitespace-pre-wrap dark:bg-white/[0.04]">
        {value}
      </pre>
    </section>
  );
}

/** Token created dialog. */
export function TokenCreatedDialog({ created, origin, onClose }: TokenCreatedDialogProps) {
  return (
    <Dialog open={created !== null} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-2xl" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Token created</DialogTitle>
          <DialogDescription>
            {created !== null ? `Agent token for ${created.display}.` : ''}
          </DialogDescription>
        </DialogHeader>
        {created !== null ? (
          <DialogBody className="flex min-w-0 flex-col gap-4">
            <Callout tone="warn" title="This is the only time the token is shown">
              Copy it now. BrowserHive stores only a hash, so it cannot be displayed again. If it is
              lost, revoke it and create a new one.
            </Callout>
            <div className="flex min-w-0 items-center gap-2 rounded-lg border bg-muted/60 py-1.5 pr-1.5 pl-3 dark:bg-white/[0.04]">
              <code
                data-testid="token-plaintext"
                className="min-w-0 flex-1 font-mono text-sm [overflow-wrap:anywhere] select-all"
              >
                {created.token}
              </code>
              <CopyButton
                value={created.token}
                label="Copy token"
                size="icon-sm"
                visibility="always"
              />
            </div>
            <Snippet
              title="MCP client config (Streamable HTTP)"
              value={mcpConfigSnippet(origin, created.token)}
              label="Copy MCP client config"
            />
            <Snippet
              title="Test with curl"
              value={curlSnippet(origin, created.token)}
              label="Copy curl command"
            />
          </DialogBody>
        ) : null}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            I have copied the token
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
