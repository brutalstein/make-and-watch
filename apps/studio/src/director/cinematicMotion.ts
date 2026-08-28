import type { CursorVisualState } from './autopilotTypes';
import { controlledDelay, type AutopilotExecutionControl } from './autopilotControl';

export const AUTOPILOT_PRESENTATION_FPS = 24;
const FRAME_INTERVAL_MS = 1000 / AUTOPILOT_PRESENTATION_FPS;

export function easeInOutCubic(value: number) {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

export function durationForDistance(
  distancePx: number,
  options: { speedPxPerSecond?: number; minimumMs?: number; maximumMs?: number } = {},
) {
  const speed = Math.max(120, options.speedPxPerSecond ?? 520);
  const minimum = Math.max(120, options.minimumMs ?? 420);
  const maximum = Math.max(minimum, options.maximumMs ?? 1500);
  const travel = Number.isFinite(distancePx) ? Math.max(0, distancePx) : 0;
  return Math.round(Math.min(maximum, Math.max(minimum, (travel / speed) * 1000)));
}

/**
 * Runs a fixed number of presentation updates for a given duration.
 *
 * Progress is frame-index based instead of wall-clock based, so a busy render,
 * pause, or background-tab stall slows the animation rather than skipping
 * forward. Capping presentation updates at 24 FPS also prevents high-frequency
 * React/React Flow state churn from starving the UI thread.
 */
export async function runDeterministicAnimation(
  durationMs: number,
  control: AutopilotExecutionControl,
  frame: (easedProgress: number, linearProgress: number) => void,
) {
  const duration = Math.max(160, durationMs);
  const frameCount = Math.max(4, Math.ceil(duration / FRAME_INTERVAL_MS));
  const frameDelay = duration / frameCount;

  frame(0, 0);
  for (let index = 1; index <= frameCount; index += 1) {
    await controlledDelay(control, frameDelay);
    const linear = index / frameCount;
    frame(easeInOutCubic(linear), linear);
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
  await runDeterministicAnimation(durationMs, control, (eased) => {
    update({
      ...from,
      visible: true,
      x: from.x + (to.x - from.x) * eased,
      y: from.y + (to.y - from.y) * eased,
      label,
    });
  });
}
