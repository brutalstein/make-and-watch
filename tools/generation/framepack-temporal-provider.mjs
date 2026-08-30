import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { ensureFfmpegRuntime } from '../runtime/ffmpeg-runtime-manager.mjs';
import { framePackRuntimeStatus } from '../runtime/framepack-runtime-manager.mjs';
import { releaseComfyGpu } from '../runtime/media-memory-coordinator.mjs';

const RESULT_PREFIX = 'MW_TEMPORAL_RESULT_V1\t';
const MAX_FRAMEPACK_SHOT_SECONDS = 8;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const WORKER_TIMEOUT_MS = 90 * 60 * 1000;

function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safePart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'shot';
}

function projectMediaPath(projectRoot, relativePath) {
  const makewatchRoot = resolve(projectRoot, '.makewatch');
  const candidate = resolve(makewatchRoot, String(relativePath ?? ''));
  const rel = relative(makewatchRoot, candidate);
  if (!relativePath || rel.startsWith('..') || rel.includes('\0')) {
    throw providerError('invalid_argument', 'temporal input Asset path escapes the project media root');
  }
  return candidate;
}

function deterministicSeed(request) {
  const explicit = Number(request?.shot?.seed);
  if (Number.isSafeInteger(explicit) && explicit >= 0 && explicit <= 0xffff_ffff) return explicit;
  return createHash('sha256')
    .update([
      request?.shot?.id ?? '',
      request?.shot?.revision ?? '',
      request?.shot?.temporalPrompt ?? '',
      request?.inputs?.startFrame?.sha256 ?? '',
    ].join('|'))
    .digest()
    .readUInt32BE(0);
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('end', resolvePromise);
    stream.once('error', reject);
  });
  return hash.digest('hex');
}

function terminateTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch {
    try { child.kill('SIGKILL'); } catch { /* process is already gone */ }
  }
}

function parseWorkerResult(stdout) {
  const lines = String(stdout ?? '').split(/\r?\n/).reverse();
  const line = lines.find((candidate) => candidate.startsWith(RESULT_PREFIX));
  if (!line) return null;
  try { return JSON.parse(line.slice(RESULT_PREFIX.length)); } catch { return null; }
}

function runWorkerProcess(python, workerPath, requestPath, { cwd, timeoutMs = WORKER_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, [workerPath, '--request', requestPath], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        HF_HUB_OFFLINE: '1',
        TRANSFORMERS_OFFLINE: '1',
        HF_HUB_DISABLE_TELEMETRY: '1',
      },
    });
    let stdout = '';
    let stderr = '';
    const appendBounded = (current, chunk) => `${current}${chunk.toString('utf8')}`.slice(-MAX_LOG_BYTES);
    child.stdout?.on('data', (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = appendBounded(stderr, chunk); });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateTree(child);
      reject(providerError('timeout', `FramePack worker exceeded ${Math.round(timeoutMs / 60_000)} minute bounded runtime`));
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
      const payload = parseWorkerResult(stdout);
      if (code === 0 && payload?.ok === true) {
        resolvePromise({ payload: payload.result, stdout, stderr });
        return;
      }
      const detail = payload?.error?.message || stderr.slice(-3000) || stdout.slice(-3000) || `exit code ${code ?? 'unknown'}`;
      reject(providerError(payload?.error?.code ?? 'provider_error', `FramePack worker failed: ${detail}`));
    });
  });
}

function parseFraction(value) {
  const text = String(value ?? '').trim();
  const [a, b] = text.split('/').map(Number);
  if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) return a / b;
  const number = Number(text);
  return Number.isFinite(number) ? number : 0;
}

async function probeVideo(path, ffmpegResolver = ensureFfmpegRuntime) {
  const runtime = await ffmpegResolver();
  if (!runtime.ffprobe) throw providerError('runtime_missing', 'ffprobe is required to validate temporal video output');
  const result = spawnSync(runtime.ffprobe, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,avg_frame_rate:format=duration',
    '-of', 'json',
    path,
  ], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  if (result.status !== 0) throw providerError('provider_error', `ffprobe rejected FramePack output: ${String(result.stderr ?? '').slice(-1200)}`);
  let payload;
  try { payload = JSON.parse(result.stdout); } catch { throw providerError('provider_error', 'ffprobe returned invalid metadata for FramePack output'); }
  const stream = payload?.streams?.[0] ?? {};
  const durationSeconds = Number(payload?.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw providerError('provider_error', 'FramePack output has no positive duration');
  return {
    durationSeconds,
    width: Math.max(0, Number(stream.width) || 0),
    height: Math.max(0, Number(stream.height) || 0),
    fps: Math.max(0, parseFraction(stream.avg_frame_rate)),
  };
}

export class FramePackTemporalProvider {
  constructor({
    projectRoot,
    workerPath,
    runtimeResolver = framePackRuntimeStatus,
    workerRunner = runWorkerProcess,
    videoProbe = probeVideo,
    gpuReleaser = releaseComfyGpu,
    comfyBaseUrl = process.env.MAKEWATCH_COMFYUI_URL ?? 'http://127.0.0.1:8188',
  }) {
    this.id = 'framepack';
    this.displayName = 'FramePack I2V';
    this.strategies = ['I2V'];
    this.projectRoot = resolve(projectRoot);
    this.workerPath = resolve(workerPath);
    this.runtimeResolver = runtimeResolver;
    this.workerRunner = workerRunner;
    this.videoProbe = videoProbe;
    this.gpuReleaser = gpuReleaser;
    this.comfyBaseUrl = comfyBaseUrl;
  }

  async status(context = {}) {
    const runtime = await this.runtimeResolver(context.hardware ?? {});
    const selected = runtime.selected;
    const ready = Boolean(
      runtime.installed
      && runtime.modelsReady
      && runtime.hardware?.readyForAttempt
      && selected?.sourceEntry
      && selected?.python,
    );
    return {
      installed: Boolean(runtime.installed),
      ready,
      busy: false,
      detail: ready
        ? 'Official FramePack checkout, required local model cache and dedicated Python runtime are ready for bounded offline I2V.'
        : runtime.installed && !runtime.modelsReady
          ? runtime.detail || 'FramePack model cache is incomplete; explicit setup is required.'
          : runtime.installed && !selected?.python
            ? 'FramePack was found, but its dedicated/embedded Python runtime was not discovered. Global Python is intentionally not used.'
            : runtime.detail,
      runtime: selected ? {
        kind: selected.kind,
        root: selected.root,
        dedicatedPython: Boolean(selected.python),
        modelsReady: Boolean(runtime.modelsReady),
        automaticBootstrap: false,
      } : null,
      hardware: runtime.hardware,
    };
  }

  async generate(request, context = {}) {
    if (request?.shot?.strategy !== 'I2V') throw providerError('invalid_argument', 'FramePack v1 provider supports I2V only');
    const duration = Number(request.shot.durationSeconds);
    if (!Number.isFinite(duration) || duration < 1 || duration > MAX_FRAMEPACK_SHOT_SECONDS) {
      throw providerError('invalid_argument', `FramePack v1 accepts 1..${MAX_FRAMEPACK_SHOT_SECONDS}s Shots; split longer editorial takes into multiple Shots`);
    }
    const startFrame = request.inputs?.startFrame;
    if (!startFrame?.relativePath) throw providerError('not_ready', 'FramePack I2V requires a ready start/hero frame Asset');

    const runtime = await this.runtimeResolver(context.hardware ?? {});
    const selected = runtime.selected;
    if (!runtime.installed || !runtime.modelsReady || !runtime.hardware?.readyForAttempt || !selected?.sourceEntry || !selected?.python) {
      throw providerError('not_ready', (await this.status(context)).detail || 'FramePack runtime is not ready for offline execution');
    }

    const inputImage = projectMediaPath(this.projectRoot, startFrame.relativePath);
    try {
      if (!(await stat(inputImage)).isFile()) throw new Error('not a file');
    } catch {
      throw providerError('not_ready', `FramePack start frame is missing: ${startFrame.relativePath}`);
    }

    const jobId = randomUUID();
    const jobRoot = resolve(this.projectRoot, '.makewatch', 'runtime-requests', 'framepack', jobId);
    const outputDir = resolve(this.projectRoot, '.makewatch', 'artifacts', 'video', safePart(request.shot.id));
    const outputPath = resolve(outputDir, `${jobId}.mp4`);
    const requestPath = resolve(jobRoot, 'request.json');
    await mkdir(jobRoot, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    const temporalPrompt = String(request.shot.temporalPrompt || request.shot.subjectAction || '').trim();
    if (!temporalPrompt) throw providerError('invalid_argument', 'FramePack I2V requires temporalPrompt or subjectAction');
    const workerRequest = {
      framepackRoot: selected.root,
      inputImage,
      outputFile: outputPath,
      prompt: temporalPrompt.slice(0, 12_000),
      negativePrompt: String(request.shot.negativePrompt ?? '').slice(0, 12_000),
      durationSeconds: duration,
      seed: deterministicSeed(request),
      qualityTier: request.shot.qualityTier ?? 'preview',
    };
    await writeFile(requestPath, JSON.stringify(workerRequest), 'utf8');

    let memoryRelease = null;
    try {
      memoryRelease = await this.gpuReleaser({ baseUrl: this.comfyBaseUrl });
      if (memoryRelease?.requested && !memoryRelease?.released) {
        throw providerError('not_ready', `ComfyUI is reachable but could not release resident GPU models: ${memoryRelease.detail}`);
      }
      const worker = await this.workerRunner(selected.python, this.workerPath, requestPath, { cwd: selected.root });
      const info = await stat(outputPath);
      if (!info.isFile() || info.size <= 1024) throw providerError('provider_error', 'FramePack output file is missing or empty');
      const [sha256, media] = await Promise.all([
        sha256File(outputPath),
        this.videoProbe(outputPath),
      ]);
      const makewatchRoot = resolve(this.projectRoot, '.makewatch');
      const relativePath = relative(makewatchRoot, outputPath).replaceAll('\\', '/');
      return {
        mediaType: 'video',
        relativePath,
        sha256,
        mimeType: 'video/mp4',
        durationSeconds: media.durationSeconds,
        width: media.width,
        height: media.height,
        fps: media.fps,
        providerMetadata: {
          runtimeKind: selected.kind,
          qualityTier: workerRequest.qualityTier,
          teacache: worker?.payload?.teacache ?? null,
          steps: worker?.payload?.steps ?? null,
          requestedDurationSeconds: duration,
          comfyMemoryReleased: memoryRelease?.released === true,
          offlineModelExecution: true,
        },
      };
    } catch (error) {
      await rm(outputPath, { force: true }).catch(() => undefined);
      throw error;
    } finally {
      await rm(jobRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export const framePackTemporalProviderLimits = Object.freeze({
  maxShotSeconds: MAX_FRAMEPACK_SHOT_SECONDS,
  workerTimeoutMs: WORKER_TIMEOUT_MS,
  maxLogBytes: MAX_LOG_BYTES,
});
