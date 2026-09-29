/** @module features/notifications/channels/wizard/ReportsSection.test — the Reports section (D-43, D-44): Off · Every day · Every week, the time and weekday, the next run in the channel's zone, the zone picker defaulting to the host's (and replacing an older quiet-hours zone), the anomaly switch with its checks, the thresholds in Advanced, axe clean */
import { describe, expect, it } from 'bun:test';
import type { NotificationChannelRules } from '@browserhive/contracts/notifications';
import { useState } from 'react';
import { expectNoA11yViolations } from '../../../../../test/helpers/axe.ts';
import { fireEvent, render, screen } from '../../../../../test/helpers/render.tsx';
import { AnomalyThresholds, checkOff, ReportsSection } from './ReportsSection.tsx';

/** 29 Sep 2026 12:00 UTC (14:00 in Berlin). */
const NOW = Date.UTC(2026, 8, 29, 12);

function Harness({ initial }: { readonly initial: NotificationChannelRules }) {
  const [rules, setRules] = useState(initial);
  return (
    <>
      <ReportsSection
        rules={rules}
        onRules={setRules}
        hostZone="Europe/Berlin"
        readOnly={false}
        errors={{}}
        now={NOW}
      />
      <output data-testid="rules">{JSON.stringify(rules)}</output>
    </>
  );
}

const rules = () => JSON.parse(screen.getByTestId('rules').textContent ?? '{}');

describe('ReportsSection', () => {
  it('schedules a daily digest at 09:00 and shows the next one in the channel zone', async () => {
    const view = render(<Harness initial={{}} />);
    expect(screen.getByRole('heading', { name: 'Reports' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Every day' }));
    expect(rules().digest).toEqual({ every: 'day', at: '09:00' });
    // 14:00 in Berlin: the next 09:00 is tomorrow.
    expect(screen.getByText('Wed 30 Sep, 09:00')).toBeDefined();
    fireEvent.change(screen.getByLabelText('At'), { target: { value: '18:30' } });
    expect(rules().digest.at).toBe('18:30');
    expect(screen.getByText('Tue 29 Sep, 18:30')).toBeDefined();
    await expectNoA11yViolations(view.container);
  });

  it('switches to weekly on Friday at 17:00 by default, and off again (D-43)', () => {
    render(<Harness initial={{ digest: { every: 'day', at: '08:00' } }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Every week' }));
    expect(rules().digest).toEqual({ every: 'week', at: '17:00', day: 'fri' });
    // Tue 29 Sep 14:00 in Berlin: this Friday.
    expect(screen.getByText('Fri 2 Oct, 17:00')).toBeDefined();
    expect(screen.getByText(/The last seven days, weekend included/)).toBeDefined();
    expect(screen.queryByRole('checkbox', { name: 'Weekdays only' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    expect(rules().digest).toBeUndefined();
  });

  it('runs every day unless weekdays only is ticked; Monday covers the weekend', async () => {
    const view = render(<Harness initial={{ digest: { every: 'day', at: '09:00' } }} />);
    const box = screen.getByRole('checkbox', { name: 'Weekdays only' });
    expect(box.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(box);
    expect(rules().digest).toEqual({ every: 'day', at: '09:00', weekdays_only: true });
    expect(screen.getByText(/on Monday, the whole weekend/)).toBeDefined();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Weekdays only' }));
    expect(rules().digest).toEqual({ every: 'day', at: '09:00' });
    await expectNoA11yViolations(view.container);
  });

  it('skips the weekend in the next run with weekdays only', () => {
    // Fri 2 Oct 2026 12:00 UTC: the next weekday run is Monday.
    render(
      <ReportsSection
        rules={{ digest: { every: 'day', at: '09:00', weekdays_only: true } }}
        onRules={() => undefined}
        hostZone="Europe/Berlin"
        readOnly={false}
        errors={{}}
        now={Date.UTC(2026, 9, 2, 12)}
      />,
    );
    expect(screen.getByText('Mon 5 Oct, 09:00')).toBeDefined();
  });

  it('speaks of BrowserHive in its in-app form (D-45)', () => {
    render(
      <ReportsSection
        variant="in-app"
        rules={{}}
        onRules={() => undefined}
        hostZone="Europe/Berlin"
        readOnly={false}
        errors={{}}
        now={NOW}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Reports in BrowserHive' })).toBeDefined();
    expect(screen.getByRole('group', { name: 'Digest in BrowserHive' })).toBeDefined();
    expect(screen.getByText(/Digest times follow this zone/)).toBeDefined();
    expect(screen.queryByText(/quiet hours/)).toBeNull();
  });

  it('defaults the zone to the host and names it', () => {
    render(<Harness initial={{}} />);
    const picker = screen.getByLabelText(/Time zone/) as HTMLInputElement;
    expect(picker.value).toBe('Same as BrowserHive (Europe/Berlin)');
    expect(screen.getByText(/Now: Tue 29 Sep, 14:00 in Europe\/Berlin/)).toBeDefined();
  });

  it('shows the next run in a chosen zone', () => {
    render(
      <Harness initial={{ digest: { every: 'day', at: '09:00' }, time_zone: 'Asia/Tokyo' }} />,
    );
    // 21:00 in Tokyo: the next 09:00 there.
    expect(screen.getByText('Wed 30 Sep, 09:00')).toBeDefined();
    expect(screen.getByText(/in Asia\/Tokyo/)).toBeDefined();
  });

  it('switches anomaly alerts on and lists what is checked', async () => {
    const view = render(<Harness initial={{ anomaly: { capacity: false } }} />);
    const list = screen.getByRole('list', { name: 'What is checked' });
    expect(list.textContent).toContain('Many tool calls failing');
    expect(list.textContent).toContain('(off)');
    fireEvent.click(screen.getByRole('switch', { name: 'Tell me when something looks off' }));
    expect(rules().anomaly).toBeUndefined();
    fireEvent.click(screen.getByRole('switch', { name: 'Tell me when something looks off' }));
    expect(rules().anomaly).toEqual({});
    await expectNoA11yViolations(view.container);
  });
});

describe('AnomalyThresholds', () => {
  function Thresholds() {
    const [rule, setRule] = useState<NonNullable<NotificationChannelRules['anomaly']>>({});
    return (
      <>
        <AnomalyThresholds rule={rule} onChange={setRule} readOnly={false} />
        <output data-testid="rule">{JSON.stringify(rule)}</output>
      </>
    );
  }
  const rule = () => JSON.parse(screen.getByTestId('rule').textContent ?? '{}');

  it('tunes a threshold, switches a check off, and falls back to the default when emptied', async () => {
    const view = render(<Thresholds />);
    const rate = screen.getByLabelText(
      'Many tool calls failing: Alert at (% failed)',
    ) as HTMLInputElement;
    expect(rate.placeholder).toBe('20');
    fireEvent.blur(rate, { target: { value: '10' } });
    expect(rule().error_rate).toBe(10);
    fireEvent.blur(rate, { target: { value: '' } });
    expect(rule().error_rate).toBeUndefined();
    fireEvent.click(screen.getByRole('switch', { name: 'Sessions at the limit (maxSessions)' }));
    expect(rule().capacity).toBe(false);
    fireEvent.click(screen.getByRole('switch', { name: 'An attention request waiting too long' }));
    expect(rule().attention_minutes).toBeNull();
    expect(checkOff(rule(), 'attention')).toBe(true);
    await expectNoA11yViolations(view.container);
  });
});
