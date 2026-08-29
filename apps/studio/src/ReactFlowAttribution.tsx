import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * The current workflow source predates the Studio sidecar refactor and still sets
 * React Flow's hideAttribution Pro option. Make & Watch does not assume a Pro
 * license, so we render an equivalent visible attribution inside the workflow
 * surface. The exact library warning is filtered in main.tsx only because this
 * component restores the attribution instead of actually hiding it.
 */
export function ReactFlowAttribution() {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    let frame = 0;
    let cancelled = false;
    const findSurface = () => {
      if (cancelled) return;
      const surface = document.querySelector<HTMLElement>('.flow-surface');
      if (surface) {
        setTarget(surface);
        return;
      }
      frame = window.requestAnimationFrame(findSurface);
    };
    findSurface();
    return () => {
      cancelled = true;
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  if (!target) return null;
  return createPortal(
    <a
      className="makewatch-reactflow-attribution"
      href="https://reactflow.dev"
      target="_blank"
      rel="noreferrer"
      aria-label="React Flow"
    >
      React Flow
    </a>,
    target,
  );
}
