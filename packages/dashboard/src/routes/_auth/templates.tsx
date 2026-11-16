/** @module routes/_auth/templates — `/templates` (spec 13 §11.4, spec 04 §12.14) */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { TEMPLATES_DEFAULTS, templatesSearch } from '@/features/templates/search.ts';
import { TemplatesPage } from '@/features/templates/TemplatesPage.tsx';

/** Session templates. */
export const Route = createFileRoute('/_auth/templates')({
  component: TemplatesPage,
  validateSearch: templatesSearch,
  search: { middlewares: [stripSearchParams(TEMPLATES_DEFAULTS)] },
  staticData: {
    title: 'Templates',
    nav: { label: 'Templates', icon: 'templates', group: 'primary', order: 25 },
    requires: 'templates',
    palette: { keywords: ['session templates', 'sign in', 'login', 'accounts', 'identity'] },
  },
});
