export const PROJECT_CHANGED_EVENT = 'makewatch:project-changed';

export interface ProjectChangedDetail {
  projectRevision: number;
  source: 'director-chat' | 'director-reference-import' | 'workflow-manager' | 'autopilot' | 'external';
}

export function announceProjectChanged(detail: ProjectChangedDetail) {
  window.dispatchEvent(new CustomEvent<ProjectChangedDetail>(PROJECT_CHANGED_EVENT, { detail }));
}
