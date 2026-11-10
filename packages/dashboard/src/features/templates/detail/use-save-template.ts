/** @module features/templates/detail/use-save-template — one PATCH of the template (If-Match its row version) behind an optional confirmation, with the success toast and the "server can't change templates yet" answer */
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import type { ConfirmOptions } from '@/components/shared/ConfirmDialog.tsx';
import { useTemplateOperations } from '../api-operations.ts';
import { isRouteMissing, type TemplatePatch } from '../pending/client.ts';

/** `save(patch, title, confirm?)` → `true` once saved. */
export function useSaveTemplate(template: {
  readonly template_id: string;
  readonly version: number;
}) {
  const ops = useTemplateOperations(template.template_id);
  const confirm = useConfirm();
  const toast = useToast();
  const save = async (
    patch: TemplatePatch,
    title: string,
    ask?: ConfirmOptions,
  ): Promise<boolean> => {
    if (ask !== undefined && !(await confirm(ask))) return false;
    try {
      await ops.patch.mutateAsync({ patch, ifMatch: template.version });
      toast.success({ title });
      return true;
    } catch (error) {
      if (isRouteMissing(error)) toast.error({ title: 'This server can’t change templates yet' });
      return false;
    }
  };
  return { save, saving: ops.patch.isPending };
}
