/** @module routes/_public/login — `/login` */
import { createFileRoute } from '@tanstack/react-router';
import { LoginPage } from '@/features/auth/LoginPage.tsx';

/** Login. */
export const Route = createFileRoute('/_public/login')({
  component: LoginPage,
  staticData: { title: 'Sign in' },
});
