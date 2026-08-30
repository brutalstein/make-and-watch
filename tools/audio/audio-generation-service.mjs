import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { chatterboxRuntimeStatus, ensureChatterboxRuntime } from './chatterbox-runtime-manager.mjs';

const MAX_PENDING_AUDIO_JOBS = 16;
const MAX_RETAINED_AUDIO_JOBS = 100;
const WORKER_TIMEOUT_MS = 20 * 60 * 1000;

function audioError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeFilePart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'audio';
}

function nodeById(snapshot, id) {
  return snapshot.nodes.find((node) => node.id === id) ?? null;
}

function dependenciesOf(snapshot, id) {
  return snapshot.dependencies
    .filter((edge) => edge.dependent === id)
    .map((edge) => nodeById(snapshot, edge.dependency))
    .filter(Boolean);
}

function firstDependency(snapshot, id, kind) {
  return dependenciesOf(snapshot, id).find((node) => node.kind === kind) ?? null;
}

function contextForAudio(snapshot, audio) {
  const scene = firstDependency(snapshot, audio.id, 'scene');
  const character = firstDependency(snapshot, audio.id, 'character');
  const episode = scene ? firstDependency(snapshot, scene.id, 'episode') : null;
  const series = episode ? firstDependency(snapshot, episode.id, 'series') : null;
  return { scene, character, episode, series };
}

function hashText(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function deterministicSeed(parts) {
  return createHash('sha256').update(parts.join('|')).digest().readUInt32BE(0);
}

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function safeManagedPath(projectRoot, value) {
  if (!value) return null;
  const root = resolve(projectRoot);
  let candidate;
  if (isAbsolute(value)) candidate = resolve(value);
  else if (String(value).replaceAll('\\', '/').startsWith('artifacts/')) candidate = resolve(root, '.makewatch', value);
  else candidate = resolve(root, value);
  const rel = relative(root, candidate);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return candidate;
}

async function fileExists(path) {
  if (!path) return false;
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function resolveVoiceReference(snapshot, audio, character, projectRoot) {
  const configured = audio.metadata.voiceReferenceAsset || character?.metadata?.voiceReferenceAsset || '';
  if (!configured) return null;
  const asset = nodeById(snapshot, configured);
  const rawPath = asset?.kind === 'asset' ? asset.metadata.relativePath : configured;
  const candidate = safeManagedPath(projectRoot, rawPath);
  if (!candidate || !await fileExists(candidate)) {
    throw audioError('invalid_argument', `voice reference is not a readable project-managed Asset: ${configured}`);
  }
  return { path: candidate, asset: asset?.kind === 'asset' ? asset : null };
}

async function releaseComfyGpu(baseUrl) {
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch {
    // Voice synthesis also works when ComfyUI is not running. The shared GPU
    // scheduler still prevents Make & Watch-owned media jobs from overlapping.
  }
}

function terminateTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

function runWorker(python, workerPath, requestPath, resultPath, { signal } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, [workerPath, requestPath, resultPath], {
      stdio: ['ignore', 'inherit', 'inherit'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    let settled = false;
    const aborted = () => terminateTree(child);
    signal?.addEventListener('abort', aborted, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateTree(child);
      cleanup();
      reject(new Error('Chatterbox worker exceeded bounded synthesis runtime'));
    }, WORKER_TIMEOUT_MS);
    timer.unref();
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal?.aborted ? audioError('cancelled', 'Chatterbox worker was cancelled') : error);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (signal?.aborted) reject(audioError('cancelled', 'Chatterbox worker was cancelled'));
      else if (code === 0) resolvePromise();
      else reject(new Error(`Chatterbox worker exited with code ${code ?? 'unknown'}`));
    });
  });
}

function publicJob(job) {
  return {
    id: job.id,
    audioId: job.audioId,
    audioTitle: job.audioTitle,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    artifact: job.artifact ? { ...job.artifact, absolutePath: undefined } : null,
  };
}

export class AudioGenerationService {
  constructor({
    bridge, scheduler, projectRoot, artifactRoot, workerPath,
    comfyBaseUrl = 'http://127.0.0.1:8188',
    runtimeResolver = ensureChatterboxRuntime,
    gpuReleaser = releaseComfyGpu,
    workerRunner = runWorker,
  }) {
    this.bridge = bridge;
    this.scheduler = scheduler;
    this.projectRoot = resolve(projectRoot);
    this.artifactRoot = resolve(artifactRoot);
    this.workerPath = resolve(workerPath);
    this.comfyBaseUrl = comfyBaseUrl;
    this.runtimeResolver = runtimeResolver;
    this.gpuReleaser = gpuReleaser;
    this.workerRunner = workerRunner;
    this.jobs = new Map();
    this.pending = [];
    this.activeJobId = null;
  }

  async providerStatus() {
    const runtime = await chatterboxRuntimeStatus();
    return {
      provider: 'chatterbox',
      mode: 'multilingual-v3',
      installed: runtime.installed,
      ready: runtime.installed,
      model: runtime.model,
      languages: ['tr', 'en', 'ar', 'da', 'de', 'el', 'es', 'fi', 'fr', 'he', 'hi', 'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ru', 'sv', 'sw', 'zh'],
      detail: runtime.installed ? 'local runtime ready' : 'will install automatically on first audio generation',
    };
  }

  async startAudio(audioId) {
    if (typeof audioId !== 'string' || !audioId || audioId.length > 180) throw audioError('invalid_argument', 'audioId is required');
    if (this.pending.length >= MAX_PENDING_AUDIO_JOBS) throw audioError('busy', 'audio generation queue is full');
    const snapshot = await this.bridge.snapshot();
    const audio = nodeById(snapshot, audioId);
    if (!audio || audio.kind !== 'audio') throw audioError('not_found', 'audio node was not found');
    const kind = String(audio.metadata.kind || 'dialogue');
    if (kind !== 'dialogue' && kind !== 'narration') {
      throw audioError('invalid_argument', 'Chatterbox generation currently supports dialogue and narration Audio nodes');
    }
    const text = String(audio.metadata.text || '').trim();
    if (!text) throw audioError('invalid_argument', 'audio.text is required before synthesis');

    const job = {
      id: randomUUID(),
      audioId,
      audioTitle: String(audio.title || audioId).slice(0, 240),
      status: 'queued',
      progress: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      error: '',
      artifact: null,
    };
    job.abortController = new AbortController();
    job.settled = new Promise((resolveSettled) => { job.resolveSettled = resolveSettled; });
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    this.#prune();
    void this.#pump();
    return publicJob(job);
  }

  list(limit = 20) {
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 20;
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, bounded).map(publicJob);
  }

  get(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw audioError('not_found', 'audio generation job was not found');
    return publicJob(job);
  }

  async cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw audioError('not_found', 'audio generation job was not found');
    if (job.status === 'queued') {
      this.pending = this.pending.filter((id) => id !== job.id);
      job.status = 'cancelled';
      job.completedAt = new Date().toISOString();
      job.resolveSettled();
    } else if (job.status === 'running') {
      if (!job.commitStarted) job.abortController.abort();
      await job.settled;
    }
    return publicJob(job);
  }

  artifact(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw audioError('not_found', 'audio generation job was not found');
    if (!job.artifact) throw audioError('not_found', 'audio artifact is not ready');
    return job.artifact;
  }

  #prune() {
    if (this.jobs.size <= MAX_RETAINED_AUDIO_JOBS) return;
    const completed = [...this.jobs.values()]
      .filter((job) => job.status !== 'queued' && job.status !== 'running' && job.id !== this.activeJobId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (this.jobs.size > MAX_RETAINED_AUDIO_JOBS && completed.length) this.jobs.delete(completed.shift().id);
  }

  async #pump() {
    if (this.activeJobId || this.pending.length === 0) return;
    const id = this.pending.shift();
    const job = this.jobs.get(id);
    if (!job) return void this.#pump();
    this.activeJobId = id;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      await this.scheduler.run({ kind: 'audio', id: job.id }, () => this.#run(job), { signal: job.abortController.signal });
      job.abortController.signal.throwIfAborted();
      job.status = 'completed';
      job.progress = 100;
      job.completedAt = new Date().toISOString();
    } catch (error) {
      job.status = job.abortController.signal.aborted ? 'cancelled' : 'failed';
      job.error = job.status === 'cancelled' ? '' : (error instanceof Error ? error.message : String(error)).slice(0, 1600);
      job.completedAt = new Date().toISOString();
      if (job.status === 'cancelled') {
        await this.#recordCancellation(job).catch(() => undefined);
        if (job.workDirectory) await rm(job.workDirectory, { recursive: true, force: true }).catch(() => undefined);
      }
    } finally {
      this.activeJobId = null;
      job.resolveSettled();
      this.#prune();
      void this.#pump();
    }
  }

  async #run(job) {
    const { signal } = job.abortController;
    signal.throwIfAborted();
    let snapshot = await this.bridge.snapshot();
    const audio = nodeById(snapshot, job.audioId);
    if (!audio || audio.kind !== 'audio') throw new Error('audio node was removed before generation started');
    const text = String(audio.metadata.text || '').trim();
    if (!text) throw new Error('audio text is empty');
    const context = contextForAudio(snapshot, audio);
    const reference = await resolveVoiceReference(snapshot, audio, context.character, this.projectRoot);
    const language = String(audio.metadata.language || context.character?.metadata?.voiceLanguage || context.series?.metadata?.language || 'tr').toLowerCase();
    const textHash = hashText(text);
    const masterSeed = String(context.series?.metadata?.masterSeed || '1337');
    const seed = deterministicSeed([
      masterSeed,
      audio.id,
      String(audio.revision),
      context.character?.id || 'builtin-voice',
      String(context.character?.revision || 0),
      reference?.asset?.id || reference?.path || 'builtin-voice',
      String(reference?.asset?.revision || 0),
      textHash,
    ]);
    const generationNodeId = `generation.audio.${safeFilePart(audio.id)}`;
    const startedAt = new Date().toISOString();

    await this.#setAudioStatus(snapshot, audio, { status: 'generating', provider: 'chatterbox' });
    snapshot = await this.bridge.snapshot();
    await this.#setGeneration(snapshot, generationNodeId, audio, {
      targetKind: 'audio', targetId: audio.id, mediaType: 'audio', provider: 'chatterbox', model: 'Chatterbox Multilingual V3',
      strategy: 'TTS_MULTILINGUAL_V3', status: 'running', seed, promptHash: textHash, startedAt, completedAt: '', error: '',
    });

    const runtime = await this.runtimeResolver();
    if (!runtime.python) throw new Error('Chatterbox runtime has no Python executable');
    signal.throwIfAborted();
    await this.gpuReleaser(this.comfyBaseUrl);
    signal.throwIfAborted();

    const directory = join(this.artifactRoot, safeFilePart(audio.id), safeFilePart(job.id));
    job.workDirectory = directory;
    await mkdir(directory, { recursive: true });
    const requestPath = join(directory, 'request.json');
    const resultPath = join(directory, 'result.json');
    const outputPath = join(directory, `${safeFilePart(audio.id)}.wav`);
    await writeFile(requestPath, JSON.stringify({
      text,
      language,
      outputPath,
      audioPromptPath: reference?.path ?? null,
      seed,
      exaggeration: boundedNumber(audio.metadata.exaggeration ?? context.character?.metadata?.voiceExaggeration, 0.5, 0.25, 1.5),
      cfgWeight: boundedNumber(audio.metadata.cfgWeight ?? context.character?.metadata?.voiceCfg, 0.5, 0, 1),
      temperature: 0.8,
    }, null, 2), 'utf8');
    job.progress = 20;

    await this.workerRunner(runtime.python, this.workerPath, requestPath, resultPath, { signal });
    signal.throwIfAborted();
    const worker = JSON.parse(await readFile(resultPath, 'utf8'));
    if (!worker.ok) throw new Error(worker.error || 'Chatterbox worker failed');
    job.progress = 80;

    const bytes = await readFile(outputPath);
    const sha256 = hashBytes(bytes);
    const assetNodeId = `asset.${sha256.slice(0, 24)}`;
    const relativePath = relative(resolve(this.projectRoot, '.makewatch'), outputPath).replaceAll('\\', '/');
    const completedAt = new Date().toISOString();
    job.artifact = {
      assetNodeId,
      generationNodeId,
      filename: `${safeFilePart(audio.id)}.wav`,
      relativePath,
      absolutePath: outputPath,
      contentType: 'audio/wav',
      sha256,
      durationSeconds: Number(worker.durationSeconds),
      sampleRate: Number(worker.sampleRate),
      model: worker.model,
      language: worker.language,
      seed,
      watermarked: worker.watermarked === true,
      voiceReferenceUsed: worker.voiceReferenceUsed === true,
    };

    job.commitStarted = true;
    snapshot = await this.bridge.snapshot();
    await this.#setGeneration(snapshot, generationNodeId, audio, {
      targetKind: 'audio', targetId: audio.id, mediaType: 'audio', provider: 'chatterbox', model: String(worker.model),
      strategy: 'TTS_MULTILINGUAL_V3', status: 'ready', seed, promptHash: textHash,
      artifactPath: relativePath, artifactSha256: sha256, startedAt, completedAt, error: '',
    });
    snapshot = await this.bridge.snapshot();
    await this.#registerAsset(snapshot, assetNodeId, generationNodeId, audio, job.artifact);
    snapshot = await this.bridge.snapshot();
    await this.#setAudioStatus(snapshot, nodeById(snapshot, audio.id), {
      status: 'ready', provider: 'chatterbox', durationSeconds: String(worker.durationSeconds), generatedAsset: assetNodeId,
    });
    await rm(requestPath, { force: true }).catch(() => undefined);
  }

  async #recordCancellation(job) {
    let snapshot = await this.bridge.snapshot();
    const audio = nodeById(snapshot, job.audioId);
    if (!audio || audio.kind !== 'audio') return;
    await this.#setGeneration(snapshot, `generation.audio.${safeFilePart(audio.id)}`, audio, {
      targetKind: 'audio', targetId: audio.id, mediaType: 'audio', provider: 'chatterbox',
      strategy: 'TTS_MULTILINGUAL_V3', status: 'cancelled', completedAt: job.completedAt, error: '',
    });
    snapshot = await this.bridge.snapshot();
    await this.#setAudioStatus(snapshot, nodeById(snapshot, audio.id), { status: 'cancelled', provider: 'chatterbox' });
  }

  async #setAudioStatus(snapshot, audio, metadataUpdates) {
    if (!audio || audio.kind !== 'audio' || audio.locked) return;
    await this.bridge.apply([{
      type: 'node.patch', id: audio.id, expectedRevision: audio.revision,
      metadataUpdates: Object.fromEntries(Object.entries(metadataUpdates).map(([key, value]) => [key, String(value)])),
    }], {
      actor: 'system', source: 'audio-generation', reason: `update audio production state for ${audio.id}`,
    }, snapshot.projectRevision);
  }

  async #setGeneration(snapshot, generationNodeId, audio, metadata) {
    const existing = nodeById(snapshot, generationNodeId);
    const normalized = Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, String(value ?? '')]));
    const commands = [];
    if (!existing) {
      commands.push({
        type: 'node.create',
        node: { id: generationNodeId, kind: 'generation', title: `${audio.title} · Voice Generation`, metadata: normalized, approval: 'draft', locked: false, stale: false },
      });
      commands.push({ type: 'dependency.add', dependent: generationNodeId, dependency: audio.id });
      commands.push({ type: 'node.markFresh', id: generationNodeId });
    } else {
      if (existing.kind !== 'generation' || existing.locked) throw new Error(`audio generation node cannot be updated: ${generationNodeId}`);
      commands.push({ type: 'node.patch', id: existing.id, expectedRevision: existing.revision, metadataUpdates: normalized });
      if (!snapshot.dependencies.some((edge) => edge.dependent === existing.id && edge.dependency === audio.id)) {
        commands.push({ type: 'dependency.add', dependent: existing.id, dependency: audio.id });
      }
      commands.push({ type: 'node.markFresh', id: existing.id });
    }
    await this.bridge.apply(commands, { actor: 'system', source: 'audio-generation', reason: `record voice generation for ${audio.id}` }, snapshot.projectRevision);
  }

  async #registerAsset(snapshot, assetNodeId, generationNodeId, audio, artifact) {
    const existing = nodeById(snapshot, assetNodeId);
    if (existing) {
      if (existing.kind !== 'asset') throw new Error(`audio asset ID collision: ${assetNodeId}`);
      const commands = [];
      if (!snapshot.dependencies.some((edge) => edge.dependent === existing.id && edge.dependency === generationNodeId)) {
        commands.push({ type: 'dependency.add', dependent: existing.id, dependency: generationNodeId });
      }
      if (existing.stale && !existing.locked) commands.push({ type: 'node.markFresh', id: existing.id, expectedRevision: existing.revision });
      if (commands.length) await this.bridge.apply(commands, { actor: 'system', source: 'audio-generation', reason: `refresh audio asset ${existing.id}` }, snapshot.projectRevision);
      return;
    }
    await this.bridge.apply([
      {
        type: 'node.create',
        node: {
          id: assetNodeId,
          kind: 'asset',
          title: `${audio.title} · WAV`,
          approval: 'draft', locked: false, stale: false,
          metadata: {
            mediaType: 'audio', role: 'dialogue-output', relativePath: artifact.relativePath, sha256: artifact.sha256,
            mimeType: 'audio/wav', durationSeconds: String(artifact.durationSeconds), sampleRate: String(artifact.sampleRate),
            source: 'generated', generatedBy: generationNodeId, provider: 'chatterbox', watermarked: String(artifact.watermarked),
          },
        },
      },
      { type: 'dependency.add', dependent: assetNodeId, dependency: generationNodeId },
      { type: 'node.markFresh', id: assetNodeId },
    ], { actor: 'system', source: 'audio-generation', reason: `register audio asset for ${audio.id}` }, snapshot.projectRevision);
  }
}
