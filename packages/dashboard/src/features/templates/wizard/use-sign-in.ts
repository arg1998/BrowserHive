/** @module features/templates/wizard/use-sign-in — the sign-in step's state and actions (spec 13 §7.1): the template and its recording window kept current (the `templates` topic plus a slow poll), opening the window (restarting a failed browser first), **I'm signed in** per site, Finish, closing the window, and the error state the step is in */
import { useEffect, useState } from 'react';
import { useApi } from '@/app/providers/AuthProvider.tsx';
import { useToast } from '@/app/providers/ToastProvider.tsx';
import { type AppError, toAppError } from '@/lib/api/errors.ts';
import { useTemplateDetail, useTemplateMutations } from '../api.ts';
import { useTemplatesLive } from '../live.ts';
import { signInProblem } from './sign-in-model.ts';
import { useRecordingSession } from './use-recording.ts';

/** Everything the step renders from. */
export function useSignIn(templateId: string) {
  const api = useApi();
  const toast = useToast();
  useTemplatesLive();
  const detail = useTemplateDetail(templateId, { poll: true });
  const recording = useRecordingSession(templateId);
  const m = useTemplateMutations(templateId);
  const [startError, setStartError] = useState<AppError | null>(null);
  const [confirmErrors, setConfirmErrors] = useState<Readonly<Record<string, string>>>({});
  const [sawWindow, setSawWindow] = useState(false);
  const session = recording.session;
  useEffect(() => {
    if (session !== null) setSawWindow(true);
  }, [session]);
  const host = detail.data?.host;
  const problem = signInProblem({
    error: startError,
    host,
    template: detail.data?.template,
    windowLost: sawWindow && recording.known && session === null,
  });

  /** Open (or raise) the window; a failed browser is restarted first (spec 13 §3.2). */
  const open = async () => {
    setStartError(null);
    try {
      if (host?.state === 'failed')
        await api.restartTemplateHost({ params: { template_id: templateId } });
      await m.startRecording.mutateAsync(undefined);
      await recording.refetch();
    } catch (error) {
      setStartError(toAppError(error));
      void detail.refetch();
    }
  };
  const confirmSite = async (siteId: string) => {
    setConfirmErrors(({ [siteId]: _drop, ...rest }) => rest);
    try {
      await m.confirm.mutateAsync(siteId);
    } catch (error) {
      const e = toAppError(error);
      const message =
        e.code === 'CONFLICT'
          ? `No new sign-in on ${siteId} yet. Finish signing in there, then press again.`
          : e.message;
      setConfirmErrors((prev) => ({ ...prev, [siteId]: message }));
    }
  };
  /** Finish; `true` once the template is ready. */
  const finish = async (removeSignIns: readonly string[]): Promise<boolean> => {
    try {
      const result = await m.finish.mutateAsync(removeSignIns);
      const uncleared = result.removed_sign_ins.flatMap((r) => r.uncleared_origins);
      if (uncleared.length > 0)
        toast.warning({
          title: 'Some sign-ins may remain',
          description: `Site data could not be cleared for ${uncleared.join(', ')}.`,
        });
      return true;
    } catch {
      // The mutation's toast carries the code; the dialog stays open.
      return false;
    }
  };
  /** Close the window; `true` once it is closed (or none was open). */
  const closeWindow = async (): Promise<boolean> => {
    if (session === null) return true;
    try {
      await m.cancel.mutateAsync();
      await recording.refetch();
      return true;
    } catch {
      // The mutation's toast says why; the window stays open.
      return false;
    }
  };
  const confirmingSite = m.confirm.isPending ? (m.confirm.variables ?? null) : null;
  return {
    detail,
    session,
    known: recording.known,
    problem,
    confirmErrors,
    confirmingSite,
    opening: m.startRecording.isPending,
    finishing: m.finish.isPending,
    closing: m.cancel.isPending,
    open,
    confirmSite,
    finish,
    closeWindow,
  };
}
