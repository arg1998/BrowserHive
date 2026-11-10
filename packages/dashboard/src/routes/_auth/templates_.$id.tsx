/** @module routes/_auth/templates_.$id — `/templates/$id`: one template (tabs in `?tab=`; spec 13 §11.4) */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router';
import { TemplatePage } from '@/features/templates/detail/TemplatePage.tsx';
import { TEMPLATE_PAGE_DEFAULTS, templatePageSearch } from '@/features/templates/search.ts';

/** One template. */
export const Route = createFileRoute('/_auth/templates_/$id')({
  component: TemplatePage,
  validateSearch: templatePageSearch,
  search: { middlewares: [stripSearchParams(TEMPLATE_PAGE_DEFAULTS)] },
  staticData: {
    title: 'Template',
    crumb: () => 'Template',
    requires: 'templates',
  },
});
