import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './styles.css';
import './director/autopilot.css';
import './director/workflowPointer.css';
import './director/director-link.css';
import './activity.css';
import './layout-safety.css';
import './premium-ui.css';
import './panel-controller.css';
import { App } from './App';
import { DirectorProviderDock } from './director/DirectorProviderDock';
import { StudioPanelController } from './StudioPanelController';

const root = document.getElementById('root');
if (!root) throw new Error('Studio root element was not found.');

createRoot(root).render(
  <StrictMode>
    <ReactFlowProvider>
      <App />
      <DirectorProviderDock />
      <StudioPanelController />
    </ReactFlowProvider>
  </StrictMode>,
);
