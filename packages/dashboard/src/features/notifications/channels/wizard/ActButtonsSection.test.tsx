/** @module features/notifications/channels/wizard/ActButtonsSection.test — "Answer from the chat": the switch, disabled with the reason and a way out where presses cannot arrive (Discord webhook, ntfy without a reply topic), the "Allowed people" list (names from the connect step, ids otherwise; add with validation, remove), the ntfy note, axe clean */
import { describe, expect, it } from 'bun:test';
import type { NotificationChannelRules } from '@browserhive/contracts/notifications';
import { useState } from 'react';
import { expectNoA11yViolations } from '../../../../../test/helpers/axe.ts';
import { fireEvent, render, screen } from '../../../../../test/helpers/render.tsx';
import { type ChannelDraft, draftForKind, draftForMode, EMPTY_DRAFT } from '../model.ts';
import { ActButtonsSection, actButtonsBlocker } from './ActButtonsSection.tsx';

const TELEGRAM: ChannelDraft = {
  ...draftForKind(EMPTY_DRAFT, 'telegram', []),
  target: { chat_id: '42' },
  rules: { act_buttons: true, allow_list: ['1111'] },
  people: { '1111': 'Amir G' },
};

function Harness({
  initial,
  onStep,
}: {
  readonly initial: ChannelDraft;
  readonly onStep?: (step: 'platform' | 'connect') => void;
}) {
  const [draft, setDraft] = useState(initial);
  return (
    <>
      <ActButtonsSection
        draft={draft}
        onRules={(rules: NotificationChannelRules) => setDraft((d) => ({ ...d, rules }))}
        errors={{}}
        readOnly={false}
        connection={null}
        onStep={onStep}
      />
      <output data-testid="rules">{JSON.stringify(draft.rules)}</output>
    </>
  );
}

const rules = () => JSON.parse(screen.getByTestId('rules').textContent ?? '{}');

describe('ActButtonsSection', () => {
  it('knows where presses cannot arrive', () => {
    const discord = draftForKind(EMPTY_DRAFT, 'discord', []);
    expect(actButtonsBlocker(discord)).toContain('bot mode');
    expect(actButtonsBlocker(draftForMode(discord, 'bot'))).toBeNull();
    expect(actButtonsBlocker(draftForKind(EMPTY_DRAFT, 'ntfy', []))).toContain('reply topic');
    expect(actButtonsBlocker(TELEGRAM)).toBeNull();
  });

  it('switches act buttons and edits the allowed people', async () => {
    const view = render(<Harness initial={{ ...TELEGRAM, rules: {} }} />);
    const toggle = screen.getByRole('switch', { name: 'Answer from the chat' });
    expect(screen.queryByText('Allowed people')).toBeNull();
    fireEvent.click(toggle);
    expect(rules().act_buttons).toBe(true);
    expect(screen.getByText('Allowed people')).toBeDefined();
    expect(screen.getByText('Nobody can answer yet')).toBeDefined();
    await expectNoA11yViolations(view.container);
  });

  it('adds numeric ids once and removes people', () => {
    render(<Harness initial={TELEGRAM} />);
    expect(screen.getByText('Amir G')).toBeDefined();
    const input = screen.getByLabelText('Add a Telegram user id');
    fireEvent.change(input, { target: { value: 'sam' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert').textContent).toContain('is a number');
    fireEvent.change(input, { target: { value: '1111' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('alert').textContent).toContain('already on the list');
    fireEvent.change(input, { target: { value: '2222' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(rules().allow_list).toEqual(['1111', '2222']);
    expect(screen.getByText('Telegram user id')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Amir G from the allowed people' }));
    expect(rules().allow_list).toEqual(['2222']);
  });

  it('explains a Discord webhook and leads to bot mode', () => {
    const steps: string[] = [];
    render(
      <Harness
        initial={draftForKind(EMPTY_DRAFT, 'discord', [])}
        onStep={(step) => steps.push(step)}
      />,
    );
    const toggle = screen.getByRole('switch', { name: 'Answer from the chat' });
    expect(toggle.hasAttribute('data-disabled')).toBe(true);
    fireEvent.click(toggle);
    expect(rules().act_buttons).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Choose bot mode' }));
    expect(steps).toEqual(['platform']);
  });

  it('tells that ntfy has no allow-list', () => {
    const ntfy = draftForKind(EMPTY_DRAFT, 'ntfy', []);
    render(
      <Harness
        initial={{
          ...ntfy,
          target: { ...ntfy.target, reply_topic: 'bh-reply-abc' },
          rules: { act_buttons: true },
        }}
      />,
    );
    expect(screen.getByText(/ntfy has no accounts/)).toBeDefined();
    expect(screen.queryByText('Allowed people')).toBeNull();
  });
});
