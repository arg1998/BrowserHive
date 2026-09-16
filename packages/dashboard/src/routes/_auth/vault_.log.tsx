/** @module routes/_auth/vault_.log — `/vault/log` (un-nested from `/vault`, same convention as `sessions_.$id`; spec 04 §12.8) */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { VAULT_LOG_DEFAULTS, vaultLogSearch } from '@/features/vault/log/search.ts';
import { VaultLogPage } from '@/features/vault/log/VaultLogPage.tsx';

/** Vault log. */
export const Route = createFileRoute('/_auth/vault_/log')({
  component: VaultLogPage,
  validateSearch: vaultLogSearch,
  search: { middlewares: [stripSearchParams(VAULT_LOG_DEFAULTS)] },
  staticData: {
    title: 'Vault log',
    nav: { label: 'Vault log', icon: 'vaultLog', group: 'primary', order: 65 },
    requires: 'vault',
    palette: { keywords: ['audit', 'vault_fill', 'access', 'credentials'] },
  },
});
