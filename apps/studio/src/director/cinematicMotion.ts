import type { CursorVisualState } from './autopilotTypes';
import { controlledDelay, type AutopilotExecutionControl } from './autopilotControl';

export const AUTOPILOT_PRESENTATION_FPS = 30;
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
  const speed = Math.max(160, options.speedPxPerSecond ?? 720);
  const minimum = Math.max(90, options.minimumMs ?? 220);
  const maximum = Math.max(minimum, options.maximumMs ?? 950);
  const travel = Number.isFinite(distancePx) ? Math.max(0, distancePx) : 0;
  return Math.round(Math.min(maximum, Math.max(minimum, (travel / speed) * 1000)));
}

/**
 * Deterministic bounded presentation loop.
 *
 * Progress is frame-index based, not wall-clock catch-up based. The callback is
 * awaited so React Flow viewport writes cannot accumulate behind cursor/node
 * frames. Thirty FPS is intentionally the ceiling: it is smooth enough for the
 * visible AI operator while leaving the browser main thread headroom for the
 * controlled graph, Inspector, telemetry and user takeover controls.
 */
export async function runDeterministicAnimation(
  durationMs: number,
  control: AutopilotExecutionControl,
  frame: (easedProgress: number, linearProgress: number) => void | Promise<void>,
) {
  const duration = Math.max(100, durationMs);
  const frameCount = Math.max(3, Math.ceil(duration / FRAME_INTERVAL_MS));
  const frameDelay = duration / frameCount;

  await frame(0, 0);
  for (let index = 1; index <= frameCount; index += 1) {
    await controlledDelay(control, frameDelay);
    const linear = index / frameCount;
    await frame(easeInOutCubic(linear), linear);
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
      pressed: false,
      x: from.x + (to.x - from.x) * eased,
      y: from.y + (to.y - from.y) * eased,
      label,
    });
  });
}
