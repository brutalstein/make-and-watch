import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const MAX_PENDING_JOBS = 8;
const MAX_RETAINED_JOBS = 100;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const TARGET_KINDS = new Set(['character', 'location']);
const STYLE_PRESETS = new Set(['live-action-cinematic', 'anime-cinematic', 'illustration', 'stylized-3d']);

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safePart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'reference';
}

function nodeById(snapshot, id) {
  return snapshot.nodes.find((candidate) => candidate.id === id) ?? null;
}

function dependenciesOf(snapshot, id) {
  return snapshot.dependencies
    .filter((edge) => edge.dependent === id)
    .map((edge) => nodeById(snapshot, edge.dependency))
    .filter(Boolean);
}

function firstDependency(snapshot, id, kind) {
  return dependenciesOf(snapshot, id).find((candidate) => candidate.kind === kind) ?? null;
}

function seriesForTarget(snapshot, target) {
  if (target.kind === 'character' || target.kind === 'location') {
    const direct = firstDependency(snapshot, target.id, 'series');
    if (direct) return direct;
  }
  return snapshot.nodes.find((candidate) => candidate.kind === 'series') ?? null;
}

function safeManagedPath(projectRoot, relativePath) {
  const makewatchRoot = resolve(projectRoot, '.makewatch');
  const candidate = resolve(makewatchRoot, String(relativePath ?? ''));
  const rel = relative(makewatchRoot, candidate);
  if (!relativePath || rel.startsWith('..') || rel.includes('\0')) {
    throw serviceError('invalid_argument', 'reference source Asset path escapes the project media root');
  }
  return candidate;
}

function hashText(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function deterministicSeed(parts) {
  return createHash('sha256').update(parts.join('|')).digest().readUInt32BE(0);
}

function styleLanguage(stylePreset) {
  if (stylePreset === 'anime-cinematic') {
    return 'premium cinematic anime character design, hand-drawn 2D sensibility, precise expressive linework, controlled cel shading, sophisticated film lighting, coherent anatomy, preserve recognizable facial geometry, hair silhouette, age presentation and signature visual traits';
  }
  if (stylePreset === 'illustration') {
    return 'premium editorial illustration, intentional line and shape language, painterly controlled texture, coherent anatomy, sophisticated lighting and composition, preserve recognizable identity and signature visual traits';
  }
  if (stylePreset === 'stylized-3d') {
    return 'premium stylized 3D cinematic character design, physically coherent materials, expressive but believable proportions, studio-quality lighting, preserve recognizable facial geometry and signature visual traits';
  }
  return 'premium live-action cinematic realism, natural skin and material response, physically coherent lens and lighting, subtle filmic texture, preserve recognizable facial geometry and signature visual traits';
}

function targetPrompt(target) {
  const metadata = target.metadata ?? {};
  if (target.kind === 'character') {
    return [
      target.title,
      metadata.appearancePrompt,
      metadata.description,
      metadata.wardrobe ? `wardrobe: ${metadata.wardrobe}` : '',
      metadata.agePresentation ? `age presentation: ${metadata.agePresentation}` : '',
      metadata.performanceStyle ? `performance: ${metadata.performanceStyle}` : '',
    ].filter(Boolean).join(', ');
  }
  return [
    target.title,
    metadata.environmentPrompt,
    metadata.description,
    metadata.city,
    metadata.time,
    metadata.weather,
    metadata.lighting,
    metadata.palette,
  ].filter(Boolean).join(', ');
}

function compilePrompt(target, series, stylePreset, direction, hasSource) {
  const visualLanguage = String(series?.metadata?.visualLanguage ?? '').trim();
  const base = targetPrompt(target);
  const sourceInstruction = hasSource
    ? target.kind === 'character'
      ? 'Use the supplied image as the visual identity reference. Preserve observable identity-defining structure while applying the requested art direction; do not copy background text, logos or unrelated people.'
      : 'Use the supplied image as the environment/layout reference. Preserve major spatial structure, palette relationships and recognizable place cues while applying the requested art direction.'
    : target.kind === 'character'
      ? 'Design one coherent reusable canonical identity from the written character brief.'
      : 'Design one coherent reusable canonical environment from the written location brief.';
  return [styleLanguage(stylePreset), visualLanguage, base, direction, sourceInstruction, 'single canonical reference image, production concept art quality, clean readable subject'].filter(Boolean).join('. ').slice(0, 12_000);
}

function negativePrompt(target, hasSource) {
  return [
    'low quality, blurry, jpeg artifacts, watermark, logo, text, duplicate subject, incoherent anatomy, deformed hands, accidental costume changes, inconsistent lighting',
    target.kind === 'character' && hasSource ? 'identity drift, different person, changed facial proportions, changed hair silhouette, age drift' : '',
    target.kind === 'location' && hasSource ? 'layout drift, unrelated location, contradictory architecture' : '',
  ].filter(Boolean).join(', ');
}

function publicJob(job) {
  return {
    id: job.id,
    targetId: job.targetId,
    targetKind: job.targetKind,
    targetTitle: job.targetTitle,
    sourceAssetId: job.sourceAssetId,
    stylePreset: job.stylePreset,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    artifact: job.artifact ? { ...job.artifact, absolutePath: undefined } : null,
  };
}

export class AnchorReferenceGenerationService {
  constructor({ bridge, comfy, scheduler, projectRoot }) {
    this.bridge = bridge;
    this.comfy = comfy;
    this.scheduler = scheduler;
    this.projectRoot = resolve(projectRoot);
    this.jobs = new Map();
    this.pending = [];
    this.activeJobId = null;
  }

  async providerStatus() {
    try {
      const capabilities = await this.comfy.capabilities();
      return {
        provider: 'comfyui',
        ready: true,
        checkpoint: capabilities.checkpoint,
        modes: ['T2I_REFERENCE', 'IMG2IMG_REFERENCE'],
        detail: 'Local ComfyUI reference generation is ready.',
      };
    } catch (error) {
      return {
        provider: 'comfyui',
        ready: false,
        checkpoint: '',
        modes: ['T2I_REFERENCE', 'IMG2IMG_REFERENCE'],
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async start({ targetId, sourceAssetId = null, stylePreset = '', direction = '', denoise = 0.58 }) {
    if (typeof targetId !== 'string' || !targetId || targetId.length > 180) throw serviceError('invalid_argument', 'targetId is required');
    if (sourceAssetId !== null && (typeof sourceAssetId !== 'string' || !sourceAssetId || sourceAssetId.length > 180)) {
      throw serviceError('invalid_argument', 'sourceAssetId is invalid');
    }
    if (this.pending.length >= MAX_PENDING_JOBS) throw serviceError('busy', 'reference generation queue is full');
    const snapshot = await this.bridge.snapshot();
    const target = nodeById(snapshot, targetId);
    if (!target || !TARGET_KINDS.has(target.kind)) throw serviceError('not_found', 'reference target must be an existing Character or Location');
    if (target.locked) throw serviceError('conflict', `Unlock ${target.title} before replacing or adding its canonical reference`);
    const source = sourceAssetId ? nodeById(snapshot, sourceAssetId) : null;
    if (sourceAssetId && (!source || source.kind !== 'asset' || source.metadata?.mediaType !== 'image')) {
      throw serviceError('invalid_argument', 'sourceAssetId must reference an image Asset');
    }
    const series = seriesForTarget(snapshot, target);
    const style = STYLE_PRESETS.has(stylePreset)
      ? stylePreset
      : STYLE_PRESETS.has(series?.metadata?.stylePreset) ? series.metadata.stylePreset : 'live-action-cinematic';
    const job = {
      id: randomUUID(),
      targetId: target.id,
      targetRevision: target.revision,
      targetKind: target.kind,
      targetTitle: String(target.title || target.id).slice(0, 240),
      sourceAssetId: source?.id ?? null,
      sourceRevision: source?.revision ?? null,
      stylePreset: style,
      direction: String(direction ?? '').trim().slice(0, 4_000),
      denoise: Math.max(0.15, Math.min(0.9, Number(denoise) || 0.58)),
      status: 'queued',
      progress: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      error: '',
      artifact: null,
    };
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
    if (!job) throw serviceError('not_found', 'reference generation job was not found');
    return publicJob(job);
  }

  artifact(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw serviceError('not_found', 'reference generation job was not found');
    if (!job.artifact) throw serviceError('not_found', 'reference artifact is not ready');
    return job.artifact;
  }

  #prune() {
    if (this.jobs.size <= MAX_RETAINED_JOBS) return;
    const completed = [...this.jobs.values()]
      .filter((job) => job.status !== 'queued' && job.status !== 'running' && job.id !== this.activeJobId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (this.jobs.size > MAX_RETAINED_JOBS && completed.length) this.jobs.delete(completed.shift().id);
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
      await this.scheduler.run({ kind: 'reference', id: job.id }, () => this.#run(job));
      job.status = 'completed';
      job.progress = 100;
      job.completedAt = new Date().toISOString();
    } catch (error) {
      job.status = 'failed';
      job.error = (error instanceof Error ? error.message : String(error)).slice(0, 1800);
      job.completedAt = new Date().toISOString();
      await this.#recordFailure(job).catch(() => undefined);
    } finally {
      this.activeJobId = null;
      this.#prune();
      void this.#pump();
    }
  }

  async #run(job) {
    let snapshot = await this.bridge.snapshot();
    const target = nodeById(snapshot, job.targetId);
    if (!target || target.kind !== job.targetKind) throw serviceError('stale_request', 'reference target was removed before generation started');
    if (target.revision !== job.targetRevision) throw serviceError('stale_request', 'reference target changed while the generation job was queued; submit again from the current revision');
    if (target.locked) throw serviceError('conflict', 'reference target became locked before generation started');
    const source = job.sourceAssetId ? nodeById(snapshot, job.sourceAssetId) : null;
    if (job.sourceAssetId && (!source || source.revision !== job.sourceRevision || source.kind !== 'asset')) {
      throw serviceError('stale_request', 'source reference Asset changed while the generation job was queued');
    }
    const series = seriesForTarget(snapshot, target);
    const prompt = compilePrompt(target, series, job.stylePreset, job.direction, Boolean(source));
    const negative = negativePrompt(target, Boolean(source));
    const promptHash = hashText(`${prompt}\nNEGATIVE:${negative}`);
    const seed = deterministicSeed([
      String(series?.metadata?.masterSeed ?? '1337'),
      target.id,
      String(target.revision),
      source?.metadata?.sha256 ?? source?.id ?? 'no-source',
      job.stylePreset,
      job.direction,
    ]);
    const generationNodeId = `generation.reference.${safePart(job.id)}`;
    await this.#upsertGeneration(snapshot, generationNodeId, job, {
      status: 'running', promptHash, seed, provider: 'comfyui', startedAt: job.startedAt, completedAt: '', artifactPath: '', artifactSha256: '', error: '',
    });
    job.progress = 15;

    let generated;
    if (source) {
      const sourcePath = safeManagedPath(this.projectRoot, source.metadata?.relativePath);
      const metadata = await stat(sourcePath).catch(() => null);
      if (!metadata?.isFile() || metadata.size < 1 || metadata.size > MAX_SOURCE_BYTES) {
        throw serviceError('not_ready', 'source reference image file is missing or exceeds the safe size limit');
      }
      const sourceBytes = await readFile(sourcePath);
      generated = await this.comfy.generateReferenceImage({
        sourceBytes,
        sourceFilename: source.metadata?.originalFilename || `${safePart(source.id)}.png`,
        sourceContentType: source.metadata?.mimeType || 'image/png',
        prompt,
        negativePrompt: negative,
        seed,
        denoise: job.denoise,
        steps: job.stylePreset === 'anime-cinematic' ? 28 : 24,
        cfg: 6,
        filenamePrefix: `MakeWatch/reference/${safePart(target.id)}`,
      });
    } else {
      generated = await this.comfy.generateStoryboardFrame({
        prompt,
        negativePrompt: negative,
        seed,
        width: target.kind === 'character' ? 768 : 960,
        height: target.kind === 'character' ? 960 : 640,
        steps: 26,
        cfg: 6.5,
        filenamePrefix: `MakeWatch/reference/${safePart(target.id)}`,
      });
    }
    job.progress = 75;

    const bytes = Buffer.from(generated.bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const extension = String(generated.contentType).includes('jpeg') ? '.jpg' : '.png';
    const directory = resolve(this.projectRoot, '.makewatch', 'artifacts', 'references', safePart(target.id));
    await mkdir(directory, { recursive: true });
    const outputPath = resolve(directory, `${sha256}${extension}`);
    const existing = await stat(outputPath).catch(() => null);
    if (!existing) await writeFile(outputPath, bytes, { flag: 'wx' });
    const relativePath = relative(resolve(this.projectRoot, '.makewatch'), outputPath).replaceAll('\\', '/');
    const assetNodeId = `asset.${sha256.slice(0, 24)}`;
    const completedAt = new Date().toISOString();
    job.artifact = {
      assetNodeId,
      generationNodeId,
      filename: `${safePart(target.id)}${extension}`,
      relativePath,
      absolutePath: outputPath,
      contentType: generated.contentType || 'image/png',
      sha256,
      provider: 'comfyui',
      checkpoint: generated.checkpoint,
      sampler: generated.sampler,
      scheduler: generated.scheduler,
      promptId: generated.promptId,
      seed,
      stylePreset: job.stylePreset,
      sourceAssetId: source?.id ?? null,
    };

    snapshot = await this.bridge.snapshot();
    await this.#upsertGeneration(snapshot, generationNodeId, job, {
      status: 'ready', promptHash, seed, provider: 'comfyui', model: generated.checkpoint, sampler: generated.sampler, scheduler: generated.scheduler,
      promptId: generated.promptId, startedAt: job.startedAt, completedAt, artifactPath: relativePath, artifactSha256: sha256, error: '',
    });
    snapshot = await this.bridge.snapshot();
    await this.#registerAssetAndLinkTarget(snapshot, target.id, assetNodeId, generationNodeId, job, job.artifact);
    job.progress = 95;
  }

  async #upsertGeneration(snapshot, generationNodeId, job, metadata) {
    const existing = nodeById(snapshot, generationNodeId);
    const normalized = Object.fromEntries(Object.entries({
      targetKind: job.targetKind,
      targetId: job.targetId,
      mediaType: 'image',
      strategy: job.sourceAssetId ? 'IMG2IMG_REFERENCE' : 'T2I_REFERENCE',
      stylePreset: job.stylePreset,
      sourceAssetId: job.sourceAssetId ?? '',
      ...metadata,
    }).map(([key, value]) => [key, String(value ?? '')]));
    const commands = [];
    if (!existing) {
      commands.push({
        type: 'node.create',
        node: {
          id: generationNodeId,
          kind: 'generation',
          title: `${job.targetTitle} · Reference Generation`,
          metadata: normalized,
          approval: 'draft', locked: false, stale: false,
        },
      });
      if (job.sourceAssetId) commands.push({ type: 'dependency.add', dependent: generationNodeId, dependency: job.sourceAssetId });
      commands.push({ type: 'node.markFresh', id: generationNodeId });
    } else {
      if (existing.kind !== 'generation' || existing.locked) throw serviceError('conflict', 'reference Generation node cannot be updated');
      commands.push({ type: 'node.patch', id: existing.id, expectedRevision: existing.revision, metadataUpdates: normalized });
      commands.push({ type: 'node.markFresh', id: existing.id });
    }
    await this.bridge.apply(commands, { actor: 'system', source: 'reference-generation', reason: `record reference generation for ${job.targetId}` }, snapshot.projectRevision);
  }

  async #registerAssetAndLinkTarget(snapshot, targetId, assetNodeId, generationNodeId, job, artifact) {
    const target = nodeById(snapshot, targetId);
    if (!target || target.kind !== job.targetKind) throw serviceError('stale_request', 'reference target disappeared before output registration');
    if (target.locked) throw serviceError('conflict', 'reference target was locked before output registration');
    const existing = nodeById(snapshot, assetNodeId);
    const commands = [];
    if (!existing) {
      commands.push({
        type: 'node.create',
        node: {
          id: assetNodeId,
          kind: 'asset',
          title: `${job.targetTitle} · ${job.stylePreset} Reference`,
          approval: 'draft', locked: false, stale: false,
          metadata: {
            mediaType: 'image',
            role: `${job.targetKind}-reference`,
            relativePath: artifact.relativePath,
            sha256: artifact.sha256,
            mimeType: artifact.contentType,
            source: 'generated',
            generatedBy: generationNodeId,
            provider: artifact.provider,
            checkpoint: artifact.checkpoint,
            stylePreset: artifact.stylePreset,
            sourceAssetId: artifact.sourceAssetId ?? '',
          },
        },
      });
      commands.push({ type: 'dependency.add', dependent: assetNodeId, dependency: generationNodeId });
      commands.push({ type: 'node.markFresh', id: assetNodeId });
    } else {
      if (existing.kind !== 'asset' || existing.metadata?.sha256 !== artifact.sha256) throw serviceError('integrity_error', `reference output Asset ID collision: ${assetNodeId}`);
      if (!snapshot.dependencies.some((edge) => edge.dependent === existing.id && edge.dependency === generationNodeId)) {
        commands.push({ type: 'dependency.add', dependent: existing.id, dependency: generationNodeId });
      }
      if (existing.stale && !existing.locked) commands.push({ type: 'node.markFresh', id: existing.id, expectedRevision: existing.revision });
    }
    if (!snapshot.dependencies.some((edge) => edge.dependent === target.id && edge.dependency === assetNodeId)) {
      commands.push({ type: 'dependency.add', dependent: target.id, dependency: assetNodeId });
    }
    if (commands.length) {
      await this.bridge.apply(commands, { actor: 'system', source: 'reference-generation', reason: `register canonical reference for ${target.id}` }, snapshot.projectRevision);
    }
  }

  async #recordFailure(job) {
    const snapshot = await this.bridge.snapshot();
    const generationNodeId = `generation.reference.${safePart(job.id)}`;
    const existing = nodeById(snapshot, generationNodeId);
    if (!existing || existing.kind !== 'generation' || existing.locked) return;
    await this.bridge.apply([{
      type: 'node.patch',
      id: existing.id,
      expectedRevision: existing.revision,
      metadataUpdates: { status: 'failed', completedAt: job.completedAt ?? new Date().toISOString(), error: job.error },
    }], { actor: 'system', source: 'reference-generation', reason: `record failed reference generation for ${job.targetId}` }, snapshot.projectRevision);
  }
}

export const anchorReferenceGenerationLimits = Object.freeze({
  maxPendingJobs: MAX_PENDING_JOBS,
  maxRetainedJobs: MAX_RETAINED_JOBS,
  maxSourceBytes: MAX_SOURCE_BYTES,
  stylePresets: [...STYLE_PRESETS],
});
