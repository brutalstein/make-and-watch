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
const MIN_AUTOPILOT_ZOOM = 0.46;
const MAX_AUTOPILOT_ZOOM = 1.16;

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
 * Presentation-only camera controller for AI takeover.
 *
 * Search motion widens the shot so distant workflow areas become legible;
 * active drag motion gently tightens it again. The selected semantic node is
 * the anchor, so viewport motion never changes project truth or workspace
 * coordinates. Camera ownership is released as soon as cursor motion settles,
 * allowing explicit focus/fit commands to run without fighting this loop.
 */
export function AutopilotCameraFollower({ state }: AutopilotCameraFollowerProps) {
  const reactFlow = useReactFlow();
  const stateRef = useRef(state);
  const engagedRef = useRef(false);
  const previousCursorRef = useRef<XYPosition | null>(null);
  const motionUntilRef = useRef(0);
  const homeZoomRef = useRef<number | null>(null);
  const surfaceRef = useRef<HTMLElement | null>(null);
  const activeClassRef = useRef(false);
  const engagedClassRef = useRef(false);

  useEffect(() => {
    stateRef.current = state;
    if (!state.visible) {
      engagedRef.current = false;
      previousCursorRef.current = null;
      motionUntilRef.current = 0;
      homeZoomRef.current = null;
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
        homeZoomRef.current = null;
        setFollowingClass(false);
        setEngagedClass(false);
        animationFrame = requestAnimationFrame(tick);
        return;
      }

      const now = performance.now();
      const surfaceRect = surface.getBoundingClientRect();
      const rawCursor = { x: current.x, y: current.y };
      const previousCursor = previousCursorRef.current;
      const cursorTravel = previousCursor ? distance(previousCursor, rawCursor) : 0;
      const cursorMoved = cursorTravel > 0.35;
      previousCursorRef.current = rawCursor;
      if (cursorMoved) motionUntilRef.current = now + MOTION_GRACE_MS;

      if (!engagedRef.current && pointInsideRect(rawCursor, surfaceRect, 4)) {
        engagedRef.current = true;
        homeZoomRef.current = clamp(reactFlow.getViewport().zoom, MIN_AUTOPILOT_ZOOM, MAX_AUTOPILOT_ZOOM);
      }
      setEngagedClass(engagedRef.current);
      if (!engagedRef.current) {
        setFollowingClass(false);
        animationFrame = requestAnimationFrame(tick);
        return;
      }

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
      const anchor = nodeAnchor(selected);
      const selectedScreen = reactFlow.flowToScreenPosition(anchor);
      const cursorWasClipped = distance(rawCursor, visibleCursor) > FOLLOW_EPSILON;
      const safeNodePoint = clampPointToCameraFrame(selectedScreen, frame);
      const desiredScreen = cursorWasClipped ? visibleCursor : safeNodePoint;
      const errorX = desiredScreen.x - selectedScreen.x;
      const errorY = desiredScreen.y - selectedScreen.y;

      const viewport = reactFlow.getViewport();
      const homeZoom = homeZoomRef.current ?? viewport.zoom;
      // Travelling to find a node uses a wider composition. Once the AI presses
      // and starts manipulating the node, tighten the shot slightly so the
      // action feels intentional rather than like a static map pan.
      const targetZoom = clamp(
        current.pressed ? homeZoom * 0.92 : homeZoom * 0.76,
        MIN_AUTOPILOT_ZOOM,
        current.pressed ? 1.04 : 0.92,
      );
      const zoomDelta = boundedStep(targetZoom - viewport.zoom, 0.16, 0.026);
      const nextZoom = clamp(viewport.zoom + zoomDelta, MIN_AUTOPILOT_ZOOM, MAX_AUTOPILOT_ZOOM);
      const needsZoom = Math.abs(nextZoom - viewport.zoom) > 0.001;
      const needsPan = Math.abs(errorX) > FOLLOW_EPSILON || Math.abs(errorY) > FOLLOW_EPSILON;

      setFollowingClass(needsPan || needsZoom);
      if (needsPan || needsZoom) {
        const panGain = current.pressed ? 0.30 : 0.22;
        const maxPanStep = current.pressed ? 44 : 36;
        const stepX = boundedStep(errorX, panGain, maxPanStep);
        const stepY = boundedStep(errorY, panGain, maxPanStep);
        const nextAnchorScreen = {
          x: selectedScreen.x + stepX,
          y: selectedScreen.y + stepY,
        };

        // flowToScreenPosition = flow * zoom + viewport translation + pane
        // offset. Recover that offset from the current transform so zooming can
        // preserve the selected node's screen anchor without visible jumping.
        const paneOffsetX = selectedScreen.x - (anchor.x * viewport.zoom + viewport.x);
        const paneOffsetY = selectedScreen.y - (anchor.y * viewport.zoom + viewport.y);
        const nextViewportX = nextAnchorScreen.x - paneOffsetX - anchor.x * nextZoom;
        const nextViewportY = nextAnchorScreen.y - paneOffsetY - anchor.y * nextZoom;

        void reactFlow.setViewport({
          x: nextViewportX,
          y: nextViewportY,
          zoom: nextZoom,
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
