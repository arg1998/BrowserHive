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

  it('switches to weekly with a weekday, and off again', () => {
    render(<Harness initial={{ digest: { every: 'day', at: '08:00' } }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Every week' }));
    expect(rules().digest).toEqual({ every: 'week', at: '08:00', day: 'mon' });
    expect(screen.getByText('Mon 5 Oct, 08:00')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    expect(rules().digest).toBeUndefined();
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
