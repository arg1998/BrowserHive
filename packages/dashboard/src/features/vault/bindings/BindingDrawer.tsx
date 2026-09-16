/** @module features/vault/bindings/BindingDrawer — create/edit binding sheet: react-hook-form + contracts-backed schema, item picker, derived handle, origins/slugs, flags (spec 04 §12.7) */
import type { VaultBinding, VaultGroup, VaultItem } from '@browserhive/contracts/http';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Chip } from '@/components/shared/Chip.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Input } from '@/components/ui/input.tsx';
import { SimpleSelect } from '@/components/ui/select.tsx';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet.tsx';
import { Textarea } from '@/components/ui/textarea.tsx';
import {
  type BindingFormValues,
  bindingFormSchema,
  bindingToForm,
  deriveHandle,
  EMPTY_BINDING_FORM,
} from './binding-form.ts';
import { FlagField, FormRow } from './FlagField.tsx';

/** Props. */
export interface BindingDrawerProps {
  readonly open: boolean;
  /** Row being edited; `undefined` creates. */
  readonly binding?: VaultBinding | undefined;
  /** Values to restore (a rolled-back edit). */
  readonly draft?: BindingFormValues | undefined;
  readonly items: readonly VaultItem[];
  readonly groups: readonly VaultGroup[];
  readonly busy?: boolean;
  readonly onSubmit: (values: BindingFormValues) => void;
  readonly onClose: () => void;
}

/** Binding editor. */
export function BindingDrawer({
  open,
  binding,
  draft,
  items,
  groups,
  busy = false,
  onSubmit,
  onClose,
}: BindingDrawerProps) {
  const isNew = binding === undefined;
  const form = useForm<BindingFormValues>({
    resolver: zodResolver(bindingFormSchema),
    defaultValues: draft ?? (binding !== undefined ? bindingToForm(binding) : EMPTY_BINDING_FORM),
  });
  useEffect(() => {
    if (open)
      form.reset(draft ?? (binding !== undefined ? bindingToForm(binding) : EMPTY_BINDING_FORM));
  }, [open, binding, draft, form]);
  const errors = form.formState.errors;
  const allowAll = form.watch('allow_all_sessions');
  const [pickedItem, setPickedItem] = useState<string | null>(null);
  const pickItem = (itemId: string) => {
    const item = items.find((i) => i.item_id === itemId);
    if (item === undefined) return;
    const group = groups.find((g) => g.group_id === item.group_id);
    form.setValue('item_id', item.item_id);
    form.setValue('item_name', item.name, { shouldValidate: true });
    form.setValue('group_id', item.group_id ?? '');
    if (!form.getFieldState('handle').isDirty)
      form.setValue(
        'handle',
        item.handle !== '' ? item.handle : deriveHandle(group?.name ?? null, item.name),
      );
    if (!form.getFieldState('title').isDirty) form.setValue('title', item.name);
    if (!form.getFieldState('allowed_origins').isDirty && item.login_uris.length > 0) {
      form.setValue(
        'allowed_origins',
        item.login_uris.map((u) => u.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '')).join('\n'),
      );
    }
  };
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <form
          className="flex flex-col gap-4 p-4"
          noValidate
          onSubmit={(event) => void form.handleSubmit(onSubmit)(event)}
        >
          <SheetHeader className="p-0">
            <SheetTitle>{isNew ? 'New binding' : `Edit ${binding.handle}`}</SheetTitle>
            <SheetDescription className="flex items-center gap-2">
              <Chip tone="vault">policy only · no secrets</Chip>
              {binding !== undefined ? (
                <span className="font-mono text-xs">version {binding.version}</span>
              ) : null}
            </SheetDescription>
          </SheetHeader>
          {isNew && items.length > 0 ? (
            <FormRow
              label="Backend item"
              hint="The exact backend item this binding fills, resolved by id."
            >
              {(id, describedBy) => (
                <SimpleSelect
                  id={id}
                  aria-describedby={describedBy}
                  className="w-full"
                  value={pickedItem}
                  placeholder="Select an item…"
                  options={items.map((it) => ({
                    value: it.item_id,
                    label: `${it.name}${it.login_uris.length === 0 ? ' (no URL)' : ''}`,
                  }))}
                  onValueChange={(value) => {
                    setPickedItem(value);
                    pickItem(value);
                  }}
                />
              )}
            </FormRow>
          ) : null}
          <FormRow
            label="Handle"
            hint="The stable id agents target; immutable once created."
            error={errors.handle?.message}
          >
            {(id, describedBy, invalid) => (
              <Input
                id={id}
                className="font-mono"
                readOnly={!isNew}
                aria-invalid={invalid}
                aria-describedby={describedBy}
                {...form.register('handle')}
              />
            )}
          </FormRow>
          <FormRow label="Item name" error={errors.item_name?.message}>
            {(id, describedBy, invalid) => (
              <Input
                id={id}
                className="font-mono"
                readOnly={!isNew}
                aria-invalid={invalid}
                aria-describedby={describedBy}
                {...form.register('item_name')}
              />
            )}
          </FormRow>
          <FormRow label="Title" error={errors.title?.message}>
            {(id, describedBy, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid}
                aria-describedby={describedBy}
                {...form.register('title')}
              />
            )}
          </FormRow>
          <FormRow
            label="Allowed origins"
            hint="One per line — exact host or *.domain wildcard."
            error={errors.allowed_origins?.message}
          >
            {(id, describedBy, invalid) => (
              <Textarea
                id={id}
                rows={3}
                className="font-mono"
                placeholder={'app.example.com\n*.internal.example.com'}
                aria-invalid={invalid}
                aria-describedby={describedBy}
                {...form.register('allowed_origins')}
              />
            )}
          </FormRow>
          <FlagField
            control={form.control}
            name="allow_all_sessions"
            hint="any session slug may request this binding"
          />
          <FormRow
            label="Authorized session slugs"
            hint="One per line — exact slug or * glob. Ignored when allow_all_sessions is on."
            error={errors.authorized_session_slugs?.message}
          >
            {(id, describedBy, invalid) => (
              <Textarea
                id={id}
                rows={2}
                className="font-mono"
                disabled={allowAll}
                aria-invalid={invalid}
                aria-describedby={describedBy}
                {...form.register('authorized_session_slugs')}
              />
            )}
          </FormRow>
          <FormRow
            label="Authorized principals"
            hint="One per line; empty = any principal whose slug matches."
            error={errors.authorized_principals?.message}
          >
            {(id, describedBy, invalid) => (
              <Textarea
                id={id}
                rows={2}
                className="font-mono"
                aria-invalid={invalid}
                aria-describedby={describedBy}
                {...form.register('authorized_principals')}
              />
            )}
          </FormRow>
          <FlagField
            control={form.control}
            name="dashboard_confirm"
            hint="prompt here before every fill"
          />
          <FlagField
            control={form.control}
            name="require_no_evaluate"
            hint="only fill when the session has evaluate disabled"
          />
          <FlagField
            control={form.control}
            name="redact_username"
            hint="also redact the username on each fill"
          />
          <SheetFooter className="flex-row justify-end gap-2 p-0">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Save binding
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
