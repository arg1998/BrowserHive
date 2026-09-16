/** @module features/attention/use-request-alerts — per-device sound toggle for new open requests (spec 04 §4.6) */
import { useCallback, useState } from 'react';
import { useTopic } from '@/app/providers/SocketProvider.tsx';
import { readStorage, writeStorage } from '@/lib/storage.ts';

/** localStorage key of the sound toggle. */
export const SOUND_STORAGE_KEY = 'bh.attention.sound';

/** Play a short two-tone chime; silently does nothing where WebAudio is unavailable. */
export function playChime(): void {
  if (typeof AudioContext !== 'function') return;
  try {
    const ctx = new AudioContext();
    const gain = ctx.createGain();
    gain.gain.value = 0.06;
    gain.connect(ctx.destination);
    for (const [freq, at] of [
      [880, 0],
      [1175, 0.12],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.11);
    }
    setTimeout(() => void ctx.close(), 400);
  } catch {
    // audio is a convenience; never let it break the page
  }
}

/** Per-device sound preference (default off). */
export function useSoundPreference(): readonly [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState(() => readStorage(SOUND_STORAGE_KEY) === '1');
  const set = useCallback((next: boolean) => {
    writeStorage(SOUND_STORAGE_KEY, next ? '1' : '0');
    setEnabled(next);
  }, []);
  return [enabled, set];
}

/** Subscribe to both request topics and chime on new open requests while sound is on. */
export function useRequestAlerts(soundEnabled: boolean): void {
  const onEvent = useCallback(
    (event: { readonly type: string }) => {
      if (!soundEnabled) return;
      if (event.type === 'attention.created' || event.type === 'vault.confirm.created') playChime();
    },
    [soundEnabled],
  );
  useTopic('attention', onEvent);
  useTopic('vault.confirm', onEvent);
}
