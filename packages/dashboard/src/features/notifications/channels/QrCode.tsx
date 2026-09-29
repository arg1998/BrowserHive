/** @module features/notifications/channels/QrCode — a QR code for a link (subscribe to an ntfy topic, open the Telegram bot on the phone), drawn as one SVG path from `uqr`'s module matrix; dark modules on a white quiet zone in both themes so phone cameras read it */
import { useMemo } from 'react';
import { encode } from 'uqr';
import { cn } from '@/lib/utils.ts';

/** The SVG path of a QR matrix (one `h1v1h-1z` square per dark module). */
export function qrPath(data: readonly (readonly boolean[])[]): string {
  let d = '';
  data.forEach((row, y) => {
    row.forEach((dark, x) => {
      if (dark) d += `M${x} ${y}h1v1h-1z`;
    });
  });
  return d;
}

/** Props. */
export interface QrCodeProps {
  readonly value: string;
  /** Accessible description ("QR code to open the bot on your phone"). */
  readonly label: string;
  readonly className?: string;
}

/** QR code. */
export function QrCode({ value, label, className }: QrCodeProps) {
  const qr = useMemo(() => encode(value, { ecc: 'M', border: 2 }), [value]);
  const path = useMemo(() => qrPath(qr.data), [qr]);
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
      className={cn('rounded-lg bg-white p-1 text-black shadow-xs ring-1 ring-black/5', className)}
    >
      <path d={path} fill="currentColor" />
    </svg>
  );
}
