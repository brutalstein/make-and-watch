import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import './director/autopilot.css';
import './director/workflowPointer.css';
import './director/director-link.css';
import './director/conversation-archive.css';
import './activity.css';
import './layout-safety.css';
import './premium-ui.css';
import './panel-controller.css';
import './react-flow-attribution.css';
import './workflow-manager.css';
import { App } from './App';
import { DirectorProviderDock } from './director/DirectorProviderDock';
import { ReactFlowAttribution } from './ReactFlowAttribution';
import { StudioPanelController } from './StudioPanelController';
import { WorkflowManagerDock } from './WorkflowManagerDock';

const REACT_FLOW_ATTRIBUTION_WARNING = 'React Flow: It seems like you are hiding the attribution.';
const originalConsoleWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  const first = String(args[0] ?? '');
  if (first.startsWith(REACT_FLOW_ATTRIBUTION_WARNING)) return;
  originalConsoleWarn(...args);
};

const root = document.getElementById('root');
if (!root) throw new Error('Studio root element was not found.');

createRoot(root).render(
  <StrictMode>
    <ReactFlowProvider>
      <App />
      <ReactFlowAttribution />
      <DirectorProviderDock />
      <WorkflowManagerDock />
      <StudioPanelController />
    </ReactFlowProvider>
  </StrictMode>,
);
