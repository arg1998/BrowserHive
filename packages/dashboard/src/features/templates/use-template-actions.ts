/** @module features/templates/use-template-actions — the confirmed actions shared by a list row's menu and the template page header: delete (typed name, closing live sessions), disable (listing them), enable, browser start/stop/restart, Continue sign-in */
import type { TemplateStatus } from '@browserhive/contracts/enums';
import { useNavigate } from '@tanstack/react-router';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { useTemplateMutations } from './api.ts';
import { useTemplateOperations } from './api-operations.ts';
import { deleteTemplateConfirm, disableTemplateConfirm } from './confirm-copy.ts';
import type { HostAction } from './pending/client.ts';

/** What the actions need to know about a template. */
export interface TemplateRef {
  readonly template_id: string;
  readonly name: string;
  readonly display_name: string;
  readonly status: TemplateStatus;
}

/** Live agent sessions of a template, as `slug (id)` lines for a confirmation. */
export function useLiveSessionLines() {
  const api = useApi();
  return async (templateId: string): Promise<string[]> => {
    try {
      const page = await api.listSessions({
        query: { template: [templateId], view: 'live', limit: 100 },
      });
      return page.data.map((s) => `${s.slug} · ${s.session_id}`);
    } catch {
      return [];
    }
  };
}

/** Actions on one template; each confirms first where spec 13 §11.4 says so. */
export function useTemplateActions(template: TemplateRef) {
  const id = template.template_id;
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const mutations = useTemplateMutations(id);
  const operations = useTemplateOperations(id);
  const liveLines = useLiveSessionLines();
  const busy =
    mutations.remove.isPending ||
    operations.setEnabled.isPending ||
    operations.host.isPending ||
    mutations.clearProfileSecrets.isPending;

  const remove = async (): Promise<boolean> => {
    const lines = await liveLines(id);
    if (!(await confirm(deleteTemplateConfirm(template, lines)))) return false;
    try {
      const result = await mutations.remove.mutateAsync(lines.length > 0);
      toast.success({
        title: `Deleted ${template.display_name}`,
        ...(result.closed_sessions.length > 0 && {
          description: `${result.closed_sessions.length} live session${result.closed_sessions.length === 1 ? '' : 's'} closed.`,
        }),
      });
      return true;
    } catch {
      return false;
    }
  };
  const disable = async () => {
    const lines = await liveLines(id);
    if (!(await confirm(disableTemplateConfirm(template.display_name, lines)))) return;
    const result = await operations.setEnabled.mutateAsync(false).catch(() => null);
    if (result !== null) toast.success({ title: `Disabled ${template.display_name}` });
  };
  const enable = async () => {
    const result = await operations.setEnabled.mutateAsync(true).catch(() => null);
    if (result !== null) toast.success({ title: `Enabled ${template.display_name}` });
  };
  const host = async (action: HostAction) => {
    const result = await operations.host.mutateAsync(action).catch(() => null);
    if (result === null) return;
    const verb = action === 'start' ? 'Started' : action === 'stop' ? 'Stopped' : 'Restarted';
    toast.success({ title: `${verb} the browser of ${template.display_name}` });
  };
  const continueSignIn = () =>
    void navigate({ to: '/templates/new', search: { step: 5, template: id } });
  const clearProfileSecrets = async () => {
    try {
      await mutations.clearProfileSecrets.mutateAsync();
      toast.success({ title: 'Saved passwords and autofill cleared' });
    } catch (error) {
      toAppError(error);
    }
  };
  return { busy, remove, disable, enable, host, continueSignIn, clearProfileSecrets };
}
