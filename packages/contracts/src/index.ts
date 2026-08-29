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

export type ProjectNodeKind =
  | 'series'
  | 'episode'
  | 'scene'
  | 'shot'
  | 'character'
  | 'location'
  | 'asset'
  | 'audio'
  | 'generation';

export interface ProjectNode {
  id: string;
  kind: ProjectNodeKind;
  title: string;
  metadata: Record<string, string>;
  revision: number;
  approval: ApprovalState;
  locked: boolean;
  stale: boolean;
}

export interface DependencyEdge {
  dependent: string;
  dependency: string;
}

export interface ProjectGraphSnapshot {
  schemaVersion: 1;
  projectRevision: number;
  nodes: ProjectNode[];
  dependencies: DependencyEdge[];
}

export type ProjectCommand =
  | { type: 'node.create'; node: Omit<ProjectNode, 'revision'> }
  | { type: 'node.patch'; id: string; expectedRevision?: number; title?: string; approval?: ApprovalState; metadataUpdates?: Record<string, string>; metadataRemovals?: string[] }
  | { type: 'node.lock'; id: string; locked: boolean; expectedRevision?: number }
  | { type: 'node.markFresh'; id: string; expectedRevision?: number }
  | { type: 'dependency.add'; dependent: string; dependency: string }
  | { type: 'dependency.remove'; dependent: string; dependency: string }
  | { type: 'node.remove'; id: string; expectedRevision?: number };

export type ProjectEventType =
  | 'node.created'
  | 'node.updated'
  | 'node.removed'
  | 'dependency.added'
  | 'dependency.removed'
  | 'lock.changed'
  | 'approval.changed'
  | 'freshness.changed'
  | 'dependents.invalidated'
  | 'transaction.committed';

export interface ProjectEvent {
  type: ProjectEventType;
  entityId?: string;
  projectRevision: number;
  affected: string[];
  detail?: string;
}

export type ProjectCommitActor = 'user' | 'ai_director' | 'system';

export interface ProjectHistoryTransaction {
  projectRevision: number;
  actor: ProjectCommitActor;
  source: string;
  planId: string;
  reason: string;
  events: ProjectEvent[];
}

export interface ProjectHistoryResult {
  transactions: ProjectHistoryTransaction[];
}

export interface EngineHealth {
  service: 'makewatch-engine';
  protocolVersion: 1;
  projectRevision: number;
  nodeCount: number;
}

export interface ImpactReport {
  affected: string[];
  locked: string[];
  alreadyStale: string[];
}

export interface ApplyProjectResult {
  projectRevision: number;
  events: ProjectEvent[];
  snapshot: ProjectGraphSnapshot;
}

export type SavedWorkflowKind = 'saved' | 'recovery';

export interface SavedWorkflowSummary {
  id: string;
  kind: SavedWorkflowKind;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  sourceProjectRevision: number;
  nodeCount: number;
  dependencyCount: number;
}

export interface SavedWorkflowListResult {
  workflows: SavedWorkflowSummary[];
  issues: Array<{ file: string; message: string }>;
}

export interface WorkflowRestoreResult extends ApplyProjectResult {
  recoveryWorkflow: SavedWorkflowSummary;
  loadedWorkflow?: {
    id: string;
    kind: SavedWorkflowKind;
    name: string;
    description: string;
    sourceProjectRevision: number;
  };
}

export interface SystemTelemetry {
  platform: string;
  cpu: {
    logicalCores: number;
    totalMemoryMb: number;
    freeMemoryMb: number;
  };
  gpu: null | {
    name: string;
    memoryTotalMb: number;
    memoryUsedMb: number;
    memoryFreeMb: number;
    utilizationPercent: number;
    temperatureC: number;
  };
}

export * from './nodeCapabilities';
