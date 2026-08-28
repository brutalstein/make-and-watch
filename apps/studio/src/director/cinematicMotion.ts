import type { CursorVisualState } from './autopilotTypes';
import type { AutopilotExecutionControl } from './autopilotControl';

export function easeInOutCubic(value: number) {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

export async function animateCursor(
  from: CursorVisualState,
  to: Pick<CursorVisualState, 'x' | 'y'>,
  durationMs: number,
  label: string,
  control: AutopilotExecutionControl,
  update: (state: CursorVisualState) => void,
) {
  const started = performance.now();
  const duration = Math.max(120, durationMs);

  while (true) {
    await control.checkpoint();
    const elapsed = performance.now() - started;
    const progress = Math.min(1, elapsed / duration);
    const eased = easeInOutCubic(progress);
    update({
      ...from,
      visible: true,
      x: from.x + (to.x - from.x) * eased,
      y: from.y + (to.y - from.y) * eased,
      label,
    });
    if (progress >= 1) break;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}
