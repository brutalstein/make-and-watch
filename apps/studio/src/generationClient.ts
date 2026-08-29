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

export interface AudioProviderStatus {
  provider: 'chatterbox';
  mode: 'multilingual-v3';
  installed: boolean;
  ready: boolean;
  model: string;
  languages: string[];
  detail: string;
}

export interface SceneGenerationArtifact {
  shotId: string;
  generationNodeId: string;
  assetNodeId: string;
  filename: string;
  relativePath: string;
  contentType: string;
  sha256: string;
  promptId: string;
  checkpoint: string;
  seed: number;
  promptHash: string;
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

export interface AudioGenerationArtifact {
  assetNodeId: string;
  generationNodeId: string;
  filename: string;
  relativePath: string;
  contentType: 'audio/wav';
  sha256: string;
  durationSeconds: number;
  sampleRate: number;
  model: string;
  language: string;
  seed: number;
  watermarked: boolean;
  voiceReferenceUsed: boolean;
}

export interface AudioGenerationJob {
  id: string;
  audioId: string;
  audioTitle: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string;
  artifact: AudioGenerationArtifact | null;
}

export interface CompositionMedia {
  assetId: string;
  mediaType: 'image' | 'video' | 'audio' | string;
  relativePath: string;
  mimeType: string;
  sha256: string;
  width: number;
  height: number;
  durationSeconds: number;
}

export interface EpisodeCompositionManifest {
  schemaVersion: 1;
  projectRevision: number;
  episode: {
    id: string;
    title: string;
    seriesId: string | null;
    seriesTitle: string;
    targetDurationSeconds: number;
    durationSeconds: number;
    durationInFrames: number;
  };
  profile: { name: string; width: number; height: number; fps: number };
  scenes: Array<{
    id: string;
    title: string;
    index: number;
    summary: string;
    transitionIn: string;
    transitionOut: string;
    startSeconds: number;
    durationSeconds: number;
    startFrame: number;
    durationInFrames: number;
    shots: Array<{
      id: string;
      title: string;
      strategy: string;
      startSeconds: number;
      durationSeconds: number;
      media: CompositionMedia | null;
    }>;
    audio: Array<{
      id: string;
      title: string;
      kind: string;
      text: string;
      language: string;
      startSeconds: number;
      durationSeconds: number;
      subtitle: boolean;
      media: CompositionMedia | null;
    }>;
  }>;
  stats: {
    sceneCount: number;
    shotCount: number;
    audioCueCount: number;
    generatedVisualCount: number;
    generatedAudioCount: number;
  };
  issues: string[];
  warnings: string[];
  ready: boolean;
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
  audioProvider: () => request<AudioProviderStatus>('/audio/provider'),
  jobs: (limit = 20) => request<{ jobs: SceneGenerationJob[] }>(`/jobs?limit=${encodeURIComponent(String(limit))}`),
  audioJobs: (limit = 20) => request<{ jobs: AudioGenerationJob[] }>(`/audio/jobs?limit=${encodeURIComponent(String(limit))}`),
  startScene: (sceneId: string) => request<{ job: SceneGenerationJob }>('/scenes', {
    method: 'POST',
    body: JSON.stringify({ sceneId }),
  }),
  startAudio: (audioId: string) => request<{ job: AudioGenerationJob }>('/audio', {
    method: 'POST',
    body: JSON.stringify({ audioId }),
  }),
  job: (jobId: string) => request<{ job: SceneGenerationJob }>(`/jobs/${encodeURIComponent(jobId)}`),
  audioJob: (jobId: string) => request<{ job: AudioGenerationJob }>(`/audio/jobs/${encodeURIComponent(jobId)}`),
  composition: (episodeId: string) => request<{ manifest: EpisodeCompositionManifest }>(`/composition/episodes/${encodeURIComponent(episodeId)}`),
  artifactUrl: (jobId: string, shotId: string) => `${GENERATION_BASE}/artifacts/${encodeURIComponent(jobId)}/${encodeURIComponent(shotId)}`,
  audioArtifactUrl: (jobId: string) => `${GENERATION_BASE}/audio/artifacts/${encodeURIComponent(jobId)}`,
};
