/** @module routes/theme — dev-only token gallery (spec 04 §9); 404 in production builds */
import { createFileRoute, notFound } from '@tanstack/react-router';
import { ThemePage } from '@/features/theme/ThemePage.tsx';

/** Theme gallery. */
export const Route = createFileRoute('/theme')({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: ThemePage,
  staticData: { title: 'Theme' },
});
