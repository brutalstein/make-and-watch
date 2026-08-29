import type {
  ApplyProjectResult,
  EngineHealth,
  ImpactReport,
  ProjectCommand,
  ProjectGraphSnapshot,
  ProjectHistoryResult,
  SavedWorkflowListResult,
  SavedWorkflowSummary,
  SystemTelemetry,
  WorkflowRestoreResult,
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
import { announceProjectChanged } from './projectEvents';

const API_BASE = import.meta.env.VITE_ENGINE_BRIDGE_URL ?? 'http://127.0.0.1:4177/api';
const REQUEST_TIMEOUT_MS = 20_000;
const TELEMETRY_BASE_BACKOFF_MS = 2_500;
const TELEMETRY_MAX_BACKOFF_MS = 30_000;

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

function bridgeUnavailable(reason: unknown) {
  if (reason instanceof EngineBridgeError) return reason;
  const detail = reason instanceof Error ? reason.message : String(reason);
  return new EngineBridgeError(
    'bridge_unavailable',
    `Local Make & Watch bridge is unavailable${detail ? `: ${detail}` : ''}`,
  );
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (reason) {
    throw bridgeUnavailable(reason);
  }

  let payload: Envelope<T>;
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch {
    throw new EngineBridgeError(
      'invalid_bridge_response',
      `Local bridge returned HTTP ${response.status} without a valid JSON envelope`,
    );
  }

  if (!payload.ok) throw new EngineBridgeError(payload.error.code, payload.error.message);
  if (!response.ok) {
    throw new EngineBridgeError('bridge_http_error', `Local bridge returned HTTP ${response.status}`);
  }
  return payload.result;
}

let telemetryCache: SystemTelemetry | null = null;
let telemetryInFlight: Promise<SystemTelemetry> | null = null;
let telemetryFailureCount = 0;
let telemetryRetryAt = 0;
let telemetryLastError: EngineBridgeError | null = null;

function systemTelemetry(): Promise<SystemTelemetry> {
  if (telemetryInFlight) return telemetryInFlight;

  const now = Date.now();
  if (now < telemetryRetryAt) {
    if (telemetryCache) return Promise.resolve(telemetryCache);
    return Promise.reject(telemetryLastError ?? new EngineBridgeError('bridge_backoff', 'Local bridge reconnect is backing off'));
  }

  telemetryInFlight = request<SystemTelemetry>('/system')
    .then((telemetry) => {
      telemetryCache = telemetry;
      telemetryFailureCount = 0;
      telemetryRetryAt = 0;
      telemetryLastError = null;
      return telemetry;
    })
    .catch((reason) => {
      const error = bridgeUnavailable(reason);
      telemetryFailureCount += 1;
      const delay = Math.min(
        TELEMETRY_MAX_BACKOFF_MS,
        TELEMETRY_BASE_BACKOFF_MS * (2 ** Math.min(telemetryFailureCount - 1, 4)),
      );
      telemetryRetryAt = Date.now() + delay;
      telemetryLastError = error;
      throw error;
    })
    .finally(() => {
      telemetryInFlight = null;
    });

  return telemetryInFlight;
}

async function newWorkflow(expectedProjectRevision: number, reason = 'create clean workflow') {
  const result = await request<WorkflowRestoreResult>('/workflows/new', {
    method: 'POST',
    body: JSON.stringify({ expectedProjectRevision, reason }),
  });
  announceProjectChanged({ projectRevision: result.projectRevision, source: 'workflow-manager' });
  return result;
}

async function loadWorkflow(workflowId: string, expectedProjectRevision: number, reason = 'load saved workflow') {
  const result = await request<WorkflowRestoreResult>('/workflows/load', {
    method: 'POST',
    body: JSON.stringify({ workflowId, expectedProjectRevision, reason }),
  });
  announceProjectChanged({ projectRevision: result.projectRevision, source: 'workflow-manager' });
  return result;
}

async function directorChat(input: DirectorChatRequest) {
  const result = await request<DirectorChatResult>('/director/chat', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  if (result.projectChanged) {
    announceProjectChanged({ projectRevision: result.projectRevision, source: 'director-chat' });
  }
  return result;
}

export const engineClient = {
  health: () => request<EngineHealth>('/health'),
  snapshot: () => request<ProjectGraphSnapshot>('/project'),
  history: (limit = 10) => request<ProjectHistoryResult>(`/project/history?limit=${encodeURIComponent(String(limit))}`),
  system: systemTelemetry,
  workflows: (includeRecovery = true) => request<SavedWorkflowListResult>(`/workflows?includeRecovery=${includeRecovery ? '1' : '0'}`),
  saveWorkflow: (name: string, description = '') => request<{ workflow: SavedWorkflowSummary }>('/workflows/save', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  }),
  newWorkflow,
  loadWorkflow,
  deleteWorkflow: (workflowId: string) => request<{ workflow: SavedWorkflowSummary }>('/workflows/delete', {
    method: 'POST',
    body: JSON.stringify({ workflowId }),
  }),
  directorProviders: () => request<DirectorProvidersResult>('/director/providers'),
  connectDirector: (provider: DirectorProviderId) => request<DirectorConnectResult>('/director/connect', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  }),
  directorChat,
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
  apply: (
    commands: ProjectCommand[],
    context?: ProjectCommitContext,
    expectedProjectRevision?: number,
  ) => request<ApplyProjectResult>('/project/apply', {
    method: 'POST',
    body: JSON.stringify({ commands, context, expectedProjectRevision }),
  }),
};
