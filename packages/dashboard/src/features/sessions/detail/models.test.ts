/** @module features/sessions/detail/models.test — identity chip + tense-aware fallback copy, viewport validation and presets, trace viewer hints, reveal notes, confirm copy */
import { describe, expect, it } from 'bun:test';
import { sessionDetail, sessionSummary } from '../../../../test/fixtures/sessions.ts';
import { deleteConfirm } from '../confirm-copy.ts';
import { revealNote } from './DataDirSection.tsx';
import {
  identityChip,
  identityFallback,
  identityProvenance,
  identitySummary,
  parseIdentity,
} from './identity.ts';
import { pageAt, shotTitle } from './ScreenshotsPanel.tsx';
import { traceViewerHint, traceViewerUrl } from './use-trace-viewer.ts';
import { resolutionOptions, validateViewport } from './viewport.ts';

const IDENTITY = {
  userAgent: 'Mozilla/5.0 Chrome/131',
  brands: [{ brand: 'Chromium', version: '131' }],
  platform: 'Linux',
  deviceMemory: 8,
  chromeMajor: '131',
  geo: {
    locale: 'en-US',
    languages: ['en-US', 'en'],
    countryCode: 'US',
    timezoneId: 'Europe/Paris',
    source: 'host',
  },
  display: {
    screen: { width: 1920, height: 1080 },
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
  },
};

describe('identity', () => {
  it('parses the applied identity and summarises it', () => {
    const s = sessionSummary(1, { identity: IDENTITY });
    const parsed = parseIdentity(s.identity);
    expect(parsed?.geo?.timezoneId).toBe('Europe/Paris');
    expect(identityChip(s, parsed)).toBe('host-coherent');
    expect(identitySummary(s, parsed)).toBe('Linux · Chrome 131 · Europe/Paris · 1280×720');
    expect(identityProvenance(s, parsed ?? IDENTITY_FALLBACK())).toContain("this machine's own");
  });

  it('chooses the chip and tense-aware fallback copy', () => {
    const live = sessionSummary(1, { stealth_recorded: false });
    expect(identityChip(live, null)).toBe('not recorded');
    expect(identityFallback(live)).toBe(
      "This session's stealth settings were not recorded, so what it presented cannot be shown.",
    );
    const closed = sessionSummary(1, { stealth_recorded: false, live: false });
    expect(identityFallback(closed)).toEndWith(' Sessions started from now on record it.');
    expect(identityChip(sessionSummary(1), null)).toBe('no override');
    expect(identityFallback(sessionSummary(1, { live: false }))).toBe(
      "Stealth was on, but no identity override was applied — the browser's own baseline was in use.",
    );
    const off = sessionSummary(1, { stealth: false });
    expect(identityChip(off, null)).toBe('stealth off');
    expect(identityFallback(off)).toBe(
      "This session runs without stealth and presents the browser's native identity.",
    );
  });
});

function IDENTITY_FALLBACK() {
  const parsed = parseIdentity(IDENTITY);
  if (parsed === null) throw new Error('fixture');
  return parsed;
}

describe('viewport form model', () => {
  it('validates bounds and integers', () => {
    expect(validateViewport('1280', '720')).toEqual({
      ok: true,
      value: { width: 1280, height: 720 },
    });
    const bad = validateViewport('199', 'abc');
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.width).toBe('Enter a whole number between 200 and 10000.');
      expect(bad.errors.height).toBeDefined();
    }
    expect(validateViewport('10001', '800').ok).toBe(false);
  });

  it('puts My monitor first without duplicating a preset', () => {
    const options = resolutionOptions({ width: 1920, height: 1080 });
    expect(options[0]?.label).toBe('My monitor · 1920 × 1080');
    expect(options.filter((o) => o.width === 1920 && o.height === 1080)).toHaveLength(1);
    expect(resolutionOptions({ width: 50, height: 20000 })[0]?.label).toBe(
      'My monitor · 200 × 10000',
    );
  });
});

describe('files and trace copy', () => {
  it('explains why the trace viewer is unavailable', () => {
    expect(traceViewerHint(sessionDetail()).hint).toBe(
      'The trace is written when the session closes.',
    );
    expect(traceViewerHint(sessionDetail({ live: false })).enabled).toBe(true);
    const disabled = {
      ...sessionDetail({ live: false }),
      trace: { enabled: false, path: null, viewer_available: false },
    };
    expect(traceViewerHint(disabled).hint).toBe(
      'Tracing is disabled — start the server with --trace or --admin.',
    );
    expect(traceViewerUrl('http://h/api/v1/x?grant=a')).toBe(
      '/trace-viewer/index.html?trace=http%3A%2F%2Fh%2Fapi%2Fv1%2Fx%3Fgrant%3Da',
    );
  });

  it('renders the exact reveal notes', () => {
    const base = { path: '/p', exists: true, desktop: true, opened: false } as const;
    expect(revealNote({ ...base, opened: true })).toBeNull();
    expect(revealNote({ ...base, reason: 'unsupported' })).toBe(
      'No file-manager opener is available on this platform. Copy the path above.',
    );
    expect(revealNote({ ...base, reason: 'failed', detail: 'xdg-open missing' })).toBe(
      'The file manager could not be opened: xdg-open missing. Copy the path above.',
    );
  });

  it('requires the slug for single deletes and the count for bulk deletes', () => {
    expect(deleteConfirm(1, 'shop').requireText).toBe('shop');
    expect(deleteConfirm(3)).toMatchObject({
      requireText: '3',
      confirmLabel: 'Delete 3',
      danger: true,
    });
    expect(deleteConfirm(3).description).toContain(
      'trace.zip, screenshots, the Chromium profile, downloads',
    );
  });
});

describe('screenshot captions', () => {
  const visits = [
    { ts: 300, url: 'https://news.ycombinator.com/news?p=2', title: 'Hacker News' },
    { ts: 200, url: 'https://example.com/', title: '  ' },
    { ts: 100, url: 'https://the-internet.herokuapp.com/login', title: 'The Internet' },
  ];
  it('names the page open at capture time (latest visit at or before it)', () => {
    expect(pageAt(visits, 350)).toEqual({ host: 'news.ycombinator.com', title: 'Hacker News' });
    expect(pageAt(visits, 200)).toEqual({ host: 'example.com', title: null });
    expect(pageAt(visits, 150)?.host).toBe('the-internet.herokuapp.com');
    expect(pageAt(visits, 50)).toBeNull();
    expect(pageAt(undefined, 50)).toBeNull();
  });
  it('falls back to words for what produced the picture', () => {
    expect(shotTitle({ tool: 'screenshot', kind: 'tool' })).toBe('Screenshot');
    expect(shotTitle({ tool: 'click', kind: 'trace' })).toBe('Trace frame · click');
  });
});
