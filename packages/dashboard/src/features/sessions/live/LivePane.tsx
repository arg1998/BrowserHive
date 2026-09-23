/** @module features/sessions/live/LivePane — the live browser: a card whose stage takes the page's own aspect ratio (so the frame fills it instead of floating in black bars) and a stream sized to the pane (`set_size` on resize); a compact toolbar (status pill with stream numbers, current URL, pause, quality, resize viewport, fullscreen, focus, hide); takeover input gated on an open `takeover` request; an ended state that keeps the last frame (spec 04 §13) */
import type { OperatorRequestRow, SessionSummary } from '@browserhive/contracts/http';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StatusDot } from '@/components/shared/StatusBadge.tsx';
import { splitUrl } from '@/components/shared/url-cell.tsx';
import { Button } from '@/components/ui/button.tsx';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.tsx';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.tsx';
import { Spinner } from '@/components/ui/spinner.tsx';
import { Switch } from '@/components/ui/switch.tsx';
import { Hint } from '@/components/ui/tooltip.tsx';
import { stripCredentials } from '@/lib/format/urls.ts';
import { ICONS } from '@/lib/icons.ts';
import { cn } from '@/lib/utils.ts';
import { useSessionMutations } from '../api.ts';
import { parseIdentity } from '../detail/identity.ts';
import { ViewportForm } from '../detail/ViewportForm.tsx';
import { STREAM_SIZES, type StreamSize } from '../detail-search.ts';
import { closedReasonText, sessionEnded } from '../session-format.ts';
import type { Size } from './input-mapping.ts';
import { LIVE_PILL, livePillState, streamStats } from './live-status.ts';
import { readStoredSize, storeSize, streamDims } from './stream-size.ts';
import { useContainerSize } from './use-container-size.ts';
import { useScreencast } from './use-screencast.ts';
import { useTakeover } from './use-takeover.ts';

/** Quality menu labels. */
const SIZE_LABEL: { readonly [K in StreamSize]: string } = {
  fit: 'Auto',
  '720p': '720p',
  '1080p': '1080p',
  native: 'Native',
};

/** Stage aspect before the first frame when the session recorded no viewport. */
const DEFAULT_ASPECT: Size = { width: 16, height: 9 };

/** Props. */
export interface LivePaneProps {
  readonly session: SessionSummary;
  /** The open takeover request (`takeoverRequest()`), `null` when the operator may only watch. */
  readonly takeover: OperatorRequestRow | null;
  /** `false` until the per-session attention query answered (the arm waits for it). */
  readonly gateKnown: boolean;
  readonly vaultEnabled: boolean;
  /** Arm keyboard capture as soon as the gate opens and frames arrive (`?takeover=1`). */
  readonly armTakeover: boolean;
  readonly onArmed: () => void;
  readonly onClose: () => void;
  /**
   * `split`: beside Activity in the fixed-height workspace; the card is as tall as the frame needs
   * and never taller than the pane. `stacked`: full width above Activity, at most 70% of the viewport.
   */
  readonly layout: 'split' | 'stacked';
  /** Split only: "focus live" collapses Activity to a rail. */
  readonly focus?: { readonly on: boolean; readonly onToggle: () => void };
  readonly className?: string;
}

function ToolbarButton({
  label,
  shortcut,
  onClick,
  disabled,
  pressed,
  children,
}: {
  readonly label: string;
  readonly shortcut?: string;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <Hint label={label} shortcut={shortcut}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        disabled={disabled}
        {...(pressed !== undefined && { 'aria-pressed': pressed })}
        onClick={onClick}
      >
        {children}
      </Button>
    </Hint>
  );
}

/** Page size the agent recorded at launch (the stage's aspect before the first frame). */
function launchViewport(session: SessionSummary): Size | null {
  const viewport = parseIdentity(session.identity)?.display?.viewport;
  return viewport !== undefined && viewport.width > 0 && viewport.height > 0 ? viewport : null;
}

/** The URL the agent is on, host emphasised (the stream has no address bar of its own). */
function CurrentUrl({ url }: { readonly url: string | null }) {
  if (url === null || url === '') return null;
  const { host, rest } = splitUrl(stripCredentials(url));
  return (
    <span
      data-testid="live-url"
      className="ml-2 hidden min-w-0 flex-1 truncate font-mono text-sm text-muted-foreground @lg:block"
    >
      <span className="text-foreground/80">{host}</span>
      {rest}
    </span>
  );
}

/** Live pane. */
export function LivePane({
  session,
  takeover: request,
  gateKnown,
  vaultEnabled,
  armTakeover,
  onArmed,
  onClose,
  layout,
  focus,
  className,
}: LivePaneProps) {
  const surfaceRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keyboardRef = useRef<HTMLInputElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [size, setSize] = useState<StreamSize>(() => readStoredSize());
  const ended = sessionEnded(session);
  const box = useContainerSize(stageRef, { width: 1280, height: 720 });
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  const cast = useScreencast({
    sessionId: session.session_id,
    live: !ended,
    ready: box !== null,
    canvasRef,
    dims: streamDims(size, box ?? { width: 1280, height: 720 }, dpr),
  });
  const canTakeover = request !== null && !ended;
  const takeover = useTakeover({
    sessionId: session.session_id,
    enabled: canTakeover && cast.status === 'streaming',
    canvasRef,
    frameSize: cast.frameSize,
    device: cast.device,
  });
  const { setViewport } = useSessionMutations(session.session_id);
  const recorded = useMemo(() => launchViewport(session), [session]);
  const frame = cast.frameSize;
  const aspect: Size =
    frame !== null && frame.width > 0 && frame.height > 0 ? frame : (recorded ?? DEFAULT_ASPECT);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === surfaceRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFullscreen = useCallback(() => {
    const el = surfaceRef.current;
    if (el === null) return;
    if (document.fullscreenElement !== null) void document.exitFullscreen().catch(() => undefined);
    else void el.requestFullscreen?.().catch(() => undefined);
  }, []);
  useEffect(() => {
    if (takeover.capture) canvasRef.current?.focus();
  }, [takeover.capture]);

  // `?takeover=1`: arm keyboard capture once frames arrive and the gate is open; always consume it.
  const { setCapture } = takeover;
  useEffect(() => {
    if (!armTakeover || !gateKnown) return;
    if (!canTakeover) {
      onArmed();
      return;
    }
    if (cast.status !== 'streaming') return;
    setCapture(true);
    onArmed();
  }, [armTakeover, gateKnown, canTakeover, cast.status, setCapture, onArmed]);

  const pill = livePillState(cast.status, cast.stats.ageMs);
  const pillEntry =
    ended && session.live ? { ...LIVE_PILL.ended, label: 'Closing' } : LIVE_PILL[pill];
  const stats = streamStats(cast.frameSize, cast.streamSize, cast.stats);
  const running = cast.status !== 'offline' && cast.status !== 'off';
  const Pause = ICONS.pause;
  const Play = ICONS.play;
  const Full = fullscreen ? ICONS.collapse : ICONS.expand;
  const Close = ICONS.close;
  const Resize = ICONS.resize;
  const Retry = ICONS.retry;
  const VaultIcon = ICONS.vault;
  const Eye = ICONS.show;
  const Chevron = ICONS.chevronDown;
  const KeyboardIcon = ICONS.keyboard;
  const Focus = focus?.on === true ? ICONS.showPanel : ICONS.focusLive;
  const border = canTakeover ? (takeover.capture ? 'capturing' : 'attention') : 'watching';

  const toolbar = (
    <div
      className="flex h-11 shrink-0 items-center gap-1 border-b bg-card px-2"
      role="toolbar"
      aria-label="Live view controls"
    >
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              data-testid="live-status"
              aria-label={`Stream status: ${pillEntry.label}`}
              className="relative inline-flex h-7 shrink-0 cursor-pointer items-center rounded-full px-2 focus-ring after:absolute after:inset-x-0 after:-inset-y-1.5 hover:bg-accent data-popup-open:bg-accent"
            />
          }
        >
          <StatusDot
            entry={{ label: pillEntry.label, tone: pillEntry.tone }}
            pulse={pillEntry.pulse === true}
            className="text-sm font-medium"
          />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 gap-3">
          <p className="text-sm">{pillEntry.hint}</p>
          {!ended && !canTakeover ? (
            <p className="text-sm text-muted-foreground">
              View only: input unlocks when the agent asks for a takeover.
            </p>
          ) : null}
          {stats !== null && !ended ? (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t pt-3 text-sm">
              {stats.map((row) => (
                <div key={row.label} className="contents">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="text-right whitespace-nowrap tabular-nums">{row.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
        </PopoverContent>
      </Popover>
      {!ended && (pill === 'failed' || pill === 'stopped') ? (
        <Button type="button" variant="ghost" size="xs" onClick={cast.retry}>
          <Retry aria-hidden="true" /> Retry
        </Button>
      ) : null}
      {ended ? null : canTakeover ? (
        <span className="ml-1 inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-warn-bg px-2 text-xs font-medium text-warn-text">
          <ICONS.takeover aria-hidden="true" className="size-3.5" />
          Takeover open
        </span>
      ) : (
        <span className="ml-1 hidden shrink-0 items-center gap-1.5 text-sm text-muted-foreground @2xl:inline-flex">
          <Eye aria-hidden="true" className="size-4" />
          View only
        </span>
      )}
      {ended ? <span className="flex-1" /> : <CurrentUrl url={session.current_url} />}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {vaultEnabled && !ended ? (
          <Popover>
            <Hint label="Raw pixels may expose a secret">
              <PopoverTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Raw pixels may expose a secret"
                    className="[&_svg]:text-vault-text"
                  />
                }
              >
                <VaultIcon aria-hidden="true" />
              </PopoverTrigger>
            </Hint>
            <PopoverContent align="end" className="w-72 gap-1.5">
              <p className="text-base font-semibold">Raw pixels</p>
              <p className="text-sm text-muted-foreground">
                The stream shows exactly what the browser renders. Vault fills are masked in tool
                results, not on screen.
              </p>
            </PopoverContent>
          </Popover>
        ) : null}
        {!ended ? (
          <>
            <ToolbarButton
              label={cast.status === 'paused' ? 'Resume stream' : 'Pause stream'}
              onClick={cast.status === 'paused' ? cast.resume : cast.pause}
              disabled={!running}
            >
              {cast.status === 'paused' ? (
                <Play aria-hidden="true" />
              ) : (
                <Pause aria-hidden="true" />
              )}
            </ToolbarButton>
            <DropdownMenu>
              <Hint label="Stream quality">
                <DropdownMenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="gap-1 px-2 text-muted-foreground"
                      aria-label={`Stream quality: ${SIZE_LABEL[size]}`}
                    />
                  }
                >
                  {SIZE_LABEL[size]}
                  <Chevron aria-hidden="true" className="size-3.5" />
                </DropdownMenuTrigger>
              </Hint>
              <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuLabel>Stream quality</DropdownMenuLabel>
                <DropdownMenuRadioGroup
                  value={size}
                  onValueChange={(value: unknown) => {
                    const next = STREAM_SIZES.find((s) => s === value);
                    if (next === undefined) return;
                    storeSize(next);
                    setSize(next);
                  }}
                >
                  {STREAM_SIZES.map((s) => (
                    <DropdownMenuRadioItem key={s} value={s}>
                      {s === 'fit' ? 'Auto (sharp at pane size)' : SIZE_LABEL[s]}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
            <Popover>
              <Hint label="Resize the agent's browser">
                <PopoverTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Resize the agent's browser"
                    />
                  }
                >
                  <Resize aria-hidden="true" />
                </PopoverTrigger>
              </Hint>
              <PopoverContent align="end" className="w-80 overflow-y-auto">
                <ViewportForm
                  compact
                  busy={setViewport.isPending}
                  screen={
                    typeof window === 'undefined'
                      ? undefined
                      : { width: window.screen.width, height: window.screen.height }
                  }
                  onSubmit={(s) => setViewport.mutate(s)}
                />
              </PopoverContent>
            </Popover>
            <ToolbarButton
              label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              onClick={toggleFullscreen}
            >
              <Full aria-hidden="true" />
            </ToolbarButton>
          </>
        ) : null}
        {focus !== undefined && !fullscreen ? (
          <ToolbarButton
            label={focus.on ? 'Show activity beside the live view' : 'Focus the live view'}
            pressed={focus.on}
            onClick={focus.onToggle}
          >
            <Focus aria-hidden="true" />
          </ToolbarButton>
        ) : null}
        {!fullscreen ? (
          <ToolbarButton label="Hide live view" shortcut="L" onClick={onClose}>
            <Close aria-hidden="true" />
          </ToolbarButton>
        ) : null}
      </div>
    </div>
  );

  const overlay = (() => {
    if (ended) {
      // Over the last frame: a dimmed, blurred picture and one legible panel.
      return (
        <div
          role="status"
          className={cn(
            'absolute inset-0 flex items-center justify-center p-4',
            cast.hasFrame && 'bg-black/55 backdrop-blur-[2px]',
          )}
        >
          <div className="flex max-w-sm flex-col items-center gap-3 rounded-xl bg-[oklch(0.2_0.004_250)] px-5 py-4 text-center shadow-lg ring-1 ring-white/10">
            <div className="flex flex-col gap-1">
              <p className="text-base font-semibold text-white">
                {session.live ? 'The session is closing' : 'This session has ended'}
              </p>
              <p className="text-sm text-white/70">
                {session.live
                  ? 'The agent is closing its browser. The last frame stays here.'
                  : `${closedReasonText(session.closed_reason)}. Activity, screenshots and the trace keep what it did.`}
              </p>
            </div>
            <Button type="button" size="sm" variant="secondary" onClick={onClose}>
              Hide live view
            </Button>
          </div>
        </div>
      );
    }
    if (pill === 'connecting' && !cast.hasFrame) {
      return (
        <div
          role="status"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-white/70"
        >
          <Spinner className="size-5 text-white/60" />
          Connecting to the browser…
        </div>
      );
    }
    if (pill === 'failed' || pill === 'stopped') {
      return (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60 px-6 text-center"
        >
          <p className="text-base font-semibold text-white">
            {pill === 'failed' ? 'The live view could not start' : 'The screencast stopped'}
          </p>
          {cast.failure !== null ? (
            <p className="font-mono text-sm text-white/70">{cast.failure}</p>
          ) : null}
          <Button type="button" size="sm" variant="secondary" onClick={cast.retry}>
            <Retry aria-hidden="true" /> Retry
          </Button>
        </div>
      );
    }
    if (pill === 'paused') {
      return (
        <div className="absolute inset-0 flex items-center justify-center bg-black/45">
          <Button type="button" size="sm" variant="secondary" onClick={cast.resume}>
            <Play aria-hidden="true" /> Resume
          </Button>
        </div>
      );
    }
    if (pill === 'reconnecting') {
      return (
        <div role="status" className="absolute inset-x-0 top-3 flex justify-center">
          <span className="inline-flex items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-sm text-white">
            <Spinner className="size-3.5" /> Reconnecting…
          </span>
        </div>
      );
    }
    return null;
  })();

  return (
    <section
      ref={surfaceRef}
      aria-label="Live view"
      data-border={border}
      data-capture={takeover.capture ? 'true' : 'false'}
      data-layout={layout}
      className={cn(
        '@container flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card shadow-xs dark:shadow-none',
        layout === 'split' && 'max-h-full',
        border === 'attention' && 'border-warn-border ring-2 ring-warn-border/60',
        border === 'capturing' && 'border-primary ring-2 ring-primary/40',
        fullscreen && 'h-screen max-h-none rounded-none border-0 ring-0',
        className,
      )}
    >
      {toolbar}
      <div
        ref={stageRef}
        data-testid="live-stage"
        className={cn(
          'relative min-h-0 w-full bg-[oklch(0.17_0.004_250)] dark:bg-black/60',
          fullscreen ? 'flex-1' : 'shrink',
          layout === 'stacked' && !fullscreen && 'max-h-[70dvh]',
          !cast.hasFrame && ended && !fullscreen && 'min-h-56',
        )}
        style={fullscreen ? undefined : { aspectRatio: `${aspect.width} / ${aspect.height}` }}
      >
        {session.live || cast.hasFrame ? (
          <canvas
            ref={canvasRef}
            tabIndex={canTakeover ? 0 : -1}
            role="img"
            aria-label={`Live view of ${session.slug}`}
            className={cn(
              'absolute inset-0 size-full touch-none outline-hidden',
              canTakeover ? 'cursor-crosshair' : 'cursor-default',
            )}
            {...takeover.handlers}
          />
        ) : null}
        {overlay}
        {canTakeover ? (
          <input
            ref={keyboardRef}
            aria-label="Mobile keyboard"
            className="sr-only"
            autoComplete="off"
            onKeyDown={takeover.handlers.onKeyDown}
            onKeyUp={takeover.handlers.onKeyUp}
            onInput={(e) => {
              takeover.sendText(e.currentTarget.value);
              e.currentTarget.value = '';
            }}
          />
        ) : null}
      </div>
      {canTakeover ? (
        <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-1.5 text-sm">
          <label
            htmlFor={`capture-${session.session_id}`}
            className="flex cursor-pointer items-center gap-2 font-medium select-none"
          >
            <Switch
              id={`capture-${session.session_id}`}
              aria-label="Capture keyboard"
              size="sm"
              checked={takeover.capture}
              disabled={cast.status !== 'streaming'}
              onCheckedChange={(on: boolean) => takeover.setCapture(on)}
            />
            Capture keyboard
          </label>
          <span className="min-w-0 flex-1 truncate text-muted-foreground" aria-live="polite">
            {takeover.capture
              ? 'Keys and scrolling go to the page. Shift+Esc releases.'
              : 'Click the page to drive the pointer.'}
          </span>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="Open the on-screen keyboard"
            className="pointer-fine:hidden"
            onClick={() => keyboardRef.current?.focus()}
          >
            <KeyboardIcon aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </section>
  );
}
