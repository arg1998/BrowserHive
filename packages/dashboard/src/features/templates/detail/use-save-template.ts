/** @module features/templates/detail/use-save-template — one PATCH of the template (If-Match its row version) behind an optional confirmation, with the success toast */
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import type { ConfirmOptions } from '@/components/shared/ConfirmDialog.tsx';
import { type TemplatePatch, useTemplateOperations } from '../api-operations.ts';

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
    } catch {
      // The mutation's toast carries the code; the control keeps its old value.
      return false;
    }
  };
  return { save, saving: ops.patch.isPending };
}
