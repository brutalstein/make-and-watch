import { useSyncExternalStore } from 'react';
import { Bot, MousePointer2 } from 'lucide-react';

import type { CursorVisualState } from './autopilotTypes';

export const INITIAL_VIRTUAL_CURSOR_STATE: CursorVisualState = {
  visible: false,
  x: 0,
  y: 0,
  pressed: false,
  pulse: 0,
  label: '',
};

let cursorSnapshot: CursorVisualState = INITIAL_VIRTUAL_CURSOR_STATE;
const cursorListeners = new Set<() => void>();

export function getVirtualCursorState() {
  return cursorSnapshot;
}

export function setVirtualCursorState(next: CursorVisualState) {
  if (Object.is(next, cursorSnapshot)) return;
  cursorSnapshot = next;
  for (const listener of cursorListeners) listener();
}

function subscribeVirtualCursor(listener: () => void) {
  cursorListeners.add(listener);
  return () => cursorListeners.delete(listener);
}

/**
 * The rendered pointer position is the authoritative presentation coordinate.
 * It is deliberately NOT clamped to a camera safe frame. Clamping made the
 * visible pointer diverge from the logical pointer and was the root cause of
 * apparently grabbing empty space while the interaction code believed it was
 * on a node. Workspace navigation now keeps the real pointer inside the visible
 * interaction frame explicitly.
 */
export function VirtualCursor() {
  const state = useSyncExternalStore(
    subscribeVirtualCursor,
    getVirtualCursorState,
    getVirtualCursorState,
  );

  if (!state.visible) return null;

  const flipLabelX = state.x > window.innerWidth - 280;
  const flipLabelY = state.y > window.innerHeight - 100;

  return (
    <div
      className={`ai-cursor ${state.pressed ? 'ai-cursor--pressed' : ''} ${flipLabelX ? 'ai-cursor--label-left' : ''} ${flipLabelY ? 'ai-cursor--label-above' : ''}`}
      style={{ transform: `translate3d(${state.x}px, ${state.y}px, 0)` }}
      aria-hidden="true"
    >
      <div className="ai-cursor__trail" />
      <div className="ai-cursor__pointer">
        <MousePointer2 size={25} strokeWidth={1.8} />
        <span className="ai-cursor__bot"><Bot size={10} strokeWidth={2.4} /></span>
      </div>
      <span className="ai-cursor__ripple" key={state.pulse} />
      {state.label ? <span className="ai-cursor__label">{state.label}</span> : null}
    </div>
  );
}
