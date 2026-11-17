/** @module features/templates/RemoteOperatorBanner — the remote-operator notice of every action that opens a window on the BrowserHive machine (spec 13 §3.11): shown when this dashboard reaches BrowserHive at an address that is not this device, with the VNC hint for a server without a screen */
import { Callout } from '@/components/shared/Callout.tsx';
import { docsUrl } from '@/lib/links.ts';
import { remoteHost } from './model.ts';

/** The machine BrowserHive runs on when it is not this device (`null` on a loopback address). */
export function useRemoteHost(): string | null {
  return typeof window === 'undefined' ? null : remoteHost(window.location);
}

/**
 * Notice; renders nothing for a local operator. `host` overrides the detected address (tests);
 * `machineName` is the server's own name for itself (`TemplateDetailResponse.machine.name`), used in
 * the sentence when known.
 */
export function RemoteOperatorBanner({
  host,
  machineName,
  action = 'This opens a window',
  className,
}: {
  readonly host?: string | null;
  readonly machineName?: string;
  /** What the action does, for the sentence ("Re-login opens a window"). */
  readonly action?: string;
  readonly className?: string;
}) {
  const detected = useRemoteHost();
  const address = host === undefined ? detected : host;
  if (address === null) return null;
  const title =
    machineName !== undefined && machineName !== ''
      ? `${action} on ${machineName}, the machine running BrowserHive, not on this device`
      : `${action} on ${address}, not on this device`;
  return (
    <Callout tone="info" title={title} {...(className !== undefined && { className })}>
      <p>
        Sign in where BrowserHive runs: at that machine’s screen, or through a remote desktop to it.
        On a server without a screen, connect a VNC viewer to its virtual display first.{' '}
        <a
          href={docsUrl('templatesVnc')}
          target="_blank"
          rel="noreferrer"
          className="text-link underline decoration-link/40 underline-offset-2 hover:decoration-link"
        >
          Signing in on a server
        </a>
      </p>
    </Callout>
  );
}
