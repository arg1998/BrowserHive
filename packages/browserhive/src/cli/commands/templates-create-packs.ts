/** @module cli/commands/templates-create-packs — the site packs `templates create --sites` approves: before anything is created it reads the catalog, prints each site's pack (version, provenance, SHA-256, terms) and sends the reviewed `pack_sha256` with every site a pack covers, after a confirmation on a terminal or `--yes` (spec 13 §9.6 "First use", D-67; review S-M4) */
import {
  SitePacksResponse,
  type SitePackView,
  type TemplateInput,
  type TemplateSiteInput,
} from '@browserhive/contracts/http';
import type { CommandContext } from '../deps.ts';
import { EXIT, type ExitCode, type Invocation } from '../invocation.ts';
import { provenanceText, type SitePacksTarget, sitePackCall } from './sitepacks-common.ts';

type CreateInvocation = Extract<Invocation, { readonly command: 'templates-create' }>;

/** One site's pack as adding the site would use it. */
interface SitePackChoice {
  readonly site: string;
  readonly view: SitePackView;
  /** The SHA-256 sent as `pack_sha256`. */
  readonly sha256: string;
  /** `true` when adding the site approves it (nothing was approved yet). */
  readonly approves: boolean;
}

/** The pack whose domains cover `site` (the site itself or a parent domain). */
function packFor(packs: readonly SitePackView[], site: string): SitePackView | undefined {
  return packs.find((view) =>
    view.domains.some((domain) => site === domain || site.endsWith(`.${domain}`)),
  );
}

function choiceFor(packs: readonly SitePackView[], site: string): SitePackChoice | null {
  const view = packFor(packs, site);
  if (view === undefined) return null;
  if (view.approved !== null) {
    return { site, view, sha256: view.approved.sha256, approves: false };
  }
  if (view.offer !== null) return { site, view, sha256: view.offer.sha256, approves: true };
  return null;
}

const STANCE_TEXT: Readonly<Record<SitePackView['stance'], string>> = {
  prohibited: "the site's terms prohibit automated access",
  writes_restricted: "the site's terms restrict automated posting",
  restricted: "the site's terms restrict automated access",
  allowed: "the site's terms allow automated access",
};

function choiceLines(choice: SitePackChoice): readonly string[] {
  const { view, site } = choice;
  const ref = choice.approves ? view.offer : view.approved;
  if (ref === null) return [];
  const where = provenanceText(ref.source, ref.provenance);
  const head = `  ${site}  ${view.title} v${ref.version} · ${where}${choice.approves ? '' : ' · already approved'}`;
  const writes =
    view.write_guards === 0
      ? 'no write guards: the write policy has no effect for this pack yet'
      : `writes: ${view.write_policy_default} by default (${view.write_guards} write guard(s))`;
  const lines = [
    head,
    `      SHA-256 ${choice.sha256}`,
    `      ${STANCE_TEXT[view.stance]} · ${writes}`,
  ];
  if (view.human_only) lines.push('      sign-in by a person only (never filled by the vault)');
  return lines;
}

/**
 * Reads the site-pack catalog and returns the create body with the `pack_sha256` of every site a
 * pack covers. When a site's pack is not approved yet, it prints what adding the site approves and
 * asks on a terminal (refusing without one unless `--yes`).
 *
 * @returns The body to send, or 1 after printing a failure or a refusal (nothing was created).
 */
export async function withSitePacks(
  context: CommandContext,
  invocation: CreateInvocation,
): Promise<TemplateInput | ExitCode> {
  const { out, deps } = context;
  const target: SitePacksTarget = { remote: invocation.remote, json: invocation.json };
  const result = await sitePackCall(context, target.remote, 'GET', '/site-packs');
  if (!result.ok) {
    out.diagnostic(
      'The site packs of the sites could not be read; templates create needs them (scope sitepacks:read) to show what it approves.',
    );
    return result.code;
  }
  const parsed = SitePacksResponse.safeParse(result.json);
  if (!parsed.success) {
    out.diagnostic('browserhive: the server answered with an unexpected site pack list.');
    return EXIT.fatal;
  }
  if (!parsed.data.status.enabled) return invocation.input;
  const packs = parsed.data.data;
  const choices = invocation.input.sites
    .map((site) => choiceFor(packs, site.site_id))
    .filter((choice): choice is SitePackChoice => choice !== null);
  if (choices.length === 0) return invocation.input;
  // In --json mode stdout carries only the JSON answer.
  const say = (text: string) => (invocation.json ? out.diagnostic(text) : out.line(text));
  say('Site packs of these sites:');
  for (const choice of choices) for (const line of choiceLines(choice)) say(line);
  const approving = choices.filter((choice) => choice.approves);
  if (approving.length > 0 && !invocation.yes) {
    const names = approving.map((choice) => choice.view.pack_id).join(', ');
    if (deps.prompt === null) {
      out.diagnostic(
        `browserhive templates create: adding these sites approves the site packs ${names}, and stdin is not a terminal.`,
      );
      out.diagnostic('Review them above, then pass --yes to approve them.');
      return EXIT.fatal;
    }
    say(`Adding these sites approves ${names} for every template.`);
    const answer = await deps.prompt('Type yes to approve and create the template: ');
    if (answer.trim().toLowerCase() !== 'yes') {
      out.line('Aborted — nothing was created.');
      return EXIT.fatal;
    }
  }
  const bySite = new Map(choices.map((choice) => [choice.site, choice.sha256]));
  const sites: TemplateSiteInput[] = invocation.input.sites.map((site) => {
    const sha256 = bySite.get(site.site_id);
    return sha256 === undefined ? site : { ...site, pack_sha256: sha256 };
  });
  return { ...invocation.input, sites };
}
