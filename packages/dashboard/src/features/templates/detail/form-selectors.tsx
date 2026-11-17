/** @module features/templates/detail/form-selectors — the sign-in form of a site without a pack, for automatic re-login (spec 13 §2.3, §8.4): the sign-in page's path, and CSS selectors of the username and password fields and the submit button; the draft, its check and its request body */
import type { TemplateSiteView } from '@browserhive/contracts/http';
import { useId } from 'react';
import { Input } from '@/components/ui/input.tsx';
import { Field } from '../fields.tsx';

/** What the operator types. */
export interface FormDraft {
  readonly path: string;
  readonly username: string;
  readonly password: string;
  readonly submit: string;
  /** Kept as stored (a multi-step form needs a site pack). */
  readonly next: string;
}

/** The draft of a stored form. */
export function formDraftOf(form: TemplateSiteView['form']): FormDraft {
  return {
    path: form?.path ?? '',
    username: form?.username ?? '',
    password: form?.password ?? '',
    submit: form?.submit ?? '',
    next: form?.next ?? '',
  };
}

/** What is wrong with the draft, or `null`. Selectors are needed once a binding is linked. */
export function formProblem(draft: FormDraft, auto: boolean): string | null {
  const path = draft.path.trim();
  if (path !== '' && (!path.startsWith('/') || /[?#]/.test(path)))
    return 'The path starts with / and has no ? or #.';
  if (auto && (draft.username.trim() === '' || draft.password.trim() === ''))
    return 'Automatic re-login needs the username and password fields.';
  return null;
}

/** The request's `form`, or `null` when nothing was typed. */
export function formBody(draft: FormDraft) {
  const username = draft.username.trim();
  const password = draft.password.trim();
  if (username === '' || password === '') return null;
  const opt = (key: 'path' | 'submit' | 'next') => {
    const value = draft[key].trim();
    return value === '' ? {} : { [key]: value };
  };
  return { username, password, ...opt('path'), ...opt('submit'), ...opt('next') };
}

/** The four fields. */
export function FormSelectors({
  draft,
  onChange,
}: {
  readonly draft: FormDraft;
  readonly onChange: (next: FormDraft) => void;
}) {
  const id = useId();
  const problem = formProblem(draft, false);
  const field = (
    key: keyof FormDraft,
    label: string,
    placeholder: string,
    help?: string,
    optional?: boolean,
  ) => (
    <Field
      label={label}
      htmlFor={`${id}-${key}`}
      {...(help !== undefined && { help })}
      {...(optional === true && { optional })}
      {...(key === 'path' && { error: problem })}
    >
      <Input
        id={`${id}-${key}`}
        value={draft[key]}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        className="font-mono"
        onChange={(event) => onChange({ ...draft, [key]: event.target.value })}
      />
    </Field>
  );
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border px-4 pt-3 pb-4">
      <legend className="px-1 text-sm font-medium">Sign-in form</legend>
      <p className="text-sm text-pretty text-muted-foreground">
        This site has no site pack yet, so tell BrowserHive where to type. Use CSS selectors of the
        page’s own fields; BrowserHive only queries them, never runs page scripts.
      </p>
      {field(
        'path',
        'Sign-in page path',
        '/login',
        'On the site itself. Empty: the home page.',
        true,
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {field('username', 'Username field', 'input[name=email]')}
        {field('password', 'Password field', 'input[type=password]')}
      </div>
      {field(
        'submit',
        'Submit button',
        'button[type=submit]',
        'Empty: press Enter in the password field.',
        true,
      )}
    </fieldset>
  );
}
