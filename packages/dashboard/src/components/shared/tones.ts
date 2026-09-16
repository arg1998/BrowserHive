/** @module components/shared/tones — tone → Tailwind token classes (the only place tones become colours) */
import type { Tone } from '@/lib/status-registry.ts';

/** Class sets per tone. */
export interface ToneClasses {
  readonly soft: string;
  readonly solid: string;
  readonly text: string;
  readonly border: string;
  readonly dot: string;
}

/** Tone classes. */
export const TONE_CLASSES: { readonly [T in Tone]: ToneClasses } = {
  accent: {
    soft: 'bg-accent-bg text-accent-text border-accent-border',
    solid: 'bg-accent-solid text-accent-on-solid',
    text: 'text-accent-text',
    border: 'border-accent-border',
    dot: 'bg-accent-solid',
  },
  success: {
    soft: 'bg-success-bg text-success-text border-success-border',
    solid: 'bg-success-solid text-success-on-solid',
    text: 'text-success-text',
    border: 'border-success-border',
    dot: 'bg-success-solid',
  },
  warn: {
    soft: 'bg-warn-bg text-warn-text border-warn-border',
    solid: 'bg-warn-solid text-warn-on-solid',
    text: 'text-warn-text',
    border: 'border-warn-border',
    dot: 'bg-warn-solid',
  },
  danger: {
    soft: 'bg-danger-bg text-danger-text border-danger-border',
    solid: 'bg-danger-solid text-danger-on-solid',
    text: 'text-danger-text',
    border: 'border-danger-border',
    dot: 'bg-danger-solid',
  },
  vault: {
    soft: 'bg-vault-bg text-vault-text border-vault-border',
    solid: 'bg-vault-solid text-vault-on-solid',
    text: 'text-vault-text',
    border: 'border-vault-border',
    dot: 'bg-vault-solid',
  },
  info: {
    soft: 'bg-info-bg text-info-text border-info-border',
    solid: 'bg-info-solid text-info-on-solid',
    text: 'text-info-text',
    border: 'border-info-border',
    dot: 'bg-info-solid',
  },
  neutral: {
    soft: 'bg-neutral-bg text-neutral-text border-neutral-border',
    solid: 'bg-neutral-solid text-neutral-on-solid',
    text: 'text-neutral-text',
    border: 'border-neutral-border',
    dot: 'bg-neutral-solid',
  },
  muted: {
    soft: 'bg-muted text-muted-foreground border-border dark:bg-white/[0.06]',
    solid: 'bg-muted-foreground text-background',
    text: 'text-muted-foreground',
    border: 'border-border',
    dot: 'bg-muted-foreground',
  },
};
