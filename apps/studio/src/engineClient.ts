import type {
  ApplyProjectResult,
  EngineHealth,
  ImpactReport,
  ProjectCommand,
  ProjectGraphSnapshot,
  ProjectHistoryResult,
  SystemTelemetry,
} from '@makewatch/contracts';

import type {
  DirectorChatCloseResult,
  DirectorChatRequest,
  DirectorChatResult,
  DirectorConnectResult,
  DirectorPlanRequest,
  DirectorPlanResult,
  DirectorProviderId,
  DirectorProvidersResult,
} from './director/providerTypes';

const API_BASE = import.meta.env.VITE_ENGINE_BRIDGE_URL ?? 'http://127.0.0.1:4177/api';

interface SuccessEnvelope<T> {
  protocol: 1;
  id: string;
  ok: true;
  result: T;
}

interface FailureEnvelope {
  protocol?: number;
  id?: string;
  ok: false;
  error: { code: string; message: string };
}

type Envelope<T> = SuccessEnvelope<T> | FailureEnvelope;

export interface ProjectCommitContext {
  actor?: 'user' | 'ai_director' | 'system';
  source?: string;
  planId?: string;
  reason?: string;
}

export class EngineBridgeError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'EngineBridgeError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = (await response.json()) as Envelope<T>;
  if (!payload.ok) throw new EngineBridgeError(payload.error.code, payload.error.message);
  return payload.result;
}

export const engineClient = {
  health: () => request<EngineHealth>('/health'),
  snapshot: () => request<ProjectGraphSnapshot>('/project'),
  history: (limit = 10) => request<ProjectHistoryResult>(`/project/history?limit=${encodeURIComponent(String(limit))}`),
  system: () => request<SystemTelemetry>('/system'),
  directorProviders: () => request<DirectorProvidersResult>('/director/providers'),
  connectDirector: (provider: DirectorProviderId) => request<DirectorConnectResult>('/director/connect', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  }),
  directorChat: (input: DirectorChatRequest) => request<DirectorChatResult>('/director/chat', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  closeDirectorChat: (provider: DirectorProviderId, conversationId: string) => request<DirectorChatCloseResult>('/director/chat/close', {
    method: 'POST',
    body: JSON.stringify({ provider, conversationId }),
  }),
  directorPlan: (input: DirectorPlanRequest) => request<DirectorPlanResult>('/director/plan', {
    method: 'POST',
    body: JSON.stringify(input),
  }),
  impact: (source: string) => request<ImpactReport>('/project/impact', {
    method: 'POST',
    body: JSON.stringify({ source }),
  }),
  apply: (commands: ProjectCommand[], context?: ProjectCommitContext) => request<ApplyProjectResult>('/project/apply', {
    method: 'POST',
    body: JSON.stringify({ commands, context }),
  }),
};
