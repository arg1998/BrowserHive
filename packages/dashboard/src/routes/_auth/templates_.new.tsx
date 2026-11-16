/** @module routes/_auth/templates_.new — `/templates/new`: the new-template wizard (`?step=1…5`, `?template` from the sign-in step on; spec 13 §7.1) */
import { createFileRoute } from '@tanstack/react-router';
import { wizardSearch } from '@/features/templates/search.ts';
import { NewTemplatePage } from '@/features/templates/wizard/NewTemplatePage.tsx';

/** New template. */
export const Route = createFileRoute('/_auth/templates_/new')({
  component: NewTemplatePage,
  validateSearch: wizardSearch,
  staticData: {
    title: 'New template',
    requires: 'templates',
    palette: { keywords: ['create template', 'record sign-in', 'new login'] },
  },
});
