/** @module composition/phases/ready — phase 7: `/health` flips to ready, `system.status` lifecycle `ready`, the banner is printed once through `output`. */
import { type BannerFacts } from '../banner.ts';
import { type BootContext } from '../context.ts';
import type { PhaseHandle } from '../unwind.ts';
/** Gathers the banner facts from the finished context. */
export declare function bannerFacts(ctx: BootContext): Promise<BannerFacts>;
/** Phase `ready`. */
export declare function readyPhase(ctx: BootContext): Promise<PhaseHandle>;
//# sourceMappingURL=ready.d.ts.map
