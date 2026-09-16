/** @module features/theme/ThemePage — dev-only token gallery: every token pair in both themes with computed WCAG ratios (spec 04 §9) */
import { useEffect, useState } from 'react';
import { Stack } from '@/components/shared/layout.tsx';
import { PageHeader } from '@/components/shared/PageHeader.tsx';
import { StatusBadge } from '@/components/shared/StatusBadge.tsx';
import { Button } from '@/components/ui/button.tsx';
import { cn } from '@/lib/utils.ts';
import { contrastOf } from './contrast.ts';

const HUES = ['success', 'warn', 'danger', 'vault', 'info', 'neutral'] as const;
const SPINE_PAIRS: readonly (readonly [string, string, number])[] = [
  ['--foreground', '--background', 4.5],
  ['--card-foreground', '--card', 4.5],
  ['--popover-foreground', '--popover', 4.5],
  ['--muted-foreground', '--background', 4.5],
  ['--muted-foreground', '--card', 4.5],
  ['--primary-foreground', '--primary', 4.5],
  ['--primary', '--background', 3],
  ['--destructive', '--background', 3],
  ['--ring', '--background', 3],
  ['--ring', '--card', 3],
  ['--input', '--background', 3],
  ['--sidebar-foreground', '--sidebar', 4.5],
  ['--chart-axis', '--background', 3],
];

interface Pair {
  readonly fg: string;
  readonly bg: string;
  readonly min: number;
}

function buildPairs(): readonly Pair[] {
  const pairs: Pair[] = SPINE_PAIRS.map(([fg, bg, min]) => ({ fg, bg, min }));
  for (const hue of HUES) {
    pairs.push({ fg: `--${hue}-text`, bg: '--background', min: 4.5 });
    pairs.push({ fg: `--${hue}-text`, bg: '--card', min: 4.5 });
    pairs.push({ fg: `--${hue}-text`, bg: `--${hue}-bg`, min: 4.5 });
    pairs.push({ fg: `--${hue}-solid`, bg: '--background', min: 3 });
    pairs.push({ fg: `--${hue}-border`, bg: '--background', min: 3 });
    pairs.push({ fg: `--${hue}-on-solid`, bg: `--${hue}-solid`, min: 4.5 });
  }
  for (let i = 1; i <= 6; i += 1) pairs.push({ fg: `--chart-${i}`, bg: '--background', min: 3 });
  return pairs;
}

const PAIRS: readonly Pair[] = buildPairs();
const TOKEN_NAMES = [...new Set(PAIRS.flatMap((p) => [p.fg, p.bg]))];

/** Read a token value under a given theme by mounting a probe element. */
function readTokens(theme: 'light' | 'dark', names: readonly string[]): Record<string, string> {
  const probe = document.createElement('div');
  probe.setAttribute('data-theme', theme);
  document.body.appendChild(probe);
  const styles = getComputedStyle(probe);
  const out: Record<string, string> = {};
  for (const name of names) out[name] = styles.getPropertyValue(name).trim();
  probe.remove();
  return out;
}

function Swatches({ theme }: { readonly theme: 'light' | 'dark' }) {
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    setValues(readTokens(theme, TOKEN_NAMES));
  }, [theme]);
  return (
    <div data-theme={theme} className="rounded-lg border bg-background p-4 text-foreground">
      <h2 className="mb-3 text-md font-semibold capitalize">{theme}</h2>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="py-1">Foreground</th>
            <th className="py-1">Background</th>
            <th className="py-1 text-right">Ratio</th>
            <th className="py-1 text-right">Min</th>
          </tr>
        </thead>
        <tbody>
          {PAIRS.map((pair) => {
            const ratio = contrastOf(values[pair.fg] ?? '', values[pair.bg] ?? '');
            const ok = ratio !== null && ratio >= pair.min;
            return (
              <tr key={`${pair.fg}/${pair.bg}`} className="border-t">
                <td className="py-1 font-mono text-xs">
                  <span
                    className="mr-2 inline-block size-3 rounded-sm border align-middle"
                    style={{ background: `var(${pair.fg})` }}
                  />
                  {pair.fg}
                </td>
                <td className="py-1 font-mono text-xs">
                  <span
                    className="mr-2 inline-block size-3 rounded-sm border align-middle"
                    style={{ background: `var(${pair.bg})` }}
                  />
                  {pair.bg}
                </td>
                <td
                  className={cn(
                    'py-1 text-right tabular-nums',
                    ok ? 'text-success-text' : 'text-danger-text',
                  )}
                >
                  {ratio === null ? '—' : ratio.toFixed(2)}
                </td>
                <td className="py-1 text-right tabular-nums text-muted-foreground">{pair.min}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-4 flex flex-wrap gap-2">
        <StatusBadge domain="session" value="live" />
        <StatusBadge domain="session" value="attention" />
        <StatusBadge domain="session" value="crashed" />
        <StatusBadge domain="request" value="pending" />
        <StatusBadge domain="vaultResult" value="success" />
        <StatusBadge domain="urlCategory" value="ip" />
        <Button size="sm">Primary</Button>
        <Button size="sm" variant="outline">
          Outline
        </Button>
        <Button size="sm" variant="destructive">
          Destructive
        </Button>
      </div>
    </div>
  );
}

/** Theme gallery. */
export function ThemePage() {
  return (
    <Stack gap={6} className="px-gutter py-6">
      <PageHeader
        title="Theme tokens"
        description="Every text/background pair and hue step with its WCAG ratio in both themes."
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <Swatches theme="light" />
        <Swatches theme="dark" />
      </div>
    </Stack>
  );
}
