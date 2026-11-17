/** @module features/site-packs/detail/AccessSections — a pack's sign-in, signed-in check and write policy as readable text (spec 13 §9.2, §9.3, §11.4): the sign-in address in full, sign in by hand only, the identity provider, the form's selectors, the probe and how it decides, presence-only cookie names, the keeper; the default write policy, "What the site's terms say" as a label, the clause verbatim with its checked date and address as text, and the exception */
import type { SitePackV1 } from '@browserhive/contracts/site-packs';
import { WRITE_POLICY_HINT, WRITE_POLICY_LABEL } from '../model.ts';
import { StanceLabel, TermsClause, UrlText } from '../PackBits.tsx';
import { PROBE_KIND_LABEL, scopedUrl } from './labels.ts';
import { Code, Facts, PackSection } from './PackSection.tsx';

/** Sign-in. */
export function SignInSection({ pack }: { readonly pack: SitePackV1 }) {
  const signIn = pack.sign_in;
  return (
    <PackSection title="Sign-in">
      <Facts
        rows={[
          pack.identity_provider !== undefined && [
            'Signs in through',
            <span key="idp">
              The <span className="font-medium">{pack.identity_provider}</span> sign-in; its pack
              decides how
            </span>,
          ],
          signIn !== undefined && ['Sign-in page', <UrlText key="u" url={scopedUrl(signIn.url)} />],
          signIn !== undefined && [
            'Who signs in',
            signIn.human_only
              ? 'Sign in by hand only: BrowserHive never fills it, so automatic re-login is unavailable.'
              : 'You, or a vault fill when you link a vault binding.',
          ],
          signIn?.form !== undefined && [
            'Sign-in form',
            <span key="f" className="flex flex-col gap-1">
              <span>
                User name <Code>{signIn.form.username}</Code>
              </span>
              <span>
                Password <Code>{signIn.form.password}</Code>
              </span>
              {signIn.form.next !== undefined ? (
                <span>
                  Next <Code>{signIn.form.next}</Code>
                </span>
              ) : null}
              {signIn.form.submit !== undefined ? (
                <span>
                  Submit <Code>{signIn.form.submit}</Code>
                </span>
              ) : null}
            </span>,
          ],
          pack.shares_login_with.length > 0 && [
            'Shares its sign-in with',
            pack.shares_login_with.join(', '),
          ],
        ]}
      />
    </PackSection>
  );
}

/** The signed-in check. */
export function CheckSection({ pack }: { readonly pack: SitePackV1 }) {
  const check = pack.signed_in;
  return (
    <PackSection
      title="Signed-in check"
      description="BrowserHive opens this page in the background, with GET only, to tell whether the browser is still signed in."
    >
      <Facts
        rows={[
          ['Page', <UrlText key="p" url={scopedUrl(check.probe)} />],
          ['Decides by', PROBE_KIND_LABEL[check.kind]],
          check.signed_out_redirects.length > 0 && [
            'Signed out when sent to',
            <span key="r" className="flex flex-wrap gap-1">
              {check.signed_out_redirects.map((r) => (
                <Code key={r}>{r}</Code>
              ))}
            </span>,
          ],
          check.landmark !== undefined && [
            'Signed-in element',
            <Code key="l">{check.landmark}</Code>,
          ],
          check.signed_out_marker !== undefined && [
            'Signed-out element',
            <Code key="m">{check.signed_out_marker}</Code>,
          ],
          check.cookie_names.length > 0 && [
            'Sign-in cookies',
            <span key="c">
              {check.cookie_names.join(', ')}{' '}
              <span className="text-sm text-muted-foreground">(presence only, never values)</span>
            </span>,
          ],
          check.session_lifetime_days !== undefined && [
            'Sign-in lasts about',
            `${check.session_lifetime_days} days`,
          ],
          pack.keeper !== undefined && [
            'Kept fresh',
            `A background visit every ${pack.keeper.interval_hours} hours${pack.keeper.path !== undefined ? ` to ${pack.keeper.path}` : ''}`,
          ],
        ]}
      />
    </PackSection>
  );
}

/** Write policy and the site's terms. */
export function TermsSection({ pack }: { readonly pack: SitePackV1 }) {
  const policy = pack.write_policy;
  return (
    <PackSection title="Writes and the site’s terms">
      <Facts
        rows={[
          [
            'Default write policy',
            <span key="w">
              <span className="font-medium">{WRITE_POLICY_LABEL[policy.default]}</span>:{' '}
              {WRITE_POLICY_HINT[policy.default]}
            </span>,
          ],
          ['What the site’s terms say', <StanceLabel key="s" stance={policy.stance} />],
          policy.clause !== undefined && ['Clause', <TermsClause key="c" clause={policy.clause} />],
          policy.exception !== undefined && ['Why the default differs', policy.exception],
        ]}
      />
      <p className="text-sm text-muted-foreground">
        The clause is shown so you can choose each template’s write policy; it changes nothing else.
      </p>
    </PackSection>
  );
}
