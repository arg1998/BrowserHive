/** @module components/shared/ConfirmDialog.test — focus moves into the dialog, Escape cancels, focus returns, typed confirmation gates the button */

import { describe, expect, it } from 'bun:test';
import { expectNoA11yViolations } from '../../../test/helpers/axe.ts';
import { act, fireEvent, render, screen, waitFor } from '../../../test/helpers/render.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';

describe('ConfirmDialog', () => {
  it('traps focus, cancels on Escape and restores focus to the opener', async () => {
    const results: boolean[] = [];
    const opener = document.createElement('button');
    opener.textContent = 'open';
    document.body.appendChild(opener);
    opener.focus();
    const view = render(
      <ConfirmDialog
        open
        title="Delete session?"
        description="This cannot be undone."
        danger
        onResult={(ok) => results.push(ok)}
      />,
    );
    const dialog = await screen.findByRole('alertdialog');
    await waitFor(() => {
      if (!dialog.contains(document.activeElement)) throw new Error('focus is outside the dialog');
    });
    // Base UI hides the rest of the page with aria-hidden while the modal is open; the opener button
    // stays focusable in the DOM (the modal traps focus instead), which axe reports as aria-hidden-focus.
    await expectNoA11yViolations(document.body, { disable: ['aria-hidden-focus'] });
    await act(async () => {
      fireEvent.keyDown(document.activeElement ?? dialog, { key: 'Escape' });
    });
    await waitFor(() => {
      if (results.length !== 1) throw new Error('no result yet');
    });
    expect(results).toEqual([false]);
    view.rerender(
      <ConfirmDialog open={false} title="Delete session?" onResult={(ok) => results.push(ok)} />,
    );
    await waitFor(() => {
      if (document.activeElement !== opener) throw new Error('focus did not return');
    });
    opener.remove();
  });

  it('requires the typed text before confirming', async () => {
    const results: boolean[] = [];
    render(
      <ConfirmDialog
        open
        title="Delete"
        requireText="shop-a1b2"
        onResult={(ok) => results.push(ok)}
      />,
    );
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'shop-a1b2' } });
    await waitFor(() => expect(confirm.hasAttribute('disabled')).toBe(false));
    fireEvent.click(confirm);
    await waitFor(() => expect(results).toEqual([true]));
  });
});
