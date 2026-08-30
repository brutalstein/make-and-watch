import { randomUUID } from 'node:crypto';

import { buildTemporalShotRequest } from './temporal-shot-contract.mjs';

const MAX_PENDING_TEMPORAL_JOBS = 4;
const MAX_RETAINED_TEMPORAL_JOBS = 80;

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function nodeById(snapshot, id) {
  return snapshot.nodes.find((node) => node.id === id) ?? null;
}

function hasDependency(snapshot, dependent, dependency) {
  return snapshot.dependencies.some((edge) => edge.dependent === dependent && edge.dependency === dependency);
}

function safeIdPart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'shot';
}

function stringMetadata(entries) {
  return Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, String(value ?? '')]));
}

function publicJob(job) {
  return {
    id: job.id,
    shotId: job.shotId,
    shotTitle: job.shotTitle,
    providerId: job.providerId,
    strategy: job.strategy,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    generationNodeId: job.generationNodeId,
    artifact: job.artifact,
  };
}

export class TemporalShotGenerationService {
  constructor({ bridge, registry, scheduler, hardware = () => ({ totalVramMb: 8192 }) }) {
    if (!bridge || typeof bridge.snapshot !== 'function' || typeof bridge.apply !== 'function') {
      throw new Error('TemporalShotGenerationService requires a project bridge');
    }
    if (!registry || typeof registry.generate !== 'function' || typeof registry.statuses !== 'function') {
      throw new Error('TemporalShotGenerationService requires a temporal provider registry');
    }
    if (!scheduler || typeof scheduler.run !== 'function') {
      throw new Error('TemporalShotGenerationService requires a GPU scheduler');
    }
    this.bridge = bridge;
    this.registry = registry;
    this.scheduler = scheduler;
    this.hardware = hardware;
    this.jobs = new Map();
    this.pending = [];
    this.activeJobId = null;
  }

  async providerStatuses() {
    return this.registry.statuses({ hardware: await this.hardware() });
  }

  async plan(shotId, options = {}) {
    const snapshot = await this.bridge.snapshot();
    const hardware = await this.hardware();
    return buildTemporalShotRequest(snapshot, shotId, {
      totalVramMb: options.totalVramMb ?? hardware?.totalVramMb ?? 8192,
      ...(options.maxSegmentSeconds === undefined ? {} : { maxSegmentSeconds: options.maxSegmentSeconds }),
    });
  }

  async startShot({ shotId, providerId }) {
    if (typeof providerId !== 'string' || !providerId.trim()) {
      throw serviceError('invalid_argument', 'temporal providerId is required');
    }
    if (this.pending.length >= MAX_PENDING_TEMPORAL_JOBS) {
      throw serviceError('busy', 'temporal generation queue is full');
    }
    const snapshot = await this.bridge.snapshot();
    const hardware = await this.hardware();
    const request = buildTemporalShotRequest(snapshot, shotId, {
      totalVramMb: hardware?.totalVramMb ?? 8192,
    });
    const shot = nodeById(snapshot, request.shot.id);
    if (!shot) throw serviceError('not_found', 'shot disappeared while temporal request was being planned');

    const now = new Date().toISOString();
    const job = {
      id: randomUUID(),
      shotId: request.shot.id,
      shotTitle: request.shot.title,
      shotRevision: request.shot.revision,
      projectRevision: request.projectRevision,
      providerId: providerId.trim(),
      strategy: request.shot.strategy,
      status: 'queued',
      progress: 0,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      error: '',
      generationNodeId: null,
      artifact: null,
    };
    this.jobs.set(job.id, job);
    this.pending.push(job.id);
    this.#prune();
    void this.#pump();
    return publicJob(job);
  }

  list(limit = 20) {
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(50, limit)) : 20;
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, bounded)
      .map(publicJob);
  }

  get(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw serviceError('not_found', 'temporal generation job was not found');
    return publicJob(job);
  }

  #prune() {
    if (this.jobs.size <= MAX_RETAINED_TEMPORAL_JOBS) return;
    const completed = [...this.jobs.values()]
      .filter((job) => job.id !== this.activeJobId && job.status !== 'queued' && job.status !== 'running')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    while (this.jobs.size > MAX_RETAINED_TEMPORAL_JOBS && completed.length) {
      this.jobs.delete(completed.shift().id);
    }
  }

  async #pump() {
    if (this.activeJobId || this.pending.length === 0) return;
    const id = this.pending.shift();
    const job = this.jobs.get(id);
    if (!job) return void this.#pump();
    this.activeJobId = id;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.progress = 5;
    try {
      await this.#run(job);
      job.status = 'completed';
      job.progress = 100;
      job.completedAt = new Date().toISOString();
    } catch (error) {
      job.status = 'failed';
      job.error = (error instanceof Error ? error.message : String(error)).slice(0, 1600);
      job.completedAt = new Date().toISOString();
    } finally {
      this.activeJobId = null;
      this.#prune();
      void this.#pump();
    }
  }

  async #run(job) {
    const before = await this.bridge.snapshot();
    const hardware = await this.hardware();
    const request = buildTemporalShotRequest(before, job.shotId, {
      totalVramMb: hardware?.totalVramMb ?? 8192,
    });
    if (request.shot.revision !== job.shotRevision) {
      throw serviceError(
        'stale_request',
        `Shot ${job.shotId} changed from revision ${job.shotRevision} to ${request.shot.revision} while queued; regenerate the temporal plan`,
      );
    }

    job.progress = 10;
    const result = await this.scheduler.run(
      { kind: 'temporal-video', id: job.id },
      () => this.registry.generate(job.providerId, request, { hardware }),
    );
    job.progress = 85;

    const fresh = await this.bridge.snapshot();
    const currentShot = nodeById(fresh, job.shotId);
    if (!currentShot || currentShot.revision !== job.shotRevision) {
      throw serviceError(
        'stale_request',
        `Shot ${job.shotId} changed before temporal output could be committed; generated output was not attached to project truth`,
      );
    }

    const generationNodeId = `generation.temporal.${safeIdPart(job.shotId)}.${job.id.replaceAll('-', '').slice(0, 12)}`;
    const assetNodeId = `asset.${result.artifact.sha256.slice(0, 24)}`;
    const commands = [];
    commands.push({
      type: 'node.create',
      node: {
        id: generationNodeId,
        kind: 'generation',
        title: `${String(currentShot.title ?? job.shotId).slice(0, 180)} · Temporal ${job.strategy}`,
        approval: 'draft',
        locked: false,
        stale: false,
        metadata: stringMetadata({
          targetKind: 'shot',
          targetId: job.shotId,
          mediaType: 'video',
          strategy: job.strategy,
          provider: result.provider,
          status: 'ready',
          shotRevision: job.shotRevision,
          projectRevisionPlanned: job.projectRevision,
          startFrameAssetId: request.inputs.startFrame?.id ?? '',
          endFrameAssetId: request.inputs.endFrame?.id ?? '',
          characterIds: JSON.stringify(request.inputs.characters.map((anchor) => anchor.id)),
          locationIds: JSON.stringify(request.inputs.locations.map((anchor) => anchor.id)),
          referenceAssetIds: JSON.stringify(request.inputs.referenceAssets.map((asset) => asset.id)),
          segmentCount: request.segments.length,
          artifactPath: result.artifact.relativePath,
          artifactSha256: result.artifact.sha256,
          durationSeconds: result.artifact.durationSeconds,
          width: result.artifact.width,
          height: result.artifact.height,
          fps: result.artifact.fps,
          providerMetadata: JSON.stringify(result.artifact.providerMetadata ?? {}),
          completedAt: new Date().toISOString(),
        }),
      },
    });
    commands.push({ type: 'dependency.add', dependent: generationNodeId, dependency: job.shotId });

    const inputAssetIds = new Set([
      request.inputs.startFrame?.id,
      request.inputs.endFrame?.id,
      ...request.inputs.referenceAssets.map((asset) => asset.id),
    ].filter(Boolean));
    for (const inputAssetId of inputAssetIds) {
      commands.push({ type: 'dependency.add', dependent: generationNodeId, dependency: inputAssetId });
    }

    const existingAsset = nodeById(fresh, assetNodeId);
    if (existingAsset && existingAsset.kind !== 'asset') {
      throw serviceError('conflict', `temporal output asset id collides with non-Asset node ${assetNodeId}`);
    }
    if (!existingAsset) {
      commands.push({
        type: 'node.create',
        node: {
          id: assetNodeId,
          kind: 'asset',
          title: `${String(currentShot.title ?? job.shotId).slice(0, 180)} · Temporal Video`,
          approval: 'draft',
          locked: false,
          stale: false,
          metadata: stringMetadata({
            mediaType: 'video',
            role: 'shot-output',
            relativePath: result.artifact.relativePath,
            sha256: result.artifact.sha256,
            mimeType: result.artifact.mimeType,
            durationSeconds: result.artifact.durationSeconds,
            width: result.artifact.width,
            height: result.artifact.height,
            fps: result.artifact.fps,
            source: 'generated',
            generatedBy: generationNodeId,
          }),
        },
      });
    }
    if (!hasDependency(fresh, assetNodeId, generationNodeId)) {
      commands.push({ type: 'dependency.add', dependent: assetNodeId, dependency: generationNodeId });
    }
    commands.push({ type: 'node.markFresh', id: generationNodeId });
    if (!existingAsset) commands.push({ type: 'node.markFresh', id: assetNodeId });

    await this.bridge.apply(commands, {
      actor: 'system',
      source: 'temporal-shot-generation',
      reason: `register ${job.strategy} temporal output for ${job.shotId}`,
    }, fresh.projectRevision);

    job.generationNodeId = generationNodeId;
    job.artifact = {
      assetNodeId,
      relativePath: result.artifact.relativePath,
      sha256: result.artifact.sha256,
      durationSeconds: result.artifact.durationSeconds,
      width: result.artifact.width,
      height: result.artifact.height,
      fps: result.artifact.fps,
    };
    job.progress = 96;
  }
}

export const temporalShotGenerationLimits = Object.freeze({
  maxPendingJobs: MAX_PENDING_TEMPORAL_JOBS,
  maxRetainedJobs: MAX_RETAINED_TEMPORAL_JOBS,
});
