/** @module routes/_public/change-password — `/change-password?voluntary=1` */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { z } from 'zod';
import { ChangePasswordPage } from '@/features/auth/ChangePasswordPage.tsx';

const search = z.object({ voluntary: z.boolean().catch(false).default(false) });

function Page() {
  const { voluntary } = Route.useSearch();
  return <ChangePasswordPage voluntary={voluntary} />;
}

/** Change password. */
export const Route = createFileRoute('/_public/change-password')({
  component: Page,
  validateSearch: search,
  search: { middlewares: [stripSearchParams({ voluntary: false })] },
  staticData: { title: 'Change password' },
});
