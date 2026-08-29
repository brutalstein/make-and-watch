import type { Node, ReactFlowInstance, Viewport, XYPosition } from '@xyflow/react';

import type { AutopilotExecutionControl } from './autopilotControl';
import { controlledDelay } from './autopilotControl';
import type { CursorVisualState } from './autopilotTypes';
import { animateCursor, durationForDistance, runDeterministicAnimation } from './cinematicMotion';

const FALLBACK_NODE_WIDTH = 235;
const FALLBACK_NODE_HEIGHT = 82;
const POINTER_SETTLE_MS = 72;
const PRESS_SETTLE_MS = 82;
const RELEASE_SETTLE_MS = 92;
const PAN_GESTURE_GAP_MS = 42;
const MAX_PAN_GESTURES = 14;
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

function lerp(from: number, to: number, amount: number) {
  return from + (to - from) * amount;
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
  const horizontalInset = clamp(rect.width * 0.12, 58, 112);
  const topInset = clamp(rect.height * 0.14, 54, 94);
  const bottomInset = clamp(rect.height * 0.18, 68, 116);
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
      x: left + (right - left) * 0.52,
      y: top + (bottom - top) * 0.47,
    },
  };
}

function pointInsideFrame(point: XYPosition, frame: ScreenFrame, padding = 10) {
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
    y: frame.top + 18,
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
    speedPxPerSecond: options.speedPxPerSecond ?? 820,
    minimumMs: options.minimumMs ?? 170,
    maximumMs: options.maximumMs ?? 680,
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
    x: frame.center.x - delta.x * 0.42,
    y: frame.center.y - delta.y * 0.42,
  };
  const endPoint = {
    x: startPoint.x + delta.x,
    y: startPoint.y + delta.y,
  };

  await moveCursor(context, startPoint, label, {
    speedPxPerSecond: 920,
    minimumMs: 150,
    maximumMs: 440,
  });
  await controlledDelay(context.control, 38);

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
  await controlledDelay(context.control, 58);

  const gestureDuration = durationForDistance(distance(startPoint, endPoint), {
    speedPxPerSecond: 690,
    minimumMs: 220,
    maximumMs: 520,
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
 * Finds an off-screen node using visible bounded workflow-pan gestures, then
 * lands the logical/rendered virtual pointer on the freshly projected node
 * anchor. No hidden camera follower and no coordinate clamping participate.
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
      x: clamp(required.x, -frameWidth * 0.72, frameWidth * 0.72),
      y: clamp(required.y, -frameHeight * 0.68, frameHeight * 0.68),
    };
    await panGesture(context, delta, `Finding ${label}`);
  }

  const finalNode = context.getNode(nodeId) ?? node;
  const frame = workflowFrame(context.surface);
  const target = projectedNodePoint(context, finalNode);
  if (!pointInsideFrame(target, frame, 2)) {
    throw new Error(`workflow node ${nodeId} could not be brought into the visible interaction frame`);
  }

  await moveCursor(context, target, label, {
    speedPxPerSecond: 760,
    minimumMs: 190,
    maximumMs: 720,
  });

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
 * Exact cursor-centric pick-and-place.
 *
 * After the grab, the camera and graph move with the held node. During the
 * first part of the drag the held node/cursor smoothly enter the workflow focal
 * point, then remain there while the canvas travels underneath. Every viewport
 * write is awaited, and the cursor is reprojected from the exact node flow
 * anchor after that write, so pointer, node and camera cannot drift apart.
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
  const frame = workflowFrame(context.surface);
  const startAnchor = projectedNodePoint(context, source, sourcePosition);
  const focalPoint = frame.center;

  context.surface.classList.add('flow-surface--ai-drag-follow');
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

  try {
    await runDeterministicAnimation(durationMs, context.control, async (eased, linear) => {
      const nextPosition = {
        x: sourcePosition.x + (to.x - sourcePosition.x) * eased,
        y: sourcePosition.y + (to.y - sourcePosition.y) * eased,
      };
      context.updateNodePosition(nodeId, nextPosition, true);

      const focusProgress = Math.min(1, linear * 3.6);
      const desiredScreen = {
        x: lerp(startAnchor.x, focalPoint.x, focusProgress),
        y: lerp(startAnchor.y, focalPoint.y, focusProgress),
      };
      const anchorFlow = nodeFlowAnchor(source, nextPosition);
      const projectedBefore = context.flow.flowToScreenPosition(anchorFlow);
      const viewport = context.flow.getViewport();
      const nextViewport: Viewport = {
        x: viewport.x + desiredScreen.x - projectedBefore.x,
        y: viewport.y + desiredScreen.y - projectedBefore.y,
        zoom: viewport.zoom,
      };
      await context.flow.setViewport(nextViewport);

      const exactPointer = context.flow.flowToScreenPosition(anchorFlow);
      context.setCursor({
        ...context.getCursor(),
        visible: true,
        pressed: true,
        x: exactPointer.x,
        y: exactPointer.y,
        label,
      });
    });
  } finally {
    context.surface.classList.remove('flow-surface--ai-drag-follow');
  }

  context.updateNodePosition(nodeId, to, false);
  const finalPointer = context.flow.flowToScreenPosition(nodeFlowAnchor(source, to));
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
