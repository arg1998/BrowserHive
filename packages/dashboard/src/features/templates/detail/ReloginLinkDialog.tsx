/** @module features/templates/detail/ReloginLinkDialog — automatic re-login for one site (spec 13 §8.4, `PUT …/sites/{site}/relogin`): pick a vault binding, the sign-in form of a site without a pack (page path, username, password, submit), the auto-relogin switch (off until a binding is linked), and why the binding would refuse the template's fill with **Allow this template** (confirmed: it widens who can use the credential) */
import type { BindingProblem, TemplateSiteView, VaultBinding } from '@browserhive/contracts/http';
import { useEffect, useState } from 'react';
import { useConfirm } from '@/app/providers/ConfirmProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { Callout } from '@/components/shared/Callout.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { toAppError } from '@/lib/api/errors.ts';
import { useTemplateHealth } from '../api-health.ts';
import { allowTemplateConfirm } from '../confirm-copy.ts';
import { SwitchRow } from '../fields.tsx';
import { bindingProblemsOf } from '../relogin-text.ts';
import { BindingPicker, BindingProblems } from './binding-parts.tsx';
import {
  type FormDraft,
  FormSelectors,
  formBody,
  formDraftOf,
  formProblem,
} from './form-selectors.tsx';

/** Props. */
export interface ReloginLinkDialogProps {
  readonly templateId: string;
  readonly templateName: string;
  readonly site: TemplateSiteView;
  readonly bindings: readonly VaultBinding[];
  readonly open: boolean;
  readonly onClose: () => void;
}

/** The dialog. */
export function ReloginLinkDialog({
  templateId,
  templateName,
  site,
  bindings,
  open,
  onClose,
}: ReloginLinkDialogProps) {
  const health = useTemplateHealth(templateId);
  const confirm = useConfirm();
  const toast = useToast();
  const [handle, setHandle] = useState<string | null>(site.vault_handle);
  const [auto, setAuto] = useState(site.auto_relogin);
  const [form, setForm] = useState<FormDraft>(() => formDraftOf(site.form));
  const [saved, setSaved] = useState<readonly BindingProblem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setHandle(site.vault_handle);
    setAuto(site.auto_relogin);
    setForm(formDraftOf(site.form));
    setSaved(null);
    setError(null);
  }, [open, site]);
  const generic = site.pack_id === null;
  const binding = bindings.find((b) => b.handle === handle);
  const problems =
    handle === null
      ? []
      : saved !== null && handle === site.vault_handle
        ? saved
        : bindingProblemsOf(binding, templateId);
  const formError = generic && handle !== null ? formProblem(form, auto) : null;

  const save = async (allowTemplate: boolean) => {
    if (allowTemplate && handle !== null) {
      if (!(await confirm(allowTemplateConfirm(handle, templateName, templateId)))) return;
    }
    setError(null);
    health.link.mutate(
      {
        site: site.site_id,
        body: {
          vault_handle: handle,
          auto_relogin: handle !== null && auto,
          ...(generic && { form: handle === null ? null : formBody(form) }),
          allow_template: allowTemplate,
        },
      },
      {
        onSuccess: (result) => {
          setSaved(result.binding_problems);
          if (result.binding_problems.length === 0) {
            toast.success({
              title:
                handle === null
                  ? `Automatic re-login is off for ${site.title}`
                  : `${site.title} is linked to ${handle}`,
            });
            onClose();
          }
        },
        onError: (e) => {
          const appError = toAppError(e);
          setError(
            appError.status === 403
              ? 'Linking a vault binding needs both templates:login and vault:write. Ask an administrator, or sign in with an account that has them.'
              : appError.message,
          );
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Automatic re-login for {site.title}</DialogTitle>
          <DialogDescription>
            When a check finds {site.title} signed out, BrowserHive signs in again by itself with a
            vault binding, once per sign-out. A site that wants a code or a check still needs you.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-5 pb-1">
          <BindingPicker bindings={bindings} value={handle} onChange={setHandle} />
          {problems.length > 0 ? (
            <BindingProblems
              problems={problems}
              busy={health.link.isPending}
              onAllow={() => void save(true)}
            />
          ) : null}
          {generic && handle !== null ? <FormSelectors draft={form} onChange={setForm} /> : null}
          <SwitchRow
            label="Re-login automatically"
            description={
              handle === null
                ? 'Link a binding first.'
                : 'One try per sign-out; a second sign-out within 24 hours waits for you.'
            }
            checked={handle !== null && auto}
            disabled={handle === null}
            onChange={setAuto}
          />
          {error !== null ? (
            <Callout tone="danger" title="Not saved">
              {error}
            </Callout>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            {saved !== null && saved.length > 0 ? 'Close' : 'Cancel'}
          </Button>
          <Button
            type="button"
            disabled={health.link.isPending || formError !== null}
            onClick={() => void save(false)}
          >
            {health.link.isPending ? <Spinner /> : null}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
