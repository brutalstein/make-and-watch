import { Bot, MousePointer2 } from 'lucide-react';

import type { CursorVisualState } from './autopilotTypes';

interface VirtualCursorProps {
  state: CursorVisualState;
}

export function VirtualCursor({ state }: VirtualCursorProps) {
  if (!state.visible) return null;

  return (
    <div
      className={`ai-cursor ${state.pressed ? 'ai-cursor--pressed' : ''}`}
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
