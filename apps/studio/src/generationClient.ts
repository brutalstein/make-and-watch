const GENERATION_BASE = import.meta.env.VITE_GENERATION_GATEWAY_URL ?? 'http://127.0.0.1:4178/api';
const REQUEST_TIMEOUT_MS = 20_000;

export interface GenerationProviderStatus {
  provider: 'comfyui';
  online: boolean;
  mode: 'storyboard-preview';
  baseUrl?: string;
  checkpoint?: string;
  checkpointCount?: number;
  sampler?: string;
  scheduler?: string;
  detail?: string;
}

export interface SceneGenerationArtifact {
  shotId: string;
  generationNodeId: string;
  filename: string;
  relativePath: string;
  contentType: string;
  promptId: string;
  checkpoint: string;
}

export interface SceneGenerationJob {
  id: string;
  sceneId: string;
  sceneTitle: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  shotCount: number;
  completedShots: number;
  currentShotId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string;
  artifacts: SceneGenerationArtifact[];
}

interface Envelope<T> {
  ok: boolean;
  result?: T;
  error?: { code?: string; message?: string };
}

export class GenerationGatewayError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'GenerationGatewayError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${GENERATION_BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GenerationGatewayError('gateway_unavailable', error instanceof Error ? error.message : String(error));
  }
  let payload: Envelope<T>;
  try { payload = await response.json() as Envelope<T>; } catch { throw new GenerationGatewayError('invalid_response', `generation gateway returned HTTP ${response.status}`); }
  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new GenerationGatewayError(payload.error?.code ?? 'generation_error', payload.error?.message ?? `generation gateway returned HTTP ${response.status}`);
  }
  return payload.result;
}

export const generationClient = {
  provider: () => request<GenerationProviderStatus>('/provider'),
  jobs: (limit = 20) => request<{ jobs: SceneGenerationJob[] }>(`/jobs?limit=${encodeURIComponent(String(limit))}`),
  startScene: (sceneId: string) => request<{ job: SceneGenerationJob }>('/scenes', {
    method: 'POST',
    body: JSON.stringify({ sceneId }),
  }),
  job: (jobId: string) => request<{ job: SceneGenerationJob }>(`/jobs/${encodeURIComponent(jobId)}`),
  artifactUrl: (jobId: string, shotId: string) => `${GENERATION_BASE}/artifacts/${encodeURIComponent(jobId)}/${encodeURIComponent(shotId)}`,
};
