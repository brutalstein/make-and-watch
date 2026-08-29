import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Activity, Bot, ChevronLeft, ChevronRight } from 'lucide-react';

const CONTROL_OPEN_KEY = 'makewatch.studio.control-open';
const INSPECTOR_OPEN_KEY = 'makewatch.studio.inspector-open';

function readPreference(key: string, fallback = true) {
  try {
    return window.localStorage.getItem(key) !== '0';
  } catch {
    return fallback;
  }
}

function writePreference(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    // Presentation state is best-effort and never project truth.
  }
}

interface PanelTargets {
  workspace: HTMLElement;
  shell: HTMLElement;
  controlPanel: HTMLElement;
  inspectorPanel: HTMLElement;
  controlHeadingHost: HTMLElement;
  inspectorHeadingHost: HTMLElement;
  controlRailHost: HTMLElement;
  inspectorRailHost: HTMLElement;
}

export function StudioPanelController() {
  const [targets, setTargets] = useState<PanelTargets | null>(null);
  const [controlOpen, setControlOpen] = useState(() => readPreference(CONTROL_OPEN_KEY));
  const [inspectorOpen, setInspectorOpen] = useState(() => readPreference(INSPECTOR_OPEN_KEY));

  useLayoutEffect(() => {
    const shell = document.querySelector<HTMLElement>('.studio-shell');
    const workspace = document.querySelector<HTMLElement>('.workspace');
    const controlPanel = document.querySelector<HTMLElement>('.director-panel');
    const inspectorPanel = document.querySelector<HTMLElement>('.inspector-panel');
    const controlHeading = controlPanel?.querySelector<HTMLElement>('.panel-heading');
    const inspectorHeading = inspectorPanel?.querySelector<HTMLElement>('.panel-heading');
    if (!shell || !workspace || !controlPanel || !inspectorPanel || !controlHeading || !inspectorHeading) return undefined;

    const controlHeadingHost = document.createElement('span');
    const inspectorHeadingHost = document.createElement('span');
    const controlRailHost = document.createElement('div');
    const inspectorRailHost = document.createElement('div');
    controlHeadingHost.className = 'studio-panel-heading-toggle-host';
    inspectorHeadingHost.className = 'studio-panel-heading-toggle-host';
    controlRailHost.className = 'studio-panel-toggle-host studio-panel-toggle-host--control';
    inspectorRailHost.className = 'studio-panel-toggle-host studio-panel-toggle-host--inspector';

    controlHeading.append(controlHeadingHost);
    inspectorHeading.append(inspectorHeadingHost);
    controlPanel.append(controlRailHost);
    inspectorPanel.append(inspectorRailHost);
    setTargets({
      workspace,
      shell,
      controlPanel,
      inspectorPanel,
      controlHeadingHost,
      inspectorHeadingHost,
      controlRailHost,
      inspectorRailHost,
    });

    return () => {
      controlHeadingHost.remove();
      inspectorHeadingHost.remove();
      controlRailHost.remove();
      inspectorRailHost.remove();
      workspace.classList.remove('workspace--control-collapsed', 'workspace--inspector-collapsed');
      shell.classList.remove('studio-shell--control-collapsed', 'studio-shell--inspector-collapsed');
      controlPanel.classList.remove('director-panel--collapsed');
      inspectorPanel.classList.remove('inspector-panel--collapsed');
    };
  }, []);

  useEffect(() => {
    if (!targets) return;
    targets.workspace.classList.toggle('workspace--control-collapsed', !controlOpen);
    targets.workspace.classList.toggle('workspace--inspector-collapsed', !inspectorOpen);
    targets.shell.classList.toggle('studio-shell--control-collapsed', !controlOpen);
    targets.shell.classList.toggle('studio-shell--inspector-collapsed', !inspectorOpen);
    targets.controlPanel.classList.toggle('director-panel--collapsed', !controlOpen);
    targets.inspectorPanel.classList.toggle('inspector-panel--collapsed', !inspectorOpen);
    writePreference(CONTROL_OPEN_KEY, controlOpen);
    writePreference(INSPECTOR_OPEN_KEY, inspectorOpen);
  }, [controlOpen, inspectorOpen, targets]);

  if (!targets) return null;

  return (
    <>
      {controlOpen ? createPortal(
        <button
          className="studio-panel-heading-toggle"
          onClick={() => setControlOpen(false)}
          title="Collapse Creative Control"
          aria-label="Collapse Creative Control"
        ><ChevronLeft size={16} /></button>,
        targets.controlHeadingHost,
      ) : createPortal(
        <button
          className="studio-panel-rail studio-panel-rail--control"
          onClick={() => setControlOpen(true)}
          title="Open Creative Control"
          aria-label="Open Creative Control"
        >
          <span className="studio-panel-rail__icon"><Bot size={18} /></span>
          <span className="studio-panel-rail__label">CONTROL</span>
          <ChevronRight size={16} />
        </button>,
        targets.controlRailHost,
      )}

      {inspectorOpen ? createPortal(
        <button
          className="studio-panel-heading-toggle"
          onClick={() => setInspectorOpen(false)}
          title="Collapse Inspector"
          aria-label="Collapse Inspector"
        ><ChevronRight size={16} /></button>,
        targets.inspectorHeadingHost,
      ) : createPortal(
        <button
          className="studio-panel-rail studio-panel-rail--inspector"
          onClick={() => setInspectorOpen(true)}
          title="Open Inspector"
          aria-label="Open Inspector"
        >
          <ChevronLeft size={16} />
          <span className="studio-panel-rail__label">INSPECTOR</span>
          <span className="studio-panel-rail__icon"><Activity size={18} /></span>
        </button>,
        targets.inspectorRailHost,
      )}
    </>
  );
}
