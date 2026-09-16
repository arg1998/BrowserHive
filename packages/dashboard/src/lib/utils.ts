/** @module lib/utils — `cn()`: clsx + tailwind-merge class composition used by every component */
import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge conditional class lists, resolving Tailwind conflicts (later wins). */
export function cn(...inputs: readonly ClassValue[]): string {
  return twMerge(clsx(inputs));
}
