import type { AutopilotMode, AutopilotPlan } from './autopilotTypes';

export type DirectorProviderId = 'codex' | 'claude';
export type DirectorProviderPolicy =
  | 'supported_local_client'
  | 'api_required'
  | 'experimental_local_client';

export type DirectorProviderIntegration =
  | 'codex_app_server'
  | 'anthropic_api_required'
  | 'claude_code_preview';

export interface DirectorProviderStatus {
  provider: DirectorProviderId;
  policy: DirectorProviderPolicy;
  integration: DirectorProviderIntegration;
  installed: boolean;
  authenticated: boolean;
  authMethod: string;
  planType: string;
  version: string;
  capable: boolean;
  loginAvailable: boolean;
  planningAvailable: boolean;
  chatAvailable: boolean;
  loginPending: boolean;
  executableName: string;
  discovery: string;
  capabilityIssues: string[];
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
  loginMode: 'browser' | 'cli' | 'none';
  loginId: string | null;
  authUrl: string | null;
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

export interface DirectorChatRequest {
  provider: DirectorProviderId;
  conversationId?: string | null;
  message: string;
  selectedId?: string | null;
}

export interface DirectorChatResult {
  provider: DirectorProviderId;
  conversationId: string;
  reply: string;
  turnCount: number;
  projectRevision: number;
  context: DirectorContextStats;
}

export interface DirectorChatCloseResult {
  closed: boolean;
}
