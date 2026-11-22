/** @module features/templates/list/PackUpdatesBanner — the pending-updates banner on `/templates` (spec 13 §10.6, §11.4; review #100 M6): how many site-pack updates of followed packs and local files wait for review, linking to Site packs filtered to them; nothing when none waits or site packs are off */
import { Link } from '@tanstack/react-router';
import { Callout } from '@/components/shared/Callout.tsx';
import { buttonVariants } from '@/components/ui/button.tsx';
import { useSitePackCatalog } from '@/features/site-packs/api.ts';
import { packsNeedingReview } from '@/features/site-packs/model.ts';

/** The banner. */
export function PackUpdatesBanner() {
  const catalog = useSitePackCatalog();
  const data = catalog.data;
  if (data === undefined || !data.status.enabled) return null;
  const n = packsNeedingReview(data);
  if (n === 0) return null;
  return (
    <Callout
      tone="accent"
      title={`${n} site pack ${n === 1 ? 'update waits' : 'updates wait'} for your review`}
      action={
        <Link
          to="/site-packs"
          search={{ pending: 1 }}
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          Review updates
        </Link>
      }
    >
      Templates keep using the version they have until you approve a new one.
    </Callout>
  );
}
