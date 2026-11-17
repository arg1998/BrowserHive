/** @module features/templates/detail/ClearStop — a stopped site on its card (spec 13 §9.5 `stop`): the site showed a state where retrying makes things worse, so agents may not use it until the operator clears it; **Clear stop** (`POST …/sites/{site_id}/clear-stop`) */
import type { TemplateSiteView } from '@browserhive/contracts/http';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { RelativeTime } from '@/components/shared/RelativeTime.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { keys } from '@/lib/api/keys.ts';

/** The stopped notice with Clear stop. */
export function ClearStop({
  templateId,
  site,
}: {
  readonly templateId: string;
  readonly site: TemplateSiteView;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const clear = useMutation({
    mutationFn: () =>
      api.clearTemplateSiteStop({ params: { template_id: templateId, site_id: site.site_id } }),
    onSuccess: () => toast.success({ title: `${site.title}: agents may use it again` }),
    onError: (error: unknown) => {
      toast.fromError(toAppError(error));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.templates.all }),
  });
  if (site.stopped_at === null) return null;
  return (
    <Callout
      tone="danger"
      title="Stopped: agents can’t use this site"
      action={
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={clear.isPending}
          aria-label={`Clear stop: ${site.site_id}`}
          onClick={() => clear.mutate()}
        >
          {clear.isPending ? <Spinner /> : null}
          Clear stop
        </Button>
      }
    >
      <span className="flex flex-col gap-1">
        <span>
          The site showed a page where trying again makes things worse, like a suspended account or
          a refused sign-in. Open the site in the template’s browser and sort it out, then clear the
          stop.
        </span>
        <span className="text-sm opacity-80">
          Stopped <RelativeTime at={site.stopped_at} className="text-sm" />
        </span>
      </span>
    </Callout>
  );
}
