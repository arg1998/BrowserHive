/** @module routes/_auth/vault — `/vault` (spec 04 §12.7) */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { VAULT_DEFAULTS, vaultSearch } from '@/features/vault/search.ts';
import { VaultPage } from '@/features/vault/VaultPage.tsx';

/** Vault. */
export const Route = createFileRoute('/_auth/vault')({
  component: VaultPage,
  validateSearch: vaultSearch,
  search: { middlewares: [stripSearchParams(VAULT_DEFAULTS)] },
  staticData: {
    title: 'Vault',
    nav: { label: 'Vault', icon: 'vault', group: 'primary', order: 60, key: 'v' },
    requires: 'vault',
    palette: { keywords: ['credentials', 'bindings', 'bitwarden', 'unlock', 'confirm'] },
  },
});
