/** @module features/system/tokens/TokenTable — issued API tokens: principal, public prefix (copy on hover), scopes, created, last used, expiry, revoke (never the secret); low-value columns hide on narrow screens */
import type { ApiTokenSummary } from '@browserhive/contracts/http';
import { Chip } from '@/components/shared/Chip.tsx';
import { CopyValue } from '@/components/shared/CopyButton.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table.tsx';

/** Props. */
export interface TokenTableProps {
  readonly tokens: readonly ApiTokenSummary[];
  readonly onRevoke: (token: ApiTokenSummary) => void;
}

function Never() {
  return <span className="text-muted-foreground">never</span>;
}

/** Token table. */
export function TokenTable({ tokens, onRevoke }: TokenTableProps) {
  return (
    <section aria-label="API tokens">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="border-t">
              Principal
            </TableHead>
            <TableHead scope="col" className="border-t">
              Prefix
            </TableHead>
            <TableHead scope="col" className="hidden border-t lg:table-cell">
              Scopes
            </TableHead>
            <TableHead scope="col" className="hidden border-t md:table-cell">
              Created
            </TableHead>
            <TableHead scope="col" className="hidden border-t sm:table-cell">
              Last used
            </TableHead>
            <TableHead scope="col" className="hidden border-t md:table-cell">
              Expires
            </TableHead>
            <TableHead scope="col" className="border-t">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tokens.map((token) => (
            <TableRow key={token.credential_id} data-reveal-scope="" className="hover:bg-accent/50">
              <TableCell>
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="font-medium">{token.subject}</span>
                  {token.owner_kind === 'operator' ? <Chip tone="info">operator</Chip> : null}
                </span>
              </TableCell>
              <TableCell>
                <CopyValue
                  value={token.public_prefix}
                  label={`Copy prefix ${token.public_prefix}`}
                />
              </TableCell>
              <TableCell className="hidden lg:table-cell">
                <span className="inline-flex flex-wrap gap-1">
                  {token.scopes.map((scope) => (
                    <Chip key={scope} tone="muted" className="font-mono">
                      {scope}
                    </Chip>
                  ))}
                </span>
              </TableCell>
              <TableCell className="hidden md:table-cell">
                <RelativeTime at={token.created_at} />
              </TableCell>
              <TableCell className="hidden sm:table-cell">
                {token.last_used_at === null ? <Never /> : <RelativeTime at={token.last_used_at} />}
              </TableCell>
              <TableCell className="hidden md:table-cell">
                {token.expires_at === null ? <Never /> : <RelativeTime at={token.expires_at} />}
              </TableCell>
              <TableCell className="w-px text-right">
                <Button
                  type="button"
                  variant="destructive-ghost"
                  size="sm"
                  aria-label={`Revoke token ${token.public_prefix} for ${token.subject}`}
                  onClick={() => onRevoke(token)}
                >
                  Revoke
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
