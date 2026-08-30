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

export type DirectorRuntimeMode = 'app_server' | 'exec_fallback' | 'none';

export interface DirectorProviderStatus {
  provider: DirectorProviderId;
  policy: DirectorProviderPolicy;
  integration: DirectorProviderIntegration;
  runtimeMode: DirectorRuntimeMode;
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
  model: string;
  reasoningEffort: string;
  inputModalities: string[];
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
  attachmentCount?: number;
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

export interface DirectorReferenceAttachment {
  assetNodeId: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  sha256: string;
  relativePath: string;
}

export interface DirectorReferenceImportResult {
  reference: DirectorReferenceAttachment;
  projectRevision: number;
}

export interface DirectorChatRequest {
  provider: DirectorProviderId;
  conversationId?: string | null;
  message: string;
  selectedId?: string | null;
  attachmentAssetIds?: string[];
}

export interface DirectorChatResult {
  provider: DirectorProviderId;
  conversationId: string;
  reply: string;
  turnCount: number;
  title: string;
  updatedAt: string;
  runtimeMode: DirectorRuntimeMode;
  model: string;
  reasoningEffort: string;
  projectRevision: number;
  projectChanged: boolean;
  context: DirectorContextStats;
}

export interface DirectorChatCloseResult {
  closed: boolean;
}

export type DirectorConversationMessageRole = 'user' | 'assistant' | 'system';
export type DirectorConversationDelivery = 'complete' | 'failed';

export interface DirectorConversationMessage {
  id: string;
  role: DirectorConversationMessageRole;
  text: string;
  createdAt: string;
  projectRevision: number | null;
  delivery: DirectorConversationDelivery;
  attachments: DirectorReferenceAttachment[];
}

export interface DirectorConversationSummary {
  id: string;
  provider: DirectorProviderId;
  runtimeMode: DirectorRuntimeMode;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  turnCount: number;
  providerThreadId: string | null;
  providerThreadArchived: boolean;
  lastProjectRevision: number | null;
  messageCount: number;
  attachmentCount: number;
  preview: string;
}

export interface DirectorConversationDocument {
  schemaVersion: 2;
  id: string;
  provider: DirectorProviderId;
  runtimeMode: DirectorRuntimeMode;
  providerThreadId: string | null;
  providerThreadArchived: boolean;
  title: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  turnCount: number;
  lastProjectRevision: number | null;
  messages: DirectorConversationMessage[];
}

export interface DirectorConversationListResult {
  conversations: DirectorConversationSummary[];
}

export interface DirectorConversationReadResult {
  conversation: DirectorConversationDocument;
}

export interface DirectorConversationMutationResult {
  conversation: DirectorConversationSummary;
  providerWarning?: string;
}

export interface DirectorConversationDeleteResult {
  deleted: boolean;
  conversation: DirectorConversationSummary;
  providerWarning?: string;
}
