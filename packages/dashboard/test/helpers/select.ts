/** @module test/helpers/select — drive a Base UI `Select` (`SimpleSelect`) like a user: open the trigger, click an option */
import { act, fireEvent, screen } from './render.tsx';

/** Open `trigger` and pick the option whose accessible name matches `name`. */
export async function pickOption(trigger: HTMLElement, name: string | RegExp): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(trigger, { pointerType: 'mouse', button: 0 });
    fireEvent.mouseDown(trigger, { button: 0 });
    fireEvent.pointerUp(trigger, { pointerType: 'mouse', button: 0 });
    fireEvent.mouseUp(trigger, { button: 0 });
    fireEvent.click(trigger);
  });
  const option = await screen.findByRole('option', { name });
  await act(async () => {
    fireEvent.pointerDown(option, { pointerType: 'mouse', button: 0 });
    fireEvent.mouseDown(option, { button: 0 });
    fireEvent.pointerUp(option, { pointerType: 'mouse', button: 0 });
    fireEvent.mouseUp(option, { button: 0 });
    fireEvent.click(option);
  });
}
