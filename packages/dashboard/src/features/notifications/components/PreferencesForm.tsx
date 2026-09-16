/** @module features/notifications/components/PreferencesForm — toast preferences (the only server preferences the dashboard reads): pop-up toasts on/off and which notification types toast; every other stored key (sidebar, page size, saved views) is preserved on save (spec 04 §4.6) */
import { NotificationType } from '@browserhive/contracts/enums';
import type { Preferences } from '@browserhive/contracts/http';
import { useEffect, useId, useState } from 'react';
import { DEFAULT_TOAST_TYPES } from '@/app/providers/NotificationsProvider.tsx';
import { Button } from '@/components/ui/button.tsx';
import { Checkbox } from '@/components/ui/checkbox.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { NOTIFICATION_TYPE } from '@/lib/status-registry.ts';
import { cn } from '@/lib/utils.ts';

/** Props. */
export interface PreferencesFormProps {
  readonly preferences: Preferences;
  readonly saving: boolean;
  readonly onSave: (next: Preferences) => void;
}

/** Editable part of the document. */
export interface PreferencesDraft {
  readonly toasts: boolean;
  readonly types: readonly NotificationType[];
}

function toDraft(p: Preferences): PreferencesDraft {
  return {
    toasts: p.notifications?.toasts ?? true,
    // No stored list means the provider's default (every type but tool errors), so the form shows
    // what actually toasts.
    types: p.notifications?.types ?? DEFAULT_TOAST_TYPES,
  };
}

/** Merge the draft into the stored document (keeps keys this form does not edit). */
export function mergePreferences(stored: Preferences, draft: PreferencesDraft): Preferences {
  return {
    ...stored,
    notifications: { ...stored.notifications, toasts: draft.toasts, types: [...draft.types] },
  };
}

/** Preferences form. */
export function PreferencesForm({ preferences, saving, onSave }: PreferencesFormProps) {
  const [draft, setDraft] = useState<PreferencesDraft>(() => toDraft(preferences));
  useEffect(() => setDraft(toDraft(preferences)), [preferences]);
  const toastsId = useId();
  const stored = toDraft(preferences);
  const dirty =
    stored.toasts !== draft.toasts ||
    stored.types.length !== draft.types.length ||
    stored.types.some((t) => !draft.types.includes(t));
  return (
    <form
      aria-label="Toast preferences"
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(mergePreferences(preferences, draft));
      }}
    >
      <div className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-0.5">
          <label htmlFor={toastsId} className="font-medium">
            Pop-up toasts
          </label>
          <p id={`${toastsId}-hint`} className="text-sm text-muted-foreground">
            Show a toast when a new notification arrives. Notifications are always kept on this page
            and in the bell.
          </p>
        </div>
        <Switch
          id={toastsId}
          className="mt-0.5"
          checked={draft.toasts}
          aria-describedby={`${toastsId}-hint`}
          onCheckedChange={(checked) => setDraft({ ...draft, toasts: checked })}
        />
      </div>
      <fieldset
        disabled={!draft.toasts}
        className={cn('flex flex-col gap-2.5', !draft.toasts && 'opacity-60')}
      >
        <legend className="mb-2.5 text-sm font-medium">Toast for</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-2.5">
          {NotificationType.options.map((type) => (
            <label
              key={type}
              htmlFor={`${toastsId}-${type}`}
              className="flex items-center gap-2 text-base"
            >
              <Checkbox
                id={`${toastsId}-${type}`}
                disabled={!draft.toasts}
                checked={draft.types.includes(type)}
                onCheckedChange={(checked) =>
                  setDraft({
                    ...draft,
                    types: checked ? [...draft.types, type] : draft.types.filter((t) => t !== type),
                  })
                }
              />
              <span className="first-letter:uppercase">{NOTIFICATION_TYPE[type].label}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex items-center gap-3 border-t pt-4">
        <Button type="submit" size="sm" disabled={saving || !dirty}>
          {saving ? <Spinner /> : null}
          Save preferences
        </Button>
        {dirty ? <span className="text-sm text-muted-foreground">Unsaved changes</span> : null}
      </div>
    </form>
  );
}
