import type { Node, ReactFlowInstance, Viewport, XYPosition } from '@xyflow/react';

import type { AutopilotExecutionControl } from './autopilotControl';
import { controlledDelay } from './autopilotControl';
import type { CursorVisualState } from './autopilotTypes';
import { animateCursor, durationForDistance, runDeterministicAnimation } from './cinematicMotion';

const FALLBACK_NODE_WIDTH = 235;
const FALLBACK_NODE_HEIGHT = 82;
const POINTER_SETTLE_MS = 150;
const PRESS_SETTLE_MS = 145;
const RELEASE_SETTLE_MS = 180;
const PAN_GESTURE_GAP_MS = 90;
const MAX_PAN_GESTURES = 18;
const CURSOR_NODE_EPSILON_PX = 1.5;

export interface WorkflowPointerContext {
  control: AutopilotExecutionControl;
  flow: ReactFlowInstance;
  surface: HTMLElement;
  getNode(nodeId: string): Node | undefined;
  updateNodePosition(nodeId: string, position: XYPosition, dragging: boolean): void;
  getCursor(): CursorVisualState;
  setCursor(state: CursorVisualState): void;
}

interface ScreenFrame {
  left: number;
  right: number;
  top: number;
  bottom: number;
  center: XYPosition;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function distance(left: XYPosition, right: XYPosition) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function nodeAnchorOffset(node: Node): XYPosition {
  const width = node.measured?.width ?? FALLBACK_NODE_WIDTH;
  const height = node.measured?.height ?? FALLBACK_NODE_HEIGHT;
  return {
    x: width * 0.50,
    y: Math.min(36, height * 0.44),
  };
}

function nodeFlowAnchor(node: Node, position = node.position): XYPosition {
  const offset = nodeAnchorOffset(node);
  return {
    x: position.x + offset.x,
    y: position.y + offset.y,
  };
}

function workflowFrame(surface: HTMLElement): ScreenFrame {
  const rect = surface.getBoundingClientRect();
  const horizontalInset = clamp(rect.width * 0.13, 64, 124);
  const topInset = clamp(rect.height * 0.15, 58, 104);
  const bottomInset = clamp(rect.height * 0.20, 78, 132);
  const left = rect.left + horizontalInset;
  const right = rect.right - horizontalInset;
  const top = rect.top + topInset;
  const bottom = rect.bottom - bottomInset;
  return {
    left,
    right,
    top,
    bottom,
    center: {
      x: (left + right) * 0.5,
      y: top + (bottom - top) * 0.46,
    },
  };
}

function pointInsideFrame(point: XYPosition, frame: ScreenFrame, padding = 12) {
  return point.x >= frame.left + padding
    && point.x <= frame.right - padding
    && point.y >= frame.top + padding
    && point.y <= frame.bottom - padding;
}

function projectedNodePoint(context: WorkflowPointerContext, node: Node, position = node.position) {
  return context.flow.flowToScreenPosition(nodeFlowAnchor(node, position));
}

function cursorStart(context: WorkflowPointerContext, frame: ScreenFrame, label: string): CursorVisualState {
  const current = context.getCursor();
  if (current.visible) return current;
  return {
    ...current,
    visible: true,
    pressed: false,
    x: frame.center.x,
    y: frame.top + 22,
    label,
  };
}

async function moveCursor(
  context: WorkflowPointerContext,
  target: XYPosition,
  label: string,
  options: { speedPxPerSecond?: number; minimumMs?: number; maximumMs?: number } = {},
) {
  const frame = workflowFrame(context.surface);
  const start = cursorStart(context, frame, label);
  const duration = durationForDistance(distance(start, target), {
    speedPxPerSecond: options.speedPxPerSecond ?? 500,
    minimumMs: options.minimumMs ?? 320,
    maximumMs: options.maximumMs ?? 1100,
  });
  await animateCursor(start, target, duration, label, context.control, context.setCursor);
  context.setCursor({
    ...context.getCursor(),
    visible: true,
    pressed: false,
    x: target.x,
    y: target.y,
    label,
  });
}

async function panGesture(
  context: WorkflowPointerContext,
  delta: XYPosition,
  label: string,
) {
  const frame = workflowFrame(context.surface);
  const startPoint = {
    x: frame.center.x - delta.x * 0.5,
    y: frame.center.y - delta.y * 0.5,
  };
  const endPoint = {
    x: startPoint.x + delta.x,
    y: startPoint.y + delta.y,
  };

  await moveCursor(context, startPoint, label, {
    speedPxPerSecond: 580,
    minimumMs: 260,
    maximumMs: 720,
  });
  await controlledDelay(context.control, 70);

  const startViewport = context.flow.getViewport();
  context.surface.classList.add('flow-surface--ai-panning');
  context.setCursor({
    ...context.getCursor(),
    visible: true,
    pressed: true,
    pulse: context.getCursor().pulse + 1,
    x: startPoint.x,
    y: startPoint.y,
    label,
  });
  await controlledDelay(context.control, PRESS_SETTLE_MS);

  const gestureDuration = durationForDistance(distance(startPoint, endPoint), {
    speedPxPerSecond: 390,
    minimumMs: 420,
    maximumMs: 820,
  });

  try {
    await runDeterministicAnimation(gestureDuration, context.control, async (eased) => {
      const nextViewport: Viewport = {
        x: startViewport.x + delta.x * eased,
        y: startViewport.y + delta.y * eased,
        zoom: startViewport.zoom,
      };
      await context.flow.setViewport(nextViewport);
      context.setCursor({
        ...context.getCursor(),
        visible: true,
        pressed: true,
        x: startPoint.x + delta.x * eased,
        y: startPoint.y + delta.y * eased,
        label,
      });
    });
  } finally {
    context.surface.classList.remove('flow-surface--ai-panning');
  }

  context.setCursor({
    ...context.getCursor(),
    visible: true,
    pressed: false,
    pulse: context.getCursor().pulse + 1,
    x: endPoint.x,
    y: endPoint.y,
    label,
  });
  await controlledDelay(context.control, PAN_GESTURE_GAP_MS);
}

/**
 * Finds a node the same way a human would when the workspace is larger than
 * the visible viewport: grab empty workflow space, pan it in bounded gestures,
 * release, then move the pointer onto the node itself.
 *
 * No hidden camera follower participates. This makes the visible cursor
 * coordinate and the logical cursor coordinate identical at all times.
 */
export async function pointCursorAtWorkflowNode(
  context: WorkflowPointerContext,
  nodeId: string,
  label: string,
) {
  const node = context.getNode(nodeId);
  if (!node) throw new Error(`workflow node ${nodeId} does not exist`);

  for (let gesture = 0; gesture < MAX_PAN_GESTURES; gesture += 1) {
    await context.control.checkpoint();
    const currentNode = context.getNode(nodeId) ?? node;
    const frame = workflowFrame(context.surface);
    const screenPoint = projectedNodePoint(context, currentNode);
    if (pointInsideFrame(screenPoint, frame)) break;

    const required = {
      x: frame.center.x - screenPoint.x,
      y: frame.center.y - screenPoint.y,
    };
    const frameWidth = frame.right - frame.left;
    const frameHeight = frame.bottom - frame.top;
    const delta = {
      x: clamp(required.x, -frameWidth * 0.62, frameWidth * 0.62),
      y: clamp(required.y, -frameHeight * 0.58, frameHeight * 0.58),
    };
    await panGesture(context, delta, `Finding ${label}`);
  }

  const finalNode = context.getNode(nodeId) ?? node;
  const frame = workflowFrame(context.surface);
  const target = projectedNodePoint(context, finalNode);
  if (!pointInsideFrame(target, frame, 4)) {
    throw new Error(`workflow node ${nodeId} could not be brought into the visible interaction frame`);
  }

  await moveCursor(context, target, label, {
    speedPxPerSecond: 460,
    minimumMs: 360,
    maximumMs: 1180,
  });

  // Snap to the freshly projected anchor after all viewport writes. This is the
  // key invariant the previous follower-based design could not guarantee.
  const exactNode = context.getNode(nodeId) ?? finalNode;
  const exactTarget = projectedNodePoint(context, exactNode);
  context.setCursor({
    ...context.getCursor(),
    visible: true,
    pressed: false,
    x: exactTarget.x,
    y: exactTarget.y,
    label,
  });
  await controlledDelay(context.control, POINTER_SETTLE_MS);

  const cursor = context.getCursor();
  if (distance(cursor, exactTarget) > CURSOR_NODE_EPSILON_PX) {
    throw new Error(`virtual cursor failed to settle on workflow node ${nodeId}`);
  }
}

/**
 * Full deterministic pick-and-place interaction:
 *   find -> hover -> press -> drag node and pointer together -> release.
 *
 * The viewport is intentionally fixed while the node is held. Every drag frame
 * projects the node's exact flow-space anchor back to screen space and places
 * the cursor at that same coordinate, so there is no delta*zoom drift.
 */
export async function dragWorkflowNodeWithPointer(
  context: WorkflowPointerContext,
  nodeId: string,
  to: XYPosition,
  durationMs: number,
  label: string,
) {
  await pointCursorAtWorkflowNode(context, nodeId, label);
  const source = context.getNode(nodeId);
  if (!source) throw new Error(`workflow node ${nodeId} disappeared before drag`);
  const sourcePosition = { ...source.position };

  const startAnchor = projectedNodePoint(context, source, sourcePosition);
  context.setCursor({
    ...context.getCursor(),
    visible: true,
    pressed: true,
    pulse: context.getCursor().pulse + 1,
    x: startAnchor.x,
    y: startAnchor.y,
    label,
  });
  await controlledDelay(context.control, PRESS_SETTLE_MS);

  await runDeterministicAnimation(durationMs, context.control, (eased) => {
    const nextPosition = {
      x: sourcePosition.x + (to.x - sourcePosition.x) * eased,
      y: sourcePosition.y + (to.y - sourcePosition.y) * eased,
    };
    context.updateNodePosition(nodeId, nextPosition, true);
    const pointer = projectedNodePoint(context, source, nextPosition);
    context.setCursor({
      ...context.getCursor(),
      visible: true,
      pressed: true,
      x: pointer.x,
      y: pointer.y,
      label,
    });
  });

  context.updateNodePosition(nodeId, to, false);
  const finalPointer = projectedNodePoint(context, source, to);
  context.setCursor({
    ...context.getCursor(),
    visible: true,
    pressed: false,
    pulse: context.getCursor().pulse + 1,
    x: finalPointer.x,
    y: finalPointer.y,
    label,
  });
  await controlledDelay(context.control, RELEASE_SETTLE_MS);

  const cursor = context.getCursor();
  if (distance(cursor, finalPointer) > CURSOR_NODE_EPSILON_PX) {
    throw new Error(`virtual cursor lost workflow node ${nodeId} during drop`);
  }
}
