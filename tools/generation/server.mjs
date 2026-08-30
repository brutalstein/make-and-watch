import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

import { NativeAnimeTemporalProvider } from '../anime/native-anime-provider.mjs';
import { buildShotAnimRequest } from '../anime/shot-anim-compiler.mjs';
import { ShotAnimCompilationService } from '../anime/shot-anim-compilation-service.mjs';
import { AudioGenerationService } from '../audio/audio-generation-service.mjs';
import { compileEpisodeComposition } from '../composition/episode-composition.mjs';
import { EpisodeRenderService } from '../composition/episode-render-service.mjs';
import { DirectorReferenceLibrary, directorReferenceLimits } from '../director/reference-library.mjs';
import { localGpuTelemetry } from '../runtime/gpu-telemetry.mjs';
import { AnchorReferenceGenerationService, anchorReferenceGenerationLimits } from './anchor-reference-generation-service.mjs';
import { GenerationBridgeClient } from './bridge-client.mjs';
import { ComfyUiClient } from './comfyui-client.mjs';
import { FramePackTemporalProvider } from './framepack-temporal-provider.mjs';
import { GpuExclusiveScheduler } from './gpu-scheduler.mjs';
import { SceneGenerationService } from './scene-generation-service.mjs';
import { temporalShotContract } from './temporal-shot-contract.mjs';
import { TemporalProviderRegistry } from './temporal-provider-registry.mjs';
import { TemporalShotGenerationService } from './temporal-shot-generation-service.mjs';

const root = process.cwd();
const port = Number(process.env.MAKEWATCH_GENERATION_PORT ?? 4178);
const sceneArtifactRoot = resolve(root, process.env.MAKEWATCH_ARTIFACT_DIR ?? '.makewatch/artifacts/scenes');
const audioArtifactRoot = resolve(root, process.env.MAKEWATCH_AUDIO_ARTIFACT_DIR ?? '.makewatch/artifacts/audio');
const episodeArtifactRoot = resolve(root, process.env.MAKEWATCH_EPISODE_ARTIFACT_DIR ?? '.makewatch/artifacts/episodes');
const renderCacheRoot = resolve(root, process.env.MAKEWATCH_RENDER_CACHE_DIR ?? '.makewatch/render-cache');
const bridge = new GenerationBridgeClient();
const directorReferences = new DirectorReferenceLibrary({ projectRoot: root });
const comfy = new ComfyUiClient();
const scheduler = new GpuExclusiveScheduler();
const scheduledComfy = {
  baseUrl: comfy.baseUrl,
  capabilities: (options) => comfy.capabilities(options),
  generateStoryboardFrame: (input) => scheduler.run(
    { kind: 'visual', id: `storyboard:${input.filenamePrefix ?? 'shot'}` },
    () => comfy.generateStoryboardFrame(input),
  ),
};
const sceneService = new SceneGenerationService({ bridge, comfy: scheduledComfy, artifactRoot: sceneArtifactRoot });
const referenceService = new AnchorReferenceGenerationService({
  bridge,
  comfy,
  scheduler,
  projectRoot: root,
});
const audioService = new AudioGenerationService({
  bridge,
  scheduler,
  projectRoot: root,
  artifactRoot: audioArtifactRoot,
  workerPath: resolve(root, 'tools/audio/chatterbox-worker.py'),
  comfyBaseUrl: comfy.baseUrl.origin,
});
const renderService = new EpisodeRenderService({
  bridge,
  projectRoot: root,
  artifactRoot: episodeArtifactRoot,
  cacheRoot: renderCacheRoot,
});
// `native-anime` is the deterministic target default (no resident video model); this
// server wires its native graph -> ShotAnim compiler before enabling readiness.
// FramePack stays an optional experiment and reports not-ready unless its ~30-40 GB
// models are explicitly present.
const temporalRegistry = new TemporalProviderRegistry()
  .register(new NativeAnimeTemporalProvider({
    projectRoot: root,
    workerPath: resolve(root, 'tools/anime/native-anime-worker.py'),
    acceptsProductionRequests: true,
  }))
  .register(new FramePackTemporalProvider({
    projectRoot: root,
    workerPath: resolve(root, 'tools/generation/framepack-temporal-worker.py'),
  }));
const temporalService = new TemporalShotGenerationService({
  bridge,
  registry: temporalRegistry,
  scheduler,
  hardware: async () => localGpuTelemetry(),
  providerRequestBuilders: {
    'native-anime': async ({ snapshot, request }) => {
      const compiled = await buildShotAnimRequest(snapshot, request.shot.id, { projectRoot: root });
      return {
        request: { ...request, shotAnim: compiled.shotAnim },
        inputAssetIds: compiled.inputAssetIds,
      };
    },
  },
});
const shotAnimService = new ShotAnimCompilationService({ projectRoot: root, bridge });

async function animeProductionStatus() {
  const [providers, audio] = await Promise.all([
    temporalService.providerStatuses(),
    audioService.providerStatus(),
  ]);
  const renderer = providers.find(({ id }) => id === 'native-anime') ?? { id: 'native-anime', ready: false, installed: false };
  return {
    ready: false,
    compiler: { ready: true, schema: 'makewatch.shotAnim/1', graphBacked: true },
    renderer,
    audio,
    characterRig: { ready: false, stage: 'planned-m2' },
    environmentPackage: { ready: false, stage: 'planned-m2' },
    alignment: { ready: false, stage: 'planned-m3' },
    qc: { ready: false, stage: 'planned-m3' },
    acceptanceRunner: { ready: false, stage: 'planned-m4' },
  };
}

function mediaJobService(kind) {
  switch (kind) {
    case 'visual': return sceneService;
    case 'reference': return referenceService;
    case 'audio': return audioService;
    case 'temporal':
    case 'anime': return temporalService;
    case 'render': return renderService;
    default: throw Object.assign(new Error('media job kind is invalid'), { code: 'invalid_argument' });
  }
}

if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error(`[generation] invalid MAKEWATCH_GENERATION_PORT: ${process.env.MAKEWATCH_GENERATION_PORT ?? port}`);
  process.exit(2);
}

function allowOrigin(request, response) {
  const origin = request.headers.origin;
  if (typeof origin === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MakeWatch-Filename');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function sendJson(request, response, status, payload) {
  allowOrigin(request, response);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify({
    ok: status >= 200 && status < 300,
    result: status >= 200 && status < 300 ? payload : undefined,
    error: status >= 400 ? payload : undefined,
  }));
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 256 * 1024) throw Object.assign(new Error('request body exceeds 256 KiB'), { code: 'invalid_argument' });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Object.assign(new Error('request body must be valid JSON'), { code: 'invalid_argument' }); }
}

async function readBinary(request, maximumBytes) {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw Object.assign(new Error('reference image exceeds the upload size limit'), { code: 'resource_exhausted' });
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw Object.assign(new Error('reference image exceeds the upload size limit'), { code: 'resource_exhausted' });
    chunks.push(chunk);
  }
  if (!bytes) throw Object.assign(new Error('reference image upload is empty'), { code: 'invalid_argument' });
  return Buffer.concat(chunks);
}

function decodedFilename(request) {
  const raw = String(request.headers['x-makewatch-filename'] ?? 'reference-image');
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function boundedId(value, label) {
  if (typeof value !== 'string' || !value || value.length > 180 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw Object.assign(new Error(`${label} is invalid`), { code: 'invalid_argument' });
  }
  return value;
}

function decodedId(value, label) {
  try {
    return boundedId(decodeURIComponent(value), label);
  } catch (error) {
    if (error?.code === 'invalid_argument') throw error;
    throw Object.assign(new Error(`${label} is invalid`), { code: 'invalid_argument' });
  }
}

function optionalId(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return boundedId(value, label);
}

function boundedText(value, label, maximum) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw Object.assign(new Error(`${label} must be a string`), { code: 'invalid_argument' });
  const text = value.trim();
  if (text.length > maximum) throw Object.assign(new Error(`${label} exceeds ${maximum} characters`), { code: 'invalid_argument' });
  return text;
}

function boundedReferenceStyle(value) {
  const style = boundedText(value, 'stylePreset', 80);
  if (!style) return '';
  if (!anchorReferenceGenerationLimits.stylePresets.includes(style)) {
    throw Object.assign(new Error(`stylePreset must be one of ${anchorReferenceGenerationLimits.stylePresets.join(', ')}`), { code: 'invalid_argument' });
  }
  return style;
}

function boundedOptionalNumber(value, label, minimum, maximum) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw Object.assign(new Error(`${label} must be between ${minimum} and ${maximum}`), { code: 'invalid_argument' });
  }
  return number;
}

function boundedProviderId(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) {
    throw Object.assign(new Error('providerId is invalid'), { code: 'invalid_argument' });
  }
  return value;
}

function boundedNumber(value, fallback, minimum, maximum) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, number));
}

function errorStatus(error) {
  if (error?.code === 'not_found') return 404;
  if (error?.code === 'busy' || error?.code === 'not_ready' || error?.code === 'stale_request' || error?.code === 'conflict' || error?.code === 'integrity_error') return 409;
  if (error?.code === 'resource_exhausted') return 429;
  if (error?.code === 'invalid_argument') return 400;
  if (error?.code === 'timeout') return 504;
  return 502;
}

function streamArtifact(request, response, artifact) {
  if (!existsSync(artifact.absolutePath)) throw Object.assign(new Error('artifact file is missing'), { code: 'not_found' });
  allowOrigin(request, response);
  response.writeHead(200, {
    'Content-Type': artifact.contentType || artifact.mimeType || 'application/octet-stream',
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `inline; filename="${String(artifact.filename ?? 'artifact').replace(/["\\]/g, '_')}"`,
  });
  createReadStream(artifact.absolutePath).pipe(response);
}

async function registerDirectorReference(imported) {
  let lastConflict = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await bridge.snapshot();
    const commands = directorReferences.commandsForImport(snapshot, imported);
    if (!commands.length) return snapshot.projectRevision;
    try {
      const applied = await bridge.apply(commands, {
        actor: 'user',
        source: 'director-reference-import',
        reason: `import durable Director reference ${imported.filename}`,
      }, snapshot.projectRevision);
      return applied.projectRevision ?? snapshot.projectRevision;
    } catch (error) {
      if (error?.code !== 'revision_conflict') throw error;
      lastConflict = error;
    }
  }
  throw lastConflict ?? Object.assign(new Error('reference import could not acquire a fresh project revision'), { code: 'conflict' });
}

const server = createServer(async (request, response) => {
  if (request.method === 'OPTIONS') {
    allowOrigin(request, response);
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (request.method === 'GET' && url.pathname === '/api/health') {
      sendJson(request, response, 200, {
        service: 'makewatch-media-generation',
        modes: ['storyboard-preview', 'director-reference-library', 'anchor-reference-generation', 'temporal-i2v', 'multilingual-voice', 'episode-composition', 'episode-preview-render'],
        temporal: temporalShotContract,
        gpu: localGpuTelemetry(),
        gpuScheduler: scheduler.status(),
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/provider') {
      sendJson(request, response, 200, await sceneService.providerStatus());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/reference/provider') {
      sendJson(request, response, 200, await referenceService.providerStatus());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/audio/provider') {
      sendJson(request, response, 200, await audioService.providerStatus());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/temporal/providers') {
      sendJson(request, response, 200, { providers: await temporalService.providerStatuses() });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/anime/status') {
      sendJson(request, response, 200, await animeProductionStatus());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/jobs') {
      const limit = Number(url.searchParams.get('limit') ?? '20');
      sendJson(request, response, 200, { jobs: sceneService.list(Number.isInteger(limit) ? limit : 20) });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/reference/jobs') {
      const limit = Number(url.searchParams.get('limit') ?? '20');
      sendJson(request, response, 200, { jobs: referenceService.list(Number.isInteger(limit) ? limit : 20) });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/audio/jobs') {
      const limit = Number(url.searchParams.get('limit') ?? '20');
      sendJson(request, response, 200, { jobs: audioService.list(Number.isInteger(limit) ? limit : 20) });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/temporal/jobs') {
      const limit = Number(url.searchParams.get('limit') ?? '20');
      sendJson(request, response, 200, { jobs: temporalService.list(Number.isInteger(limit) ? limit : 20) });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/render/jobs') {
      const limit = Number(url.searchParams.get('limit') ?? '20');
      sendJson(request, response, 200, { jobs: renderService.list(Number.isInteger(limit) ? limit : 20) });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/director/references') {
      const bytes = await readBinary(request, directorReferenceLimits.maxImageBytes);
      const imported = await directorReferences.importImage({
        bytes,
        filename: decodedFilename(request),
        declaredMimeType: String(request.headers['content-type'] ?? ''),
      });
      const projectRevision = await registerDirectorReference(imported);
      sendJson(request, response, 201, {
        reference: {
          assetNodeId: imported.assetNodeId,
          filename: imported.filename,
          mimeType: imported.mimeType,
          byteSize: imported.byteSize,
          sha256: imported.sha256,
          relativePath: imported.relativePath,
        },
        projectRevision,
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/reference/generate') {
      const body = await readJson(request);
      const job = await referenceService.start({
        targetId: boundedId(body.targetId, 'targetId'),
        sourceAssetId: optionalId(body.sourceAssetId, 'sourceAssetId'),
        stylePreset: boundedReferenceStyle(body.stylePreset),
        direction: boundedText(body.direction, 'direction', 4_000),
        denoise: boundedOptionalNumber(body.denoise, 'denoise', 0.15, 0.9),
      });
      sendJson(request, response, 202, { job });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/scenes') {
      const body = await readJson(request);
      const job = await sceneService.startScene(boundedId(body.sceneId, 'sceneId'));
      sendJson(request, response, 202, { job });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/audio') {
      const body = await readJson(request);
      const job = await audioService.startAudio(boundedId(body.audioId, 'audioId'));
      sendJson(request, response, 202, { job });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/temporal/shots') {
      const body = await readJson(request);
      const job = await temporalService.startShot({
        shotId: boundedId(body.shotId, 'shotId'),
        providerId: boundedProviderId(body.providerId),
      });
      sendJson(request, response, 202, { job });
      return;
    }

    const referenceMatch = /^\/api\/director\/references\/([A-Za-z0-9._:-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && referenceMatch) {
      const snapshot = await bridge.snapshot();
      const reference = await directorReferences.resolveAsset(snapshot, boundedId(referenceMatch[1], 'assetNodeId'));
      streamArtifact(request, response, { ...reference, contentType: reference.mimeType });
      return;
    }

    const referenceJobMatch = /^\/api\/reference\/jobs\/([A-Za-z0-9-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && referenceJobMatch) {
      sendJson(request, response, 200, { job: referenceService.get(referenceJobMatch[1]) });
      return;
    }
    const referenceArtifactMatch = /^\/api\/reference\/artifacts\/([A-Za-z0-9-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && referenceArtifactMatch) {
      streamArtifact(request, response, referenceService.artifact(referenceArtifactMatch[1]));
      return;
    }

    const temporalPlanMatch = /^\/api\/temporal\/shots\/([A-Za-z0-9._:-]+)\/plan$/.exec(url.pathname);
    if (request.method === 'GET' && temporalPlanMatch) {
      const shotId = boundedId(temporalPlanMatch[1], 'shotId');
      const totalVramMb = boundedNumber(url.searchParams.get('vramMb'), undefined, 0, 196_608);
      const maxSegmentSeconds = boundedNumber(url.searchParams.get('maxSegmentSeconds'), undefined, 1, 10);
      sendJson(request, response, 200, {
        plan: await temporalService.plan(shotId, {
          ...(totalVramMb === undefined ? {} : { totalVramMb }),
          ...(maxSegmentSeconds === undefined ? {} : { maxSegmentSeconds }),
        }),
      });
      return;
    }

    const shotAnimPlanMatch = /^\/api\/anime\/shots\/([^/]+)\/plan$/.exec(url.pathname);
    if (request.method === 'GET' && shotAnimPlanMatch) {
      const shotId = decodedId(shotAnimPlanMatch[1], 'shotId');
      sendJson(request, response, 200, await shotAnimService.plan(shotId));
      return;
    }
    const shotAnimCompileMatch = /^\/api\/anime\/shots\/([^/]+)\/compile$/.exec(url.pathname);
    if (request.method === 'POST' && shotAnimCompileMatch) {
      const shotId = decodedId(shotAnimCompileMatch[1], 'shotId');
      sendJson(request, response, 201, await shotAnimService.compile(shotId));
      return;
    }

    const compositionMatch = /^\/api\/composition\/episodes\/([A-Za-z0-9._:-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && compositionMatch) {
      const episodeId = boundedId(compositionMatch[1], 'episodeId');
      const snapshot = await bridge.snapshot();
      sendJson(request, response, 200, { manifest: compileEpisodeComposition(snapshot, episodeId) });
      return;
    }
    const renderStartMatch = /^\/api\/render\/episodes\/([A-Za-z0-9._:-]+)$/.exec(url.pathname);
    if (request.method === 'POST' && renderStartMatch) {
      const episodeId = boundedId(renderStartMatch[1], 'episodeId');
      sendJson(request, response, 202, { job: await renderService.startEpisode(episodeId) });
      return;
    }

    const jobMatch = /^\/api\/jobs\/([A-Za-z0-9-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && jobMatch) {
      sendJson(request, response, 200, { job: sceneService.get(jobMatch[1]) });
      return;
    }
    const audioJobMatch = /^\/api\/audio\/jobs\/([A-Za-z0-9-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && audioJobMatch) {
      sendJson(request, response, 200, { job: audioService.get(audioJobMatch[1]) });
      return;
    }
    const temporalJobMatch = /^\/api\/temporal\/jobs\/([A-Za-z0-9-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && temporalJobMatch) {
      sendJson(request, response, 200, { job: temporalService.get(temporalJobMatch[1]) });
      return;
    }
    const renderJobMatch = /^\/api\/render\/jobs\/([A-Za-z0-9-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && renderJobMatch) {
      sendJson(request, response, 200, { job: renderService.get(renderJobMatch[1]) });
      return;
    }

    const cancelJobMatch = /^\/api\/jobs\/(visual|reference|audio|temporal|anime|render)\/([^/]+)\/cancel$/.exec(url.pathname);
    if (request.method === 'POST' && cancelJobMatch) {
      const job = await mediaJobService(cancelJobMatch[1]).cancel(decodedId(cancelJobMatch[2], 'jobId'));
      sendJson(request, response, 200, { job });
      return;
    }

    const artifactMatch = /^\/api\/artifacts\/([A-Za-z0-9-]+)\/([A-Za-z0-9._:-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && artifactMatch) {
      streamArtifact(request, response, sceneService.artifact(artifactMatch[1], artifactMatch[2]));
      return;
    }
    const audioArtifactMatch = /^\/api\/audio\/artifacts\/([A-Za-z0-9-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && audioArtifactMatch) {
      streamArtifact(request, response, audioService.artifact(audioArtifactMatch[1]));
      return;
    }
    const renderArtifactMatch = /^\/api\/render\/artifacts\/([A-Za-z0-9-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && renderArtifactMatch) {
      streamArtifact(request, response, renderService.artifact(renderArtifactMatch[1]));
      return;
    }

    sendJson(request, response, 404, { code: 'not_found', message: 'route not found' });
  } catch (error) {
    sendJson(request, response, errorStatus(error), {
      code: typeof error?.code === 'string' ? error.code : 'generation_error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

server.on('error', (error) => {
  console.error(`[generation] server error: ${error.message}`);
  process.exit(3);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[generation] media gateway ready at http://127.0.0.1:${port}`);
  console.log(`[generation] scene artifacts: ${sceneArtifactRoot}`);
  console.log(`[generation] audio artifacts: ${audioArtifactRoot}`);
  console.log(`[generation] episode artifacts: ${episodeArtifactRoot}`);
  void sceneService.providerStatus().then((status) => {
    if (status.online) console.log(`[generation] ComfyUI ready · ${status.checkpoint}`);
    else console.log(`[generation] ComfyUI offline · ${status.detail}`);
  });
  void referenceService.providerStatus().then((status) => {
    console.log(`[reference] canonical image generation ${status.ready ? `ready · ${status.checkpoint}` : status.detail}`);
  });
  void audioService.providerStatus().then((status) => {
    console.log(`[audio] Chatterbox ${status.ready ? 'ready' : status.detail}`);
  });
  void temporalService.providerStatuses().then((providers) => {
    for (const provider of providers) {
      console.log(`[temporal] ${provider.displayName} ${provider.ready ? 'ready' : provider.detail}`);
    }
  });
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  const timer = setTimeout(() => process.exit(0), 1500);
  timer.unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
