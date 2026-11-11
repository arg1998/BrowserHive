/** @module features/templates/detail/use-seed — Seed from file… (spec 13 §7.4): read the chosen storage-state file in memory (never stored), check it against the contract, confirm over a ready template, then start the operation; refusals are explained in a toast */
import { TemplateStorageState } from '@browserhive/contracts/http';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { useTemplateOperations } from '../api-operations.ts';
import { seedOverReadyConfirm } from '../confirm-copy.ts';
import { useLiveSessionLines } from '../use-template-actions.ts';
import { operationRefusal, SEED_MAX_BYTES } from './version-text.ts';

/** Returns `seed(file)`, resolving to the operation id or `null`. */
export function useSeedFromFile(template: {
  readonly template_id: string;
  readonly display_name: string;
  readonly status: string;
}) {
  const ops = useTemplateOperations(template.template_id);
  const confirm = useConfirm();
  const toast = useToast();
  const liveLines = useLiveSessionLines();
  const seed = async (picked: File): Promise<string | null> => {
    if (picked.size > SEED_MAX_BYTES) {
      toast.error({ title: 'The file is larger than 16 MiB' });
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await picked.text());
    } catch {
      parsed = undefined;
    }
    const state = TemplateStorageState.safeParse(parsed);
    if (!state.success) {
      toast.error({
        title: 'That file is not a storage state',
        description: 'Expected the JSON Playwright saves with storageState() or --save-storage.',
      });
      return null;
    }
    const ready = template.status === 'ready';
    if (ready) {
      const lines = await liveLines(template.template_id);
      if (!(await confirm(seedOverReadyConfirm(template.display_name, lines)))) return null;
    }
    try {
      const started = await ops.seed.mutateAsync({ state: state.data, confirm: ready });
      return started.operation_id;
    } catch (error) {
      toast.error({
        title: 'Seeding did not start',
        description: operationRefusal(toAppError(error), 'seed'),
      });
      return null;
    }
  };
  return { seed, pending: ops.seed.isPending };
}
