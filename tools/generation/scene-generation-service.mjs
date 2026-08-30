import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';

const MAX_PENDING_JOBS = 8;
const MAX_RETAINED_JOBS = 100;
const MAX_SHOTS_PER_SCENE = 64;
// Diffusion models do not process negation in the positive conditioning: an
// instruction to exclude something puts that concept INTO the conditioning and
// makes it more likely, not less. Every exclusion belongs here instead.
const BASE_NEGATIVE_PROMPT = [
  'low quality, blurry, deformed, duplicate subject, bad anatomy',
  'text, typography, caption, subtitles, watermark, logo, signature',
  'ui overlay, hud, viewfinder, timecode, recording indicator, border, letterboxing',
].join(', ');

// A Series declares its rendering idiom once and every Shot inherits it. The
// scaffold used to be hardcoded photoreal wording, which actively fought any
// non-photoreal checkpoint: telling an anime model to produce "physically
// plausible materials" with a "restrained filmic color grade" degrades it.
// Sampler defaults live here too, because they are part of the idiom rather
// than something a user should have to tune per shot.
const STYLE_PRESETS = {
  'live-action-cinematic': {
    lead: 'cinematic storyboard frame, coherent production design, physically plausible materials',
    tail: 'cinematic lighting, consistent identity, coherent environment geometry, restrained filmic color grade',
    negative: 'oversaturated, plastic skin',
    steps: 20,
    cfg: 6.5,
    sampler: null,
    width: 768,
    height: 432,
  },
  'anime-cinematic': {
    lead: 'cinematic anime film still, animation production key art, confident clean linework, painted backgrounds',
    tail: 'dramatic cinematic composition, expressive character acting, cel shading with painted light, filmic depth, consistent character identity',
    negative: '3d render, photorealistic, live action, western cartoon, chibi, sketch, flat lighting',
    steps: 30,
    cfg: 7,
    // Illustrious/SDXL anime checkpoints are tuned for ancestral sampling.
    sampler: 'euler_ancestral',
    // SDXL degrades below its training resolution, but a full 1024x1024-area
    // frame does not leave headroom on an 8 GB card while Studio and ComfyUI
    // are both resident. 1024x576 is the compromise that still renders cleanly.
    width: 1024,
    height: 576,
  },
  illustration: {
    lead: 'cinematic illustrated frame, deliberate composition, painterly rendering',
    tail: 'expressive lighting, coherent environment geometry, consistent identity',
    negative: '3d render, photorealistic',
    steps: 28,
    cfg: 7,
    sampler: null,
    width: 1024,
    height: 576,
  },
  'stylized-3d': {
    lead: 'cinematic stylized 3d animated film frame, feature animation production render',
    tail: 'cinematic lighting, subsurface skin shading, coherent environment geometry, consistent identity',
    negative: 'photorealistic, live action, flat 2d',
    steps: 26,
    cfg: 7,
    sampler: null,
    width: 1024,
    height: 576,
  },
};

const DEFAULT_STYLE_PRESET = 'live-action-cinematic';

function stylePresetFor(series) {
  const requested = metadataText(series, 'stylePreset');
  return STYLE_PRESETS[requested] ?? STYLE_PRESETS[DEFAULT_STYLE_PRESET];
}

function generationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeFilePart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'item';
}

function safeTitle(value, fallback = 'Untitled') {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  return (text || fallback).slice(0, 240);
}

function metadataText(node, key) {
  return safeTitle(node?.metadata?.[key] ?? '', '');
}

function numericMetadata(node, key, fallback) {
  const value = Number(node?.metadata?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function deterministicSeed(parts) {
  const digest = createHash('sha256').update(parts.join('|')).digest();
  return digest.readUInt32BE(0);
}

function explicitSeed(node) {
  const raw = node?.metadata?.seed;
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
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

function dependentsOf(snapshot, id) {
  return snapshot.dependencies
    .filter((edge) => edge.dependency === id)
    .map((edge) => nodeById(snapshot, edge.dependent))
    .filter(Boolean);
}

function sceneShots(snapshot, sceneId) {
  return dependentsOf(snapshot, sceneId)
    .filter((node) => node.kind === 'shot')
    .sort((left, right) => {
      const leftIndex = numericMetadata(left, 'index', numericMetadata(left, 'shotNumber', Number.MAX_SAFE_INTEGER));
      const rightIndex = numericMetadata(right, 'index', numericMetadata(right, 'shotNumber', Number.MAX_SAFE_INTEGER));
      return leftIndex === rightIndex ? left.id.localeCompare(right.id) : leftIndex - rightIndex;
    });
}

function episodeForScene(snapshot, scene) {
  return dependenciesOf(snapshot, scene.id).find((node) => node.kind === 'episode') ?? null;
}

function seriesForEpisode(snapshot, episode) {
  return episode ? dependenciesOf(snapshot, episode.id).find((node) => node.kind === 'series') ?? null : null;
}

function uniqueKindDependencies(snapshot, scene, shot, kind) {
  return [...dependenciesOf(snapshot, shot.id), ...dependenciesOf(snapshot, scene.id)]
    .filter((node) => node.kind === kind)
    .filter((node, index, list) => list.findIndex((candidate) => candidate.id === node.id) === index);
}

function characterPrompt(node) {
  return [
    safeTitle(node.title),
    metadataText(node, 'description'),
    metadataText(node, 'appearancePrompt'),
    metadataText(node, 'wardrobe') ? `wardrobe ${metadataText(node, 'wardrobe')}` : '',
    metadataText(node, 'performanceStyle') ? `performance ${metadataText(node, 'performanceStyle')}` : '',
  ].filter(Boolean).join(' — ');
}

function locationPrompt(node) {
  return [
    safeTitle(node.title),
    metadataText(node, 'description'),
    metadataText(node, 'environmentPrompt'),
    metadataText(node, 'city'),
    metadataText(node, 'time'),
    metadataText(node, 'weather'),
    metadataText(node, 'lighting') ? `lighting ${metadataText(node, 'lighting')}` : '',
    metadataText(node, 'palette') ? `palette ${metadataText(node, 'palette')}` : '',
  ].filter(Boolean).join(' — ');
}

function compiledShotPrompt(snapshot, scene, shot) {
  const episode = episodeForScene(snapshot, scene);
  const series = seriesForEpisode(snapshot, episode);
  const characters = uniqueKindDependencies(snapshot, scene, shot, 'character');
  const locations = uniqueKindDependencies(snapshot, scene, shot, 'location');
  const style = stylePresetFor(series);
  const pieces = [
    style.lead,
    series ? `series ${safeTitle(series.title)}` : '',
    metadataText(series, 'genre') ? `genre ${metadataText(series, 'genre')}` : '',
    metadataText(series, 'visualLanguage') ? `visual bible ${metadataText(series, 'visualLanguage')}` : '',
    episode ? `episode ${safeTitle(episode.title)}` : '',
    `scene ${safeTitle(scene.title)}`,
    metadataText(scene, 'summary'),
    metadataText(scene, 'dramaticGoal') ? `dramatic goal ${metadataText(scene, 'dramaticGoal')}` : '',
    metadataText(scene, 'timeOfDay') ? `time of day ${metadataText(scene, 'timeOfDay')}` : '',
    metadataText(scene, 'weather') ? `weather ${metadataText(scene, 'weather')}` : '',
    `shot ${safeTitle(shot.title)}`,
    metadataText(shot, 'purpose') ? `shot purpose ${metadataText(shot, 'purpose')}` : '',
    metadataText(shot, 'framing') ? `${metadataText(shot, 'framing')} framing` : '',
    metadataText(shot, 'camera') ? `camera ${metadataText(shot, 'camera')}` : '',
    metadataText(shot, 'subjectAction') ? `action ${metadataText(shot, 'subjectAction')}` : '',
    characters.length ? `canonical characters: ${characters.map(characterPrompt).join(' | ')}` : '',
    locations.length ? `canonical location: ${locations.map(locationPrompt).join(' | ')}` : '',
    metadataText(shot, 'promptOverride'),
    style.tail,
  ].filter(Boolean);
  return {
    prompt: pieces.join(', ').slice(0, 12_000),
    style,
    series,
    episode,
    characters,
    locations,
  };
}

function resolvedShotSeed(compiled, scene, shot) {
  const override = explicitSeed(shot);
  if (override !== null) return override;
  const masterSeed = metadataText(compiled.series, 'masterSeed') || '1337';
  return deterministicSeed([
    masterSeed,
    scene.id,
    String(scene.revision),
    shot.id,
    String(shot.revision),
    sha256Text(compiled.prompt),
  ]);
}

function publicJob(job) {
  return {
    id: job.id,
    sceneId: job.sceneId,
    sceneTitle: job.sceneTitle,
    status: job.status,
    progress: job.progress,
    shotCount: job.shotCount,
    completedShots: job.completedShots,
    currentShotId: job.currentShotId,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    artifacts: job.artifacts.map((artifact) => ({ ...artifact, absolutePath: undefined })),
  };
}

export class SceneGenerationService {
  constructor({ bridge, comfy, artifactRoot }) {
    this.bridge = bridge;
    this.comfy = comfy;
    this.artifactRoot = resolve(artifactRoot);
    this.jobs = new Map();
    this.pending = [];
    this.activeJobId = null;
  }

  async providerStatus() {
    try {
      const capabilities = await this.comfy.capabilities();
      return {
        provider: 'comfyui',
        online: true,
        mode: 'storyboard-preview',
        ...capabilities,
      };
    } catch (error) {
      return {
        provider: 'comfyui',
        online: false,
        mode: 'storyboard-preview',
        baseUrl: this.comfy.baseUrl?.origin ?? 'http://127.0.0.1:8188',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async startScene(sceneId) {
    if (typeof sceneId !== 'string' || !sceneId || sceneId.length > 160) {
      throw generationError('invalid_argument', 'sceneId is required');
    }
    if (this.pending.length >= MAX_PENDING_JOBS) {
      throw generationError('busy', 'scene generation queue is full');
    }

    const snapshot = await this.bridge.snapshot();
    const scene = nodeById(snapshot, sceneId);
    if (!scene || scene.kind !== 'scene') throw generationError('not_found', 'scene node was not found');
    const shots = sceneShots(snapshot, sceneId);
    if (shots.length === 0) throw generationError('invalid_argument', 'scene has no linked shot nodes');
    if (shots.length > MAX_SHOTS_PER_SCENE) throw generationError('resource_exhausted', `scene exceeds ${MAX_SHOTS_PER_SCENE} shot preview bound`);

    const id = randomUUID();
    const now = new Date().toISOString();
    const job = {
      id,
      sceneId,
      sceneTitle: safeTitle(scene.title),
      status: 'queued',
      progress: 0,
      shotCount: shots.length,
      completedShots: 0,
      currentShotId: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      error: '',
      artifacts: [],
    };
    job.abortController = new AbortController();
    job.settled = new Promise((resolveSettled) => { job.resolveSettled = resolveSettled; });
    this.jobs.set(id, job);
    this.pending.push(id);
    this.#pruneJobs();
    void this.#pump();
    return publicJob(job);
  }

  list(limit = 20) {
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 20;
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, bounded)
      .map(publicJob);
  }

  get(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw generationError('not_found', 'generation job was not found');
    return publicJob(job);
  }

  async cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw generationError('not_found', 'generation job was not found');
    if (job.status === 'queued') {
      this.pending = this.pending.filter((id) => id !== job.id);
      job.status = 'cancelled';
      job.completedAt = new Date().toISOString();
      job.resolveSettled();
    } else if (job.status === 'running') {
      job.abortController.abort();
      await job.settled;
    }
    return publicJob(job);
  }

  artifact(jobId, shotId) {
    const job = this.jobs.get(jobId);
    if (!job) throw generationError('not_found', 'generation job was not found');
    const artifact = job.artifacts.find((candidate) => candidate.shotId === shotId);
    if (!artifact) throw generationError('not_found', 'generation artifact was not found');
    return artifact;
  }

  #pruneJobs() {
    if (this.jobs.size <= MAX_RETAINED_JOBS) return;
    const candidates = [...this.jobs.values()]
      .filter((job) => job.id !== this.activeJobId && job.status !== 'queued' && job.status !== 'running')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    while (this.jobs.size > MAX_RETAINED_JOBS && candidates.length) {
      this.jobs.delete(candidates.shift().id);
    }
  }

  async #pump() {
    if (this.activeJobId || this.pending.length === 0) return;
    const jobId = this.pending.shift();
    const job = this.jobs.get(jobId);
    if (!job) return void this.#pump();
    this.activeJobId = jobId;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    try {
      await this.#run(job);
      job.abortController.signal.throwIfAborted();
      job.status = 'completed';
      job.progress = 100;
      job.completedAt = new Date().toISOString();
    } catch (error) {
      job.status = job.abortController.signal.aborted ? 'cancelled' : 'failed';
      job.error = job.status === 'cancelled' ? '' : (error instanceof Error ? error.message : String(error)).slice(0, 1200);
      job.completedAt = new Date().toISOString();
    } finally {
      job.currentShotId = null;
      this.activeJobId = null;
      job.resolveSettled();
      this.#pruneJobs();
      void this.#pump();
    }
  }

  async #run(job) {
    const { signal } = job.abortController;
    signal.throwIfAborted();
    await this.comfy.capabilities({ force: true, signal });
    signal.throwIfAborted();
    let snapshot = await this.bridge.snapshot();
    const scene = nodeById(snapshot, job.sceneId);
    if (!scene || scene.kind !== 'scene') throw new Error('scene was removed before generation started');
    const shots = sceneShots(snapshot, scene.id);
    if (shots.length !== job.shotCount) throw new Error('scene shot topology changed after the generation job was queued; retry on the live revision');

    for (let index = 0; index < shots.length; index += 1) {
      signal.throwIfAborted();
      snapshot = await this.bridge.snapshot();
      const liveScene = nodeById(snapshot, scene.id);
      const shot = nodeById(snapshot, shots[index].id);
      if (!liveScene || !shot || shot.kind !== 'shot') throw new Error('scene topology changed during generation');
      job.currentShotId = shot.id;
      job.progress = Math.floor((index / shots.length) * 100);
      const generationNodeId = `generation.preview.${safeFilePart(shot.id)}`;
      const compiled = compiledShotPrompt(snapshot, liveScene, shot);
      const promptHash = sha256Text(compiled.prompt);
      const seed = resolvedShotSeed(compiled, liveScene, shot);
      const negativePrompt = [
        BASE_NEGATIVE_PROMPT,
        compiled.style.negative,
        metadataText(shot, 'negativePrompt'),
      ].filter(Boolean).join(', ');
      const startedAt = new Date().toISOString();

      await this.#setGenerationState(snapshot, generationNodeId, liveScene, shot, {
        targetKind: 'shot',
        targetId: shot.id,
        mediaType: 'image',
        strategy: 'STORYBOARD_PREVIEW',
        status: 'running',
        seed,
        promptHash,
        artifactPath: '',
        artifactSha256: '',
        promptId: '',
        startedAt,
        completedAt: '',
        error: '',
      });

      try {
        const filenamePrefix = `MakeWatch/${safeFilePart(liveScene.id)}/${safeFilePart(shot.id)}`;
        const width = Number(process.env.MAKEWATCH_PREVIEW_WIDTH ?? compiled.style.width);
        const height = Number(process.env.MAKEWATCH_PREVIEW_HEIGHT ?? compiled.style.height);
        const generated = await this.comfy.generateStoryboardFrame({
          prompt: compiled.prompt,
          negativePrompt,
          seed,
          width,
          height,
          steps: Number(process.env.MAKEWATCH_PREVIEW_STEPS ?? compiled.style.steps),
          cfg: Number(process.env.MAKEWATCH_PREVIEW_CFG ?? compiled.style.cfg),
          sampler: process.env.MAKEWATCH_PREVIEW_SAMPLER || compiled.style.sampler,
          filenamePrefix,
          signal,
        });
        signal.throwIfAborted();

        const extension = extname(generated.image.filename) || (generated.contentType.includes('jpeg') ? '.jpg' : '.png');
        const jobDirectory = join(this.artifactRoot, safeFilePart(liveScene.id), safeFilePart(job.id));
        await mkdir(jobDirectory, { recursive: true });
        const outputName = `${String(index + 1).padStart(3, '0')}-${safeFilePart(shot.id)}${extension}`;
        const absolutePath = join(jobDirectory, outputName);
        await writeFile(absolutePath, generated.bytes);
        const relativePath = relative(resolve(this.artifactRoot, '..', '..'), absolutePath).replaceAll('\\', '/');
        const artifactSha256 = sha256Bytes(generated.bytes);
        const assetNodeId = `asset.${artifactSha256.slice(0, 24)}`;
        const completedAt = new Date().toISOString();
        const artifact = {
          shotId: shot.id,
          generationNodeId,
          assetNodeId,
          filename: outputName,
          relativePath,
          absolutePath,
          contentType: generated.contentType,
          sha256: artifactSha256,
          promptId: generated.promptId,
          checkpoint: generated.checkpoint,
          seed,
          promptHash,
        };
        job.artifacts.push(artifact);

        let fresh = await this.bridge.snapshot();
        await this.#setGenerationState(fresh, generationNodeId, liveScene, shot, {
          targetKind: 'shot',
          targetId: shot.id,
          mediaType: 'image',
          strategy: 'STORYBOARD_PREVIEW',
          status: 'ready',
          seed,
          promptHash,
          artifactPath: relativePath,
          artifactSha256,
          promptId: generated.promptId,
          model: generated.checkpoint,
          checkpoint: generated.checkpoint,
          sampler: generated.sampler,
          scheduler: generated.scheduler,
          startedAt,
          completedAt,
          error: '',
        });
        fresh = await this.bridge.snapshot();
        await this.#registerAsset(fresh, {
          assetNodeId,
          generationNodeId,
          shot,
          relativePath,
          artifactSha256,
          contentType: generated.contentType,
          width,
          height,
        });
      } catch (error) {
        const fresh = await this.bridge.snapshot().catch(() => snapshot);
        await this.#setGenerationState(fresh, generationNodeId, liveScene, shot, {
          status: signal.aborted ? 'cancelled' : 'failed',
          seed,
          promptHash,
          completedAt: new Date().toISOString(),
          error: (error instanceof Error ? error.message : String(error)).slice(0, 600),
        }).catch(() => undefined);
        throw error;
      }

      job.completedShots = index + 1;
      job.progress = Math.floor(((index + 1) / shots.length) * 100);
    }

    const manifestDirectory = join(this.artifactRoot, safeFilePart(scene.id), safeFilePart(job.id));
    await mkdir(manifestDirectory, { recursive: true });
    await writeFile(join(manifestDirectory, 'manifest.json'), JSON.stringify({
      schemaVersion: 2,
      job: publicJob(job),
      completedAt: new Date().toISOString(),
    }, null, 2), 'utf8');
    signal.throwIfAborted();
  }

  async #setGenerationState(snapshot, generationNodeId, scene, shot, metadata) {
    const existing = nodeById(snapshot, generationNodeId);
    const baseMetadata = {
      purpose: 'storyboard-preview',
      provider: 'comfyui',
      mode: 'T2I-preview',
      sceneId: scene.id,
      shotId: shot.id,
      ...Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, String(value ?? '')])),
    };

    const commands = [];
    if (!existing) {
      commands.push({
        type: 'node.create',
        node: {
          id: generationNodeId,
          kind: 'generation',
          title: `${safeTitle(shot.title)} · Storyboard Preview`,
          approval: 'draft',
          locked: false,
          stale: false,
          metadata: baseMetadata,
        },
      });
      commands.push({ type: 'dependency.add', dependent: generationNodeId, dependency: shot.id });
      commands.push({ type: 'node.markFresh', id: generationNodeId });
    } else {
      if (existing.kind !== 'generation') throw new Error(`generation node ID collision: ${generationNodeId}`);
      if (existing.locked) throw new Error(`generation node is locked: ${generationNodeId}`);
      commands.push({
        type: 'node.patch',
        id: existing.id,
        expectedRevision: existing.revision,
        metadataUpdates: baseMetadata,
      });
      commands.push({ type: 'node.markFresh', id: existing.id });
      const linked = snapshot.dependencies.some((edge) => edge.dependent === existing.id && edge.dependency === shot.id);
      if (!linked) commands.splice(1, 0, { type: 'dependency.add', dependent: existing.id, dependency: shot.id });
    }

    await this.bridge.apply(commands, {
      actor: 'system',
      source: 'scene-storyboard-generation',
      reason: `update storyboard preview for ${shot.id}`,
    }, snapshot.projectRevision);
  }

  async #registerAsset(snapshot, {
    assetNodeId,
    generationNodeId,
    shot,
    relativePath,
    artifactSha256,
    contentType,
    width,
    height,
  }) {
    const existing = nodeById(snapshot, assetNodeId);
    const metadata = {
      mediaType: 'image',
      role: 'shot-preview',
      relativePath,
      sha256: artifactSha256,
      mimeType: contentType,
      width: String(Math.max(0, Math.round(Number(width) || 0))),
      height: String(Math.max(0, Math.round(Number(height) || 0))),
      source: 'generated',
      generatedBy: generationNodeId,
    };
    if (existing) {
      if (existing.kind !== 'asset') throw new Error(`asset node ID collision: ${assetNodeId}`);
      return;
    }
    await this.bridge.apply([
      {
        type: 'node.create',
        node: {
          id: assetNodeId,
          kind: 'asset',
          title: `${safeTitle(shot.title)} · Preview Asset`,
          approval: 'draft',
          locked: false,
          stale: false,
          metadata,
        },
      },
      { type: 'dependency.add', dependent: assetNodeId, dependency: generationNodeId },
      { type: 'node.markFresh', id: assetNodeId },
    ], {
      actor: 'system',
      source: 'scene-storyboard-generation',
      reason: `register generated preview asset for ${shot.id}`,
    }, snapshot.projectRevision);
  }
}

// Exported so the style contract can be tested without a live ComfyUI.
export const sceneGenerationInternals = Object.freeze({
  STYLE_PRESETS,
  DEFAULT_STYLE_PRESET,
  stylePresetFor,
  compiledShotPrompt,
  BASE_NEGATIVE_PROMPT,
});
