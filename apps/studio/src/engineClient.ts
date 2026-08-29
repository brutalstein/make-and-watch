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
  DirectorConversationDeleteResult,
  DirectorConversationListResult,
  DirectorConversationMutationResult,
  DirectorConversationReadResult,
  DirectorPlanRequest,
  DirectorPlanResult,
  DirectorProviderId,
  DirectorProvidersResult,
} from './director/providerTypes';
import { announceProjectChanged } from './projectEvents';

const API_BASE = import.meta.env.VITE_ENGINE_BRIDGE_URL ?? 'http://127.0.0.1:4177/api';
// Fast native/bridge calls. A Director chat turn is not one of these: it can
// run a full Codex reasoning turn plus many authoritative project tool calls,
// so it gets its own budget that stays strictly above the server-side turn
// budget. If the client aborted first the user would see a misleading
// "bridge is unavailable" error while the turn was still running natively.
const REQUEST_TIMEOUT_MS = 20_000;
const DIRECTOR_TURN_TIMEOUT_MS = 900_000;
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

function isTimeout(reason: unknown) {
  return reason instanceof DOMException && reason.name === 'TimeoutError';
}

function bridgeUnavailable(reason: unknown, timeoutMs?: number) {
  if (reason instanceof EngineBridgeError) return reason;
  if (isTimeout(reason)) {
    return new EngineBridgeError(
      'bridge_timeout',
      `Local Make & Watch bridge did not respond within ${Math.round((timeoutMs ?? REQUEST_TIMEOUT_MS) / 1000)}s. `
      + 'The operation may still be running locally; check the workflow before retrying.',
    );
  }
  const detail = reason instanceof Error ? reason.message : String(reason);
  return new EngineBridgeError(
    'bridge_unavailable',
    `Local Make & Watch bridge is unavailable${detail ? `: ${detail}` : ''}`,
  );
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}

async function request<T>(path: string, init?: RequestOptions): Promise<T> {
  const timeoutMs = init?.timeoutMs ?? REQUEST_TIMEOUT_MS;
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (reason) {
    throw bridgeUnavailable(reason, timeoutMs);
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
    timeoutMs: DIRECTOR_TURN_TIMEOUT_MS,
  });
  if (result.projectChanged) {
    announceProjectChanged({ projectRevision: result.projectRevision, source: 'director-chat' });
  }
  return result;
}

function conversationMutation<T>(path: string, body: Record<string, unknown>) {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
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
  directorProviders: () => request<DirectorProvidersResult>('/director/providers', { timeoutMs: 60_000 }),
  connectDirector: (provider: DirectorProviderId) => request<DirectorConnectResult>('/director/connect', {
    method: 'POST',
    body: JSON.stringify({ provider }),
    timeoutMs: 120_000,
  }),
  directorChat,
  closeDirectorChat: (provider: DirectorProviderId, conversationId: string) => request<DirectorChatCloseResult>('/director/chat/close', {
    method: 'POST',
    body: JSON.stringify({ provider, conversationId }),
  }),
  directorConversations: (archived = false, limit = 100) => request<DirectorConversationListResult>(
    `/director/conversations?archived=${archived ? '1' : '0'}&limit=${encodeURIComponent(String(limit))}`,
  ),
  readDirectorConversation: (conversationId: string) => conversationMutation<DirectorConversationReadResult>(
    '/director/conversations/read', { conversationId },
  ),
  renameDirectorConversation: (conversationId: string, title: string) => conversationMutation<DirectorConversationMutationResult>(
    '/director/conversations/rename', { conversationId, title },
  ),
  archiveDirectorConversation: (conversationId: string) => conversationMutation<DirectorConversationMutationResult>(
    '/director/conversations/archive', { conversationId },
  ),
  unarchiveDirectorConversation: (conversationId: string) => conversationMutation<DirectorConversationMutationResult>(
    '/director/conversations/unarchive', { conversationId },
  ),
  deleteDirectorConversation: (conversationId: string) => conversationMutation<DirectorConversationDeleteResult>(
    '/director/conversations/delete', { conversationId },
  ),
  directorPlan: (input: DirectorPlanRequest) => request<DirectorPlanResult>('/director/plan', {
    method: 'POST',
    body: JSON.stringify(input),
    timeoutMs: DIRECTOR_TURN_TIMEOUT_MS,
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
