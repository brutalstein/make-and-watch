export type ApprovalState =
  | 'draft'
  | 'review'
  | 'approved'
  | 'locked'
  | 'invalidated'
  | 'failed';

export type WorkflowStatus =
  | 'draft'
  | 'planning'
  | 'review'
  | 'approved'
  | 'locked'
  | 'generating'
  | 'ready'
  | 'failed';

export interface SceneSummary {
  id: string;
  index: number;
  title: string;
  location: string;
  durationSeconds: number;
  shotCount: number;
  status: WorkflowStatus;
  quality?: number;
}

export type DirectorOperationType =
  | 'scene.update'
  | 'scene.approve'
  | 'scene.lock'
  | 'shot.update'
  | 'shot.approve'
  | 'shot.lock'
  | 'voice.update'
  | 'camera.update';

export interface DirectorOperation {
  schemaVersion: 1;
  operationId: string;
  type: DirectorOperationType;
  target: {
    entityType: 'scene' | 'shot' | 'character';
    entityId: string;
  };
  payload: Record<string, unknown>;
  reason?: string;
  requestedBy?: 'user' | 'director' | 'system';
}
