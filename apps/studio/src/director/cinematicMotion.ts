import type { CursorVisualState } from './autopilotTypes';
import type { AutopilotExecutionControl } from './autopilotControl';

export function easeInOutCubic(value: number) {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

async function runControlledAnimation(
  durationMs: number,
  control: AutopilotExecutionControl,
  frame: (easedProgress: number) => void,
) {
  const duration = Math.max(120, durationMs);
  let elapsed = 0;
  let previous = performance.now();

  frame(0);
  while (elapsed < duration) {
    await control.checkpoint();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await control.checkpoint();

    const now = performance.now();
    // Pauses and background-tab suspension are not animation time. Limiting
    // frame contribution prevents a resumed cursor from teleporting to the end.
    elapsed += Math.min(34, Math.max(0, now - previous));
    previous = now;
    const progress = Math.min(1, elapsed / duration);
    frame(easeInOutCubic(progress));
  }
}

export async function animateCursor(
  from: CursorVisualState,
  to: Pick<CursorVisualState, 'x' | 'y'>,
  durationMs: number,
  label: string,
  control: AutopilotExecutionControl,
  update: (state: CursorVisualState) => void,
) {
  await runControlledAnimation(durationMs, control, (eased) => {
    update({
      ...from,
      visible: true,
      x: from.x + (to.x - from.x) * eased,
      y: from.y + (to.y - from.y) * eased,
      label,
    });
  });
}
