import { useEffect, useRef } from 'react';
import { useReactFlow, type Node, type XYPosition } from '@xyflow/react';

import type { CursorVisualState } from './autopilotTypes';

export interface CameraFrame {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const FALLBACK_NODE_WIDTH = 235;
const FALLBACK_NODE_HEIGHT = 82;
const FOLLOW_EPSILON = 1.25;
const MOTION_GRACE_MS = 220;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function distance(left: XYPosition, right: XYPosition) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

export function cameraFrameForSurface(rect: DOMRect | Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>): CameraFrame {
  const horizontalInset = clamp(rect.width * 0.16, 72, 150);
  const topInset = clamp(rect.height * 0.18, 72, 126);
  const bottomInset = clamp(rect.height * 0.16, 64, 116);

  return {
    left: rect.left + horizontalInset,
    right: rect.right - horizontalInset,
    top: rect.top + topInset,
    bottom: rect.bottom - bottomInset,
  };
}

export function clampPointToCameraFrame(point: XYPosition, frame: CameraFrame): XYPosition {
  return {
    x: clamp(point.x, frame.left, frame.right),
    y: clamp(point.y, frame.top, frame.bottom),
  };
}

export function pointInsideRect(point: XYPosition, rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>, padding = 0) {
  return point.x >= rect.left - padding
    && point.x <= rect.right + padding
    && point.y >= rect.top - padding
    && point.y <= rect.bottom + padding;
}

export function resolveVisibleCursorPoint(
  point: XYPosition,
  surfaceRect?: DOMRect | Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'> | null,
): XYPosition {
  if (surfaceRect) return clampPointToCameraFrame(point, cameraFrameForSurface(surfaceRect));

  return {
    x: clamp(point.x, 18, Math.max(18, window.innerWidth - 34)),
    y: clamp(point.y, 18, Math.max(18, window.innerHeight - 34)),
  };
}

function nodeAnchor(node: Node): XYPosition {
  const width = node.measured?.width ?? FALLBACK_NODE_WIDTH;
  const height = node.measured?.height ?? FALLBACK_NODE_HEIGHT;
  return {
    x: node.position.x + width * 0.52,
    y: node.position.y + Math.min(34, height * 0.42),
  };
}

function boundedStep(error: number, gain: number, maximum: number) {
  return clamp(error * gain, -maximum, maximum);
}

interface AutopilotCameraFollowerProps {
  state: CursorVisualState;
}

/**
 * Keeps the AI-operated node and virtual cursor inside a cinematic safe frame.
 *
 * This deliberately follows the selected React Flow node rather than blindly
 * tracking screen coordinates. During a programmatic drag the node remains
 * physically under the clamped cursor while the viewport pans beneath it.
 * The controller only owns presentation state; it never mutates project data.
 */
export function AutopilotCameraFollower({ state }: AutopilotCameraFollowerProps) {
  const reactFlow = useReactFlow();
  const stateRef = useRef(state);
  const engagedRef = useRef(false);
  const previousCursorRef = useRef<XYPosition | null>(null);
  const motionUntilRef = useRef(0);
  const surfaceRef = useRef<HTMLElement | null>(null);
  const activeClassRef = useRef(false);
  const engagedClassRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
    if (!state.visible) {
      engagedRef.current = false;
      previousCursorRef.current = null;
      motionUntilRef.current = 0;
    }
  }, [state]);

  useEffect(() => {
    let animationFrame = 0;

    const setSurfaceClass = (className: string, active: boolean, stateHolder: { current: boolean }) => {
      if (stateHolder.current === active) return;
      stateHolder.current = active;
      surfaceRef.current?.classList.toggle(className, active);
    };

    const setFollowingClass = (active: boolean) => {
      setSurfaceClass('flow-surface--ai-following', active, activeClassRef);
    };

    const setEngagedClass = (active: boolean) => {
      setSurfaceClass('flow-surface--ai-engaged', active, engagedClassRef);
    };

    const tick = () => {
      const current = stateRef.current;
      const takeoverActive = document.querySelector('.studio-shell--autopilot') !== null;
      const surface = surfaceRef.current ?? document.querySelector<HTMLElement>('.flow-surface');
      surfaceRef.current = surface;

      if (!current.visible || !takeoverActive || !surface || !reactFlow.viewportInitialized) {
        engagedRef.current = false;
        previousCursorRef.current = null;
        motionUntilRef.current = 0;
        setFollowingClass(false);
        setEngagedClass(false);
        animationFrame = requestAnimationFrame(tick);
        return;
      }

      const now = performance.now();
      const surfaceRect = surface.getBoundingClientRect();
      const rawCursor = { x: current.x, y: current.y };
      const previousCursor = previousCursorRef.current;
      const cursorMoved = previousCursor ? distance(previousCursor, rawCursor) > 0.35 : false;
      previousCursorRef.current = rawCursor;
      if (cursorMoved) motionUntilRef.current = now + MOTION_GRACE_MS;

      // The cursor initially appears in the top takeover banner. Camera
      // ownership starts only after it actually enters the workflow once, so
      // startup UI choreography cannot unexpectedly move the graph.
      if (!engagedRef.current && pointInsideRect(rawCursor, surfaceRect, 4)) {
        engagedRef.current = true;
      }
      setEngagedClass(engagedRef.current);
      if (!engagedRef.current) {
        setFollowingClass(false);
        animationFrame = requestAnimationFrame(tick);
        return;
      }

      // Camera ownership is transient. A fitView, explicit focus tween, or
      // other viewport command must be free to run once the cursor has stopped.
      // This prevents two independent camera systems from fighting each other.
      const cursorDrivingCamera = current.pressed || cursorMoved || now < motionUntilRef.current;
      if (!cursorDrivingCamera) {
        setFollowingClass(false);
        animationFrame = requestAnimationFrame(tick);
        return;
      }

      const selected = reactFlow.getNodes().find((node) => node.selected);
      if (!selected) {
        setFollowingClass(false);
        animationFrame = requestAnimationFrame(tick);
        return;
      }

      const frame = cameraFrameForSurface(surfaceRect);
      const visibleCursor = clampPointToCameraFrame(rawCursor, frame);
      const selectedScreen = reactFlow.flowToScreenPosition(nodeAnchor(selected));
      const cursorWasClipped = distance(rawCursor, visibleCursor) > FOLLOW_EPSILON;
      const safeNodePoint = clampPointToCameraFrame(selectedScreen, frame);

      // If the raw AI cursor reaches the edge, keep the selected node directly
      // beneath the visible cursor. Otherwise only correct a node that is
      // leaving the camera's safe frame. This creates a dead-zone instead of a
      // nauseating always-centered camera.
      const desired = cursorWasClipped ? visibleCursor : safeNodePoint;
      const errorX = desired.x - selectedScreen.x;
      const errorY = desired.y - selectedScreen.y;
      const needsFollow = Math.abs(errorX) > FOLLOW_EPSILON || Math.abs(errorY) > FOLLOW_EPSILON;

      setFollowingClass(needsFollow);
      if (needsFollow) {
        const viewport = reactFlow.getViewport();
        const gain = current.pressed ? 0.28 : 0.20;
        const maxStep = current.pressed ? 42 : 34;
        const stepX = boundedStep(errorX, gain, maxStep);
        const stepY = boundedStep(errorY, gain, maxStep);

        // No duration here: this controller already runs at animation-frame
        // cadence. Small bounded viewport deltas produce a smooth damped follow
        // and avoid stacking competing React Flow tween promises.
        void reactFlow.setViewport({
          x: viewport.x + stepX,
          y: viewport.y + stepY,
          zoom: viewport.zoom,
        });
      }

      animationFrame = requestAnimationFrame(tick);
    };

    animationFrame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(animationFrame);
      surfaceRef.current?.classList.remove('flow-surface--ai-following', 'flow-surface--ai-engaged');
      activeClassRef.current = false;
      engagedClassRef.current = false;
    };
  }, [reactFlow]);

  return null;
}
