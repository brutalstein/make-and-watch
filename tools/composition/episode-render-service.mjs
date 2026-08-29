import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';

import { ensureFfmpegRuntime } from '../runtime/ffmpeg-runtime-manager.mjs';
import { buildCameraMotionFilter } from './camera-motion.mjs';
import { compileEpisodeComposition } from './episode-composition.mjs';

const MAX_PENDING_RENDERS = 3;
const MAX_RETAINED_RENDERS = 50;
const PROCESS_TIMEOUT_MS = 60 * 60 * 1000;
const VIDEO_CRF = String(process.env.MAKEWATCH_PREVIEW_CRF ?? '18');
const VIDEO_PRESET = process.env.MAKEWATCH_PREVIEW_PRESET ?? 'veryfast';

function renderError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeFilePart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'item';
}

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function exists(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

function runProcess(command, args, { cwd, timeoutMs = PROCESS_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
      env: { ...process.env, AV_LOG_FORCE_NOCOLOR: '1' },
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-12_000);
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error(`${basename(command)} exceeded bounded render runtime`));
    }, timeoutMs);
    timer.unref();
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else reject(new Error(`${basename(command)} exited with code ${code ?? 'unknown'}${stderr ? `: ${stderr}` : ''}`));
    });
  });
}

function projectAssetPath(projectRoot, media) {
  if (!media?.relativePath) throw new Error('composition media has no relativePath');
  const makewatchRoot = resolve(projectRoot, '.makewatch');
  const path = resolve(makewatchRoot, media.relativePath);
  const rel = relative(makewatchRoot, path);
  if (rel.startsWith('..')) throw new Error(`media escapes .makewatch artifact root: ${media.relativePath}`);
  return path;
}

function concatLine(filename) {
  const safe = String(filename).replaceAll("'", "'\\''");
  return `file '${safe}'`;
}

function scaleFilter(profile) {
  return `scale=${profile.width}:${profile.height}:force_original_aspect_ratio=decrease,pad=${profile.width}:${profile.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
}

export function sceneCacheKey(manifest, scene) {
  return sha256Text(JSON.stringify({
    renderer: 'ffmpeg-scene-v2',
    encoding: { crf: VIDEO_CRF, preset: VIDEO_PRESET, transitionSeconds: DEFAULT_TRANSITION_SECONDS },
    profile: manifest.profile,
    durationSeconds: scene.durationSeconds,
    transitionIn: scene.transitionIn,
    transitionOut: scene.transitionOut,
    shots: scene.shots.map((shot) => ({
      id: shot.id,
      durationSeconds: shot.durationSeconds,
      strategy: shot.strategy,
      camera: shot.camera,
      motionLevel: shot.motionLevel,
      transitionOut: shot.transitionOut,
      sha256: shot.media?.sha256 ?? '',
      mediaType: shot.media?.mediaType ?? '',
    })),
    audio: scene.audio.map((cue) => ({
      id: cue.id,
      startSeconds: cue.startSeconds - scene.startSeconds,
      durationSeconds: cue.durationSeconds,
      volumeDb: cue.volumeDb,
      sha256: cue.media?.sha256 ?? '',
    })),
  }));
}

function publicJob(job) {
  return {
    id: job.id,
    episodeId: job.episodeId,
    episodeTitle: job.episodeTitle,
    status: job.status,
    progress: job.progress,
    sceneCount: job.sceneCount,
    completedScenes: job.completedScenes,
    cachedScenes: job.cachedScenes,
    currentSceneId: job.currentSceneId,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    error: job.error,
    artifact: job.artifact ? { ...job.artifact, absolutePath: undefined } : null,
  };
}

// Editorial transition -> ffmpeg xfade. `match-cut` is an editorial idea rather
// than an optical effect, so it renders as a hard cut like `cut` does.
const XFADE_TRANSITIONS = {
  fade: 'fade',
  dissolve: 'fade',
  'dip-black': 'fadeblack',
};
const configuredTransitionSeconds = Number(process.env.MAKEWATCH_TRANSITION_SECONDS ?? 0.5);
const DEFAULT_TRANSITION_SECONDS = Number.isFinite(configuredTransitionSeconds)
  ? Math.max(0, Math.min(2, configuredTransitionSeconds))
  : 0.5;

/**
 * Plan the transitions between the shots of one scene.
 *
 * An xfade consumes time from both sides, so a scene built from N shots joined
 * by overlaps would finish short and every later scene would drift against the
 * episode timeline. Each shot is therefore rendered longer than its editorial
 * duration by exactly the overlap it gives away, which makes the assembled
 * scene land back on the sum of the authored durations.
 *
 * Returns `null` when every join is a hard cut, so the caller keeps its cheaper
 * stream-copy concat instead of re-encoding for no visible gain.
 */
export function planSceneTransitions(shots, fps) {
  const frameSeconds = 1 / Math.max(1, Number(fps) || 24);
  const plans = shots.map((shot, index) => {
    const duration = Math.max(0.04, Number(shot.durationSeconds));
    const isLast = index === shots.length - 1;
    const kind = XFADE_TRANSITIONS[String(shot.transitionOut ?? 'cut')] ?? null;
    if (isLast || !kind) return { transition: null, overlap: 0, duration, renderDuration: duration };

    // An overlap may never eat more than half of either side, and must stay at
    // least a frame long or xfade has nothing to interpolate across.
    const next = Math.max(0.04, Number(shots[index + 1].durationSeconds));
    const overlap = Math.min(DEFAULT_TRANSITION_SECONDS, duration / 2, next / 2);
    if (!(overlap >= frameSeconds)) {
      return { transition: null, overlap: 0, duration, renderDuration: duration };
    }
    return { transition: kind, overlap, duration, renderDuration: duration + overlap };
  });

  if (!plans.some((plan) => plan.transition)) return null;
  return plans;
}

/**
 * Build the xfade filter graph that joins pre-rendered shot segments.
 *
 * Each xfade offset is measured against the running length of everything
 * already chained, which is what keeps a scene of many transitions in sync
 * rather than accumulating drift.
 */
export function buildTransitionGraph(plans) {
  const steps = [];
  let label = '0:v';
  let running = plans[0].renderDuration;

  for (let index = 1; index < plans.length; index += 1) {
    const previous = plans[index - 1];
    const output = index === plans.length - 1 ? 'vout' : `vx${index}`;
    if (previous.transition) {
      const offset = Math.max(0, running - previous.overlap);
      steps.push(
        `[${label}][${index}:v]xfade=transition=${previous.transition}`
        + `:duration=${previous.overlap.toFixed(6)}:offset=${offset.toFixed(6)}[${output}]`,
      );
      running = running + plans[index].renderDuration - previous.overlap;
    } else {
      // A hard cut inside an otherwise dissolved scene still has to go through
      // the graph, so it is expressed as a zero-length concat of the two legs.
      steps.push(`[${label}][${index}:v]concat=n=2:v=1:a=0[${output}]`);
      running += plans[index].renderDuration;
    }
    label = output;
  }

  return { filter: steps.join(';'), outputLabel: label, totalSeconds: running };
}

export class EpisodeRenderService {
  constructor({ bridge, projectRoot, artifactRoot, cacheRoot }) {
    this.bridge = bridge;
    this.projectRoot = resolve(projectRoot);
    this.artifactRoot = resolve(artifactRoot);
    this.cacheRoot = resolve(cacheRoot);
    this.jobs = new Map();
    this.pending = [];
    this.activeJobId = null;
  }

  async status(episodeId) {
    const snapshot = await this.bridge.snapshot();
    return compileEpisodeComposition(snapshot, episodeId);
  }

  async startEpisode(episodeId) {
    if (typeof episodeId !== 'string' || !episodeId || episodeId.length > 180) throw renderError('invalid_argument', 'episodeId is required');
    if (this.pending.length >= MAX_PENDING_RENDERS) throw renderError('busy', 'episode render queue is full');
    const manifest = await this.status(episodeId);
    if (!manifest.ready) {
      throw renderError('invalid_argument', `episode is not render-ready: ${manifest.issues.slice(0, 5).join(' | ')}`);
    }
    const job = {
      id: randomUUID(),
      episodeId,
      episodeTitle: manifest.episode.title,
      status: 'queued',
      progress: 0,
      sceneCount: manifest.scenes.length,
      completedScenes: 0,
      cachedScenes: 0,
      currentSceneId: null,
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
    const bounded = Number.isInteger(limit) ? Math.max(1, Math.min(50, limit)) : 20;
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, bounded).map(publicJob);
  }

  get(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw renderError('not_found', 'episode render job was not found');
    return publicJob(job);
  }

  artifact(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw renderError('not_found', 'episode render job was not found');
    if (!job.artifact) throw renderError('not_found', 'episode render artifact is not ready');
    return job.artifact;
  }

  #prune() {
    if (this.jobs.size <= MAX_RETAINED_RENDERS) return;
    const completed = [...this.jobs.values()]
      .filter((job) => job.id !== this.activeJobId && job.status !== 'queued' && job.status !== 'running')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    while (this.jobs.size > MAX_RETAINED_RENDERS && completed.length) this.jobs.delete(completed.shift().id);
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
      await this.#render(job);
      job.status = 'completed';
      job.progress = 100;
      job.completedAt = new Date().toISOString();
    } catch (error) {
      job.status = 'failed';
      job.error = (error instanceof Error ? error.message : String(error)).slice(0, 3000);
      job.completedAt = new Date().toISOString();
    } finally {
      job.currentSceneId = null;
      this.activeJobId = null;
      this.#prune();
      void this.#pump();
    }
  }

  async #render(job) {
    const runtime = await ensureFfmpegRuntime();
    const ffmpeg = runtime.ffmpeg;
    const snapshot = await this.bridge.snapshot();
    const manifest = compileEpisodeComposition(snapshot, job.episodeId);
    if (!manifest.ready) throw new Error(`episode changed after queueing and is no longer render-ready: ${manifest.issues.slice(0, 5).join(' | ')}`);

    const jobDirectory = join(this.artifactRoot, safeFilePart(job.episodeId), safeFilePart(job.id));
    const workDirectory = join(jobDirectory, 'work');
    const sceneCacheDirectory = join(this.cacheRoot, 'scenes');
    await mkdir(workDirectory, { recursive: true });
    await mkdir(sceneCacheDirectory, { recursive: true });

    const sceneMasters = [];
    for (let index = 0; index < manifest.scenes.length; index += 1) {
      const scene = manifest.scenes[index];
      job.currentSceneId = scene.id;
      job.progress = Math.floor((index / Math.max(1, manifest.scenes.length)) * 90);
      const cacheKey = sceneCacheKey(manifest, scene);
      const cached = join(sceneCacheDirectory, `${cacheKey}.mp4`);
      if (await exists(cached)) {
        job.cachedScenes += 1;
        job.completedScenes = index + 1;
        sceneMasters.push(cached);
        continue;
      }
      const sceneWork = join(workDirectory, `${String(index + 1).padStart(3, '0')}-${safeFilePart(scene.id)}`);
      await mkdir(sceneWork, { recursive: true });
      await this.#renderScene(ffmpeg, manifest, scene, sceneWork, cached);
      sceneMasters.push(cached);
      job.completedScenes = index + 1;
    }

    const concatPath = join(workDirectory, 'episode-scenes.ffconcat');
    await writeFile(concatPath, ['ffconcat version 1.0', ...sceneMasters.map((path) => concatLine(path))].join('\n'), 'utf8');
    const outputPath = join(jobDirectory, `${safeFilePart(job.episodeId)}-preview.mp4`);
    await runProcess(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', concatPath,
      '-map', '0:v:0', '-map', '0:a:0',
      '-c', 'copy', '-movflags', '+faststart',
      outputPath,
    ]);
    job.progress = 96;

    const bytes = await readFile(outputPath);
    const sha256 = sha256Bytes(bytes);
    const relativePath = relative(resolve(this.projectRoot, '.makewatch'), outputPath).replaceAll('\\', '/');
    const generationNodeId = `generation.episode-preview.${safeFilePart(job.episodeId)}`;
    const assetNodeId = `asset.${sha256.slice(0, 24)}`;
    job.artifact = {
      generationNodeId,
      assetNodeId,
      filename: basename(outputPath),
      relativePath,
      absolutePath: outputPath,
      contentType: 'video/mp4',
      sha256,
      durationSeconds: manifest.episode.durationSeconds,
      width: manifest.profile.width,
      height: manifest.profile.height,
      fps: manifest.profile.fps,
      renderer: 'ffmpeg-scene-cache-v1',
      cachedScenes: job.cachedScenes,
    };
    await this.#registerEpisodeArtifact(generationNodeId, assetNodeId, job, manifest);
    await rm(workDirectory, { recursive: true, force: true }).catch(() => undefined);
  }

  async #renderScene(ffmpeg, manifest, scene, workDirectory, outputPath) {
    // Authored transitions decide how the shots are joined. When every join is
    // a hard cut the segments are stream-copied together, which is both faster
    // and lossless; a scene that actually dissolves has to be re-encoded.
    const transitions = planSceneTransitions(scene.shots, manifest.profile.fps);

    const shotSegments = [];
    for (let index = 0; index < scene.shots.length; index += 1) {
      const shot = scene.shots[index];
      if (!shot.media) throw new Error(`Shot ${shot.id} has no media`);
      const input = projectAssetPath(this.projectRoot, shot.media);
      if (!await exists(input)) throw new Error(`Shot media file is missing: ${shot.media.relativePath}`);
      const segment = join(workDirectory, `shot-${String(index + 1).padStart(4, '0')}.mp4`);
      const renderSeconds = transitions ? transitions[index].renderDuration : Number(shot.durationSeconds);
      await this.#renderShotSegment(ffmpeg, manifest, shot, input, segment, renderSeconds);
      shotSegments.push(segment);
    }

    const visual = join(workDirectory, 'visual.mp4');
    if (transitions) {
      const graph = buildTransitionGraph(transitions);
      await runProcess(ffmpeg, [
        '-y', '-hide_banner', '-loglevel', 'error',
        ...shotSegments.flatMap((path) => ['-i', path]),
        '-filter_complex', graph.filter,
        '-map', `[${graph.outputLabel}]`,
        '-an', '-c:v', 'libx264', '-preset', VIDEO_PRESET, '-crf', VIDEO_CRF,
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', visual,
      ]);
    } else {
      const shotList = join(workDirectory, 'shots.ffconcat');
      await writeFile(shotList, ['ffconcat version 1.0', ...shotSegments.map((path) => concatLine(path))].join('\n'), 'utf8');
      await runProcess(ffmpeg, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'concat', '-safe', '0', '-i', shotList,
        '-c', 'copy', visual,
      ]);
    }

    const audio = join(workDirectory, 'audio.m4a');
    await this.#renderSceneAudio(ffmpeg, scene, audio);
    const temporaryOutput = `${outputPath}.partial.mp4`;
    await mkdir(dirname(outputPath), { recursive: true });
    await runProcess(ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-i', visual, '-i', audio,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c:v', 'copy', '-c:a', 'copy',
      '-movflags', '+faststart', temporaryOutput,
    ]);
    await copyFile(temporaryOutput, outputPath);
    await rm(temporaryOutput, { force: true });
  }

  async #renderShotSegment(ffmpeg, manifest, shot, input, output, renderSeconds) {
    const duration = Math.max(0.04, Number(renderSeconds ?? shot.durationSeconds));
    const fps = String(manifest.profile.fps);
    const threads = String(Math.max(2, Math.min(8, Math.ceil(cpus().length / 2))));
    const base = ['-y', '-hide_banner', '-loglevel', 'error'];
    const visual = `${scaleFilter(manifest.profile)},fps=${fps},format=yuv420p`;
    if (shot.media.mediaType === 'image') {
      // The Shot's authored camera move is rendered here rather than discarded.
      // A locked-off shot keeps the cheaper static path.
      const move = buildCameraMotionFilter({
        camera: shot.camera,
        motionLevel: shot.motionLevel,
        durationSeconds: duration,
        fps: manifest.profile.fps,
        width: manifest.profile.width,
        height: manifest.profile.height,
      });
      await runProcess(ffmpeg, [
        ...base,
        '-loop', '1', '-framerate', fps, '-i', input,
        '-t', duration.toFixed(6),
        '-vf', move ? move.filter : visual,
        '-an', '-c:v', 'libx264', '-preset', VIDEO_PRESET, '-crf', VIDEO_CRF,
        '-threads', threads, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
      ]);
      return;
    }
    if (shot.media.mediaType === 'video') {
      const padded = `${scaleFilter(manifest.profile)},fps=${fps},tpad=stop_mode=clone:stop_duration=${duration.toFixed(6)},trim=duration=${duration.toFixed(6)},setpts=PTS-STARTPTS,format=yuv420p`;
      await runProcess(ffmpeg, [
        ...base, '-i', input,
        '-t', duration.toFixed(6), '-vf', padded,
        '-an', '-c:v', 'libx264', '-preset', VIDEO_PRESET, '-crf', VIDEO_CRF,
        '-threads', threads, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output,
      ]);
      return;
    }
    throw new Error(`unsupported Shot media type: ${shot.media.mediaType}`);
  }

  async #renderSceneAudio(ffmpeg, scene, output) {
    const duration = Math.max(0.04, Number(scene.durationSeconds));
    const cues = scene.audio.filter((cue) => cue.media?.mediaType === 'audio');
    if (cues.length === 0) {
      await runProcess(ffmpeg, [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-t', duration.toFixed(6), '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', output,
      ]);
      return;
    }

    const args = ['-y', '-hide_banner', '-loglevel', 'error'];
    for (const cue of cues) {
      const path = projectAssetPath(this.projectRoot, cue.media);
      if (!await exists(path)) throw new Error(`Audio media file is missing: ${cue.media.relativePath}`);
      args.push('-i', path);
    }
    const filters = cues.map((cue, index) => {
      const localSeconds = Math.max(0, Number(cue.startSeconds) - Number(scene.startSeconds));
      const delayMs = Math.max(0, Math.round(localSeconds * 1000));
      const gain = Number.isFinite(Number(cue.volumeDb)) ? Number(cue.volumeDb) : 0;
      return `[${index}:a]aresample=48000,asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1,volume=${gain}dB[a${index}]`;
    });
    filters.push(`${cues.map((_, index) => `[a${index}]`).join('')}amix=inputs=${cues.length}:duration=longest:normalize=0,apad=pad_dur=${duration.toFixed(6)},atrim=duration=${duration.toFixed(6)},loudnorm=I=-16:TP=-1.5:LRA=11[aout]`);
    args.push(
      '-filter_complex', filters.join(';'),
      '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
      output,
    );
    await runProcess(ffmpeg, args);
  }

  async #registerEpisodeArtifact(generationNodeId, assetNodeId, job, manifest) {
    let snapshot = await this.bridge.snapshot();
    const generation = snapshot.nodes.find((node) => node.id === generationNodeId) ?? null;
    const metadata = {
      targetKind: 'episode',
      targetId: job.episodeId,
      mediaType: 'video',
      provider: 'ffmpeg',
      model: 'ffmpeg-managed',
      strategy: 'SCENE_CACHED_PREVIEW_ASSEMBLY',
      status: 'ready',
      artifactPath: job.artifact.relativePath,
      artifactSha256: job.artifact.sha256,
      startedAt: job.startedAt ?? '',
      completedAt: new Date().toISOString(),
      renderer: job.artifact.renderer,
      cachedScenes: String(job.cachedScenes),
      projectRevision: String(manifest.projectRevision),
    };
    const generationCommands = [];
    if (!generation) {
      generationCommands.push({
        type: 'node.create',
        node: {
          id: generationNodeId,
          kind: 'generation',
          title: `${job.episodeTitle} · Preview Master`,
          metadata,
          approval: 'draft', locked: false, stale: false,
        },
      });
      generationCommands.push({ type: 'dependency.add', dependent: generationNodeId, dependency: job.episodeId });
      generationCommands.push({ type: 'node.markFresh', id: generationNodeId });
    } else {
      if (generation.kind !== 'generation' || generation.locked) throw new Error(`episode generation node cannot be updated: ${generationNodeId}`);
      generationCommands.push({ type: 'node.patch', id: generation.id, expectedRevision: generation.revision, metadataUpdates: metadata });
      if (!snapshot.dependencies.some((edge) => edge.dependent === generation.id && edge.dependency === job.episodeId)) {
        generationCommands.push({ type: 'dependency.add', dependent: generation.id, dependency: job.episodeId });
      }
      generationCommands.push({ type: 'node.markFresh', id: generation.id });
    }
    await this.bridge.apply(generationCommands, {
      actor: 'system', source: 'episode-render', reason: `register preview master generation for ${job.episodeId}`,
    }, snapshot.projectRevision);

    snapshot = await this.bridge.snapshot();
    const asset = snapshot.nodes.find((node) => node.id === assetNodeId) ?? null;
    if (!asset) {
      await this.bridge.apply([
        {
          type: 'node.create',
          node: {
            id: assetNodeId,
            kind: 'asset',
            title: `${job.episodeTitle} · Preview MP4`,
            approval: 'draft', locked: false, stale: false,
            metadata: {
              mediaType: 'video', role: 'episode-preview-master', relativePath: job.artifact.relativePath,
              sha256: job.artifact.sha256, mimeType: 'video/mp4', durationSeconds: String(job.artifact.durationSeconds),
              width: String(job.artifact.width), height: String(job.artifact.height), fps: String(job.artifact.fps),
              source: 'generated', generatedBy: generationNodeId, renderer: job.artifact.renderer,
            },
          },
        },
        { type: 'dependency.add', dependent: assetNodeId, dependency: generationNodeId },
        { type: 'node.markFresh', id: assetNodeId },
      ], {
        actor: 'system', source: 'episode-render', reason: `register preview MP4 asset for ${job.episodeId}`,
      }, snapshot.projectRevision);
    }
  }
}
