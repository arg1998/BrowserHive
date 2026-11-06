/** @module app/shell/InstallToastBridge — turns the prompt store's `installed` signal into a toast (04 §18.8.1); toasts need the React context, the store has none. Mounted once by `AppShell`. */
import { useEffect, useRef } from 'react';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { useInstallPrompt } from '@/features/install/install-app.tsx';

/** The toast's words. */
export const INSTALLED_TOAST = {
  title: 'BrowserHive is installed',
  description: 'Open it from your app launcher or taskbar.',
} as const;

/** Renders nothing. */
export function InstallToastBridge() {
  const { installed } = useInstallPrompt();
  const toast = useToast();
  const seen = useRef(installed);
  useEffect(() => {
    if (installed === seen.current) return;
    seen.current = installed;
    toast.success({ id: 'app-installed', ...INSTALLED_TOAST });
  }, [installed, toast]);
  return null;
}
