import { Bot, MousePointer2 } from 'lucide-react';

import { AutopilotCameraFollower, cameraFrameForSurface, resolveVisibleCursorPoint } from './AutopilotCameraFollower';
import type { CursorVisualState } from './autopilotTypes';

interface VirtualCursorProps {
  state: CursorVisualState;
}

export function VirtualCursor({ state }: VirtualCursorProps) {
  if (!state.visible) return null;

  const surface = document.querySelector<HTMLElement>('.flow-surface');
  const cameraEngaged = surface?.classList.contains('flow-surface--ai-engaged') ?? false;
  const surfaceRect = cameraEngaged ? surface?.getBoundingClientRect() ?? null : null;
  const visible = resolveVisibleCursorPoint({ x: state.x, y: state.y }, surfaceRect);
  const frame = surfaceRect ? cameraFrameForSurface(surfaceRect) : null;
  const flipLabelX = frame
    ? visible.x > frame.right - 230
    : visible.x > window.innerWidth - 280;
  const flipLabelY = frame
    ? visible.y > frame.bottom - 68
    : visible.y > window.innerHeight - 100;

  return (
    <>
      <AutopilotCameraFollower state={state} />
      <div
        className={`ai-cursor ${state.pressed ? 'ai-cursor--pressed' : ''} ${flipLabelX ? 'ai-cursor--label-left' : ''} ${flipLabelY ? 'ai-cursor--label-above' : ''}`}
        style={{ transform: `translate3d(${visible.x}px, ${visible.y}px, 0)` }}
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
    </>
  );
}
