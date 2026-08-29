import { createReadStream, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

import { AudioGenerationService } from '../audio/audio-generation-service.mjs';
import { compileEpisodeComposition } from '../composition/episode-composition.mjs';
import { GenerationBridgeClient } from './bridge-client.mjs';
import { ComfyUiClient } from './comfyui-client.mjs';
import { GpuExclusiveScheduler } from './gpu-scheduler.mjs';
import { SceneGenerationService } from './scene-generation-service.mjs';

const root = process.cwd();
const port = Number(process.env.MAKEWATCH_GENERATION_PORT ?? 4178);
const sceneArtifactRoot = resolve(root, process.env.MAKEWATCH_ARTIFACT_DIR ?? '.makewatch/artifacts/scenes');
const audioArtifactRoot = resolve(root, process.env.MAKEWATCH_AUDIO_ARTIFACT_DIR ?? '.makewatch/artifacts/audio');
const bridge = new GenerationBridgeClient();
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
const audioService = new AudioGenerationService({
  bridge,
  scheduler,
  projectRoot: root,
  artifactRoot: audioArtifactRoot,
  workerPath: resolve(root, 'tools/audio/chatterbox-worker.py'),
  comfyBaseUrl: comfy.baseUrl.origin,
});

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
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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

function boundedId(value, label) {
  if (typeof value !== 'string' || !value || value.length > 180 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw Object.assign(new Error(`${label} is invalid`), { code: 'invalid_argument' });
  }
  return value;
}

function errorStatus(error) {
  if (error?.code === 'not_found') return 404;
  if (error?.code === 'busy') return 409;
  if (error?.code === 'resource_exhausted') return 429;
  if (error?.code === 'invalid_argument') return 400;
  return 502;
}

function streamArtifact(request, response, artifact) {
  if (!existsSync(artifact.absolutePath)) throw Object.assign(new Error('artifact file is missing'), { code: 'not_found' });
  allowOrigin(request, response);
  response.writeHead(200, {
    'Content-Type': artifact.contentType || 'application/octet-stream',
    'Cache-Control': 'private, no-store',
    'Content-Disposition': `inline; filename="${artifact.filename.replace(/["\\]/g, '_')}"`,
  });
  createReadStream(artifact.absolutePath).pipe(response);
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
        modes: ['storyboard-preview', 'multilingual-voice', 'episode-composition'],
        gpuScheduler: scheduler.status(),
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/provider') {
      sendJson(request, response, 200, await sceneService.providerStatus());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/audio/provider') {
      sendJson(request, response, 200, await audioService.providerStatus());
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/jobs') {
      const limit = Number(url.searchParams.get('limit') ?? '20');
      sendJson(request, response, 200, { jobs: sceneService.list(Number.isInteger(limit) ? limit : 20) });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/audio/jobs') {
      const limit = Number(url.searchParams.get('limit') ?? '20');
      sendJson(request, response, 200, { jobs: audioService.list(Number.isInteger(limit) ? limit : 20) });
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

    const compositionMatch = /^\/api\/composition\/episodes\/([A-Za-z0-9._:-]+)$/.exec(url.pathname);
    if (request.method === 'GET' && compositionMatch) {
      const episodeId = boundedId(compositionMatch[1], 'episodeId');
      const snapshot = await bridge.snapshot();
      sendJson(request, response, 200, { manifest: compileEpisodeComposition(snapshot, episodeId) });
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
  void sceneService.providerStatus().then((status) => {
    if (status.online) console.log(`[generation] ComfyUI ready · ${status.checkpoint}`);
    else console.log(`[generation] ComfyUI offline · ${status.detail}`);
  });
  void audioService.providerStatus().then((status) => {
    console.log(`[audio] Chatterbox ${status.ready ? 'ready' : status.detail}`);
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
