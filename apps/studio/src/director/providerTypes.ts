import type { AutopilotMode, AutopilotPlan } from './autopilotTypes';

export type DirectorProviderId = 'codex' | 'claude';

export interface DirectorProviderStatus {
  provider: DirectorProviderId;
  installed: boolean;
  authenticated: boolean;
  authMethod: string;
  version: string;
  capable: boolean;
  detail: string;
}

export interface DirectorProvidersResult {
  providers: DirectorProviderStatus[];
  activeProviderRun: DirectorProviderId | null;
}

export interface DirectorConnectResult {
  provider: DirectorProviderId;
  launched: boolean;
  command: string;
  message: string;
}

export interface DirectorContextStats {
  hash: string;
  chars: number;
  estimatedTokens: number;
  nodeCountIncluded: number;
  dependencyCountIncluded: number;
}

export interface DirectorPlanResult {
  plan: AutopilotPlan;
  context: DirectorContextStats;
}

export interface DirectorPlanRequest {
  provider: DirectorProviderId;
  objective: string;
  mode: AutopilotMode;
  selectedId?: string | null;
  workspacePositions?: Record<string, { x: number; y: number }>;
}
