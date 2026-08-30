import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

import { ensureFfmpegRuntime } from '../runtime/ffmpeg-runtime-manager.mjs';
import { nativeAnimeContract, validateShotAnim } from './native-anime-contract.mjs';

const RESULT_PREFIX = nativeAnimeContract.resultPrefix;
const MAX_SHOT_SECONDS = nativeAnimeContract.maxShotSeconds;
const MAX_LOG_BYTES = 1 * 1024 * 1024;
const WORKER_TIMEOUT_MS = 20 * 60 * 1000;
const PYTHON_CANDIDATES = ['python', 'python3', 'py'];

function providerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safePart(value) {
  return String(value ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 100) || 'shot';
}

// Clamp any provider-supplied media path to the project's .makewatch root.
function projectMediaPath(projectRoot, relativePath) {
  const makewatchRoot = resolve(projectRoot, '.makewatch');
  const candidate = resolve(makewatchRoot, String(relativePath ?? ''));
  const rel = relative(makewatchRoot, candidate);
  if (!relativePath || rel.startsWith('..') || rel.includes('\0')) {
    throw providerError('invalid_argument', 'native-anime input path escapes the project media root');
  }
  return candidate;
}

function deterministicSeed(shotId, shotAnim) {
  return createHash('sha256')
    .update(JSON.stringify({ shotId, shotAnim }))
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
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
}

function parseWorkerResult(stdout) {
  const line = String(stdout ?? '').split(/\r?\n/).reverse().find((candidate) => candidate.startsWith(RESULT_PREFIX));
  if (!line) return null;
  try { return JSON.parse(line.slice(RESULT_PREFIX.length)); } catch { return null; }
}

// ponytail: same generic subprocess plumbing FramePack's provider uses; one consumer,
// so inlined rather than extracted to a shared module.
function runWorkerProcess(python, workerPath, requestPath, { cwd, prefixArgs = [], timeoutMs = WORKER_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, [...prefixArgs, workerPath, '--request', requestPath], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
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
      reject(providerError('timeout', `native-anime worker exceeded ${Math.round(timeoutMs / 60_000)} minute bounded runtime`));
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
      const detail = payload?.error?.message || stderr.slice(-2400) || stdout.slice(-2400) || `exit code ${code ?? 'unknown'}`;
      reject(providerError(payload?.error?.code ?? 'provider_error', `native-anime worker failed: ${detail}`));
    });
  });
}

function resolvePythonRuntime() {
  const probe = 'import numpy,PIL,cv2,wave,json;print(numpy.__version__+"|"+PIL.__version__+"|"+cv2.__version__)';
  const candidates = process.env.MAKEWATCH_ANIME_PYTHON
    ? [process.env.MAKEWATCH_ANIME_PYTHON, ...PYTHON_CANDIDATES]
    : PYTHON_CANDIDATES;
  for (const candidate of candidates) {
    const args = candidate === 'py' ? ['-3', '-c', probe] : ['-c', probe];
    const result = spawnSync(candidate, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    if (result.status === 0 && typeof result.stdout === 'string' && result.stdout.includes('|')) {
      const [numpy, pillow, opencv] = result.stdout.trim().split('|');
      return { python: candidate === 'py' ? 'py -3' : candidate, launcher: candidate, prefixArgs: candidate === 'py' ? ['-3'] : [], numpy, pillow, opencv };
    }
  }
  return null;
}

function parseFraction(value) {
  const [a, b] = String(value ?? '').trim().split('/').map(Number);
  if (Number.isFinite(a) && Number.isFinite(b) && b !== 0) return a / b;
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

async function probeVideo(path, ffmpegResolver) {
  const runtime = await ffmpegResolver();
  if (!runtime.ffprobe) throw providerError('runtime_missing', 'ffprobe is required to validate native-anime output');
  const result = spawnSync(runtime.ffprobe, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,width,height,avg_frame_rate:format=duration',
    '-of', 'json', path,
  ], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  if (result.status !== 0) throw providerError('provider_error', `ffprobe rejected native-anime output: ${String(result.stderr ?? '').slice(-1200)}`);
  let payload;
  try { payload = JSON.parse(result.stdout); } catch { throw providerError('provider_error', 'ffprobe returned invalid metadata'); }
  const streams = Array.isArray(payload?.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video') ?? {};
  const durationSeconds = Number(payload?.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw providerError('provider_error', 'native-anime output has no positive duration');
  return {
    durationSeconds,
    width: Math.max(0, Number(video.width) || 0),
    height: Math.max(0, Number(video.height) || 0),
    fps: Math.max(0, parseFraction(video.avg_frame_rate)),
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
  };
}

/**
 * `native-anime` — the deterministic 2D-animation temporal provider. Same registry
 * contract as FramePack; CPU-first, no resident video model, streams frames to the
 * encoder and persists none. Design: project_brain/NATIVE_ANIME_MOTION_ENGINE.md.
 */
export class NativeAnimeTemporalProvider {
  constructor({
    projectRoot,
    workerPath,
    pythonResolver = resolvePythonRuntime,
    ffmpegResolver = ensureFfmpegRuntime,
    workerRunner = runWorkerProcess,
    videoProbe = probeVideo,
    acceptsProductionRequests = false,
  }) {
    this.id = nativeAnimeContract.providerId;
    this.displayName = nativeAnimeContract.displayName;
    this.strategies = [...nativeAnimeContract.strategies];
    this.projectRoot = resolve(projectRoot);
    this.workerPath = resolve(workerPath);
    this.pythonResolver = pythonResolver;
    this.ffmpegResolver = ffmpegResolver;
    this.workerRunner = workerRunner;
    this.videoProbe = videoProbe;
    this.acceptsProductionRequests = acceptsProductionRequests;
  }

  async status() {
    const python = await this.pythonResolver();
    let ffmpeg = null;
    try { ffmpeg = await this.ffmpegResolver(); } catch { ffmpeg = null; }
    const rendererReady = Boolean(python && ffmpeg?.ffmpeg && ffmpeg?.ffprobe);
    const ready = rendererReady && this.acceptsProductionRequests;
    return {
      installed: Boolean(python),
      ready,
      busy: false,
      detail: ready
        ? 'Deterministic 2D anime renderer and authored ShotAnim production path are ready.'
        : !python
          ? 'A Python 3 with numpy, Pillow and OpenCV was not found. Set MAKEWATCH_ANIME_PYTHON to a suitable interpreter.'
          : !rendererReady
            ? 'FFmpeg/ffprobe runtime is not ready for native-anime encode/validate.'
            : 'Renderer dependencies are ready, but the native project graph -> ShotAnim compiler is not wired; production requests fail closed.',
      runtime: python ? {
        kind: 'deterministic-2d',
        python: python.python,
        numpy: python.numpy,
        pillow: python.pillow,
        opencv: python.opencv,
        ffmpeg: ffmpeg?.ffmpeg ?? null,
        residentVideoModel: false,
        automaticBootstrap: false,
        rendererReady,
        shotAnimCompilerReady: this.acceptsProductionRequests,
      } : null,
      hardware: null,
    };
  }

  async generate(request, _context = {}) {
    if (request?.shot?.strategy !== 'I2V') throw providerError('invalid_argument', 'native-anime provider supports I2V only');
    const durationSeconds = Number(request.shot.durationSeconds);
    if (!Number.isFinite(durationSeconds) || durationSeconds < 1 || durationSeconds > MAX_SHOT_SECONDS) {
      throw providerError('invalid_argument', `native-anime accepts 1..${MAX_SHOT_SECONDS}s Shots`);
    }

    const python = await this.pythonResolver();
    if (!python) throw providerError('not_ready', (await this.status()).detail);
    const ffmpeg = await this.ffmpegResolver();
    if (!ffmpeg?.ffmpeg || !ffmpeg?.ffprobe) throw providerError('not_ready', 'FFmpeg/ffprobe runtime is not ready');

    if (!request.shotAnim) {
      throw providerError(
        'not_ready',
        'native-anime requires an authored ShotAnim; the project graph -> ShotAnim compiler is not wired and animated-still fallback is forbidden',
      );
    }
    const shotAnim = validateShotAnim(request.shotAnim);

    // Every layer / audio / alignment path must resolve inside the media root and exist.
    const referencedPaths = [
      ...shotAnim.layers.map((layer) => layer.path),
      ...shotAnim.dialogue.flatMap((unit) => [unit.audioPath, unit.alignmentPath].filter(Boolean)),
    ];
    for (const relativePath of referencedPaths) {
      const absolute = projectMediaPath(this.projectRoot, relativePath);
      try {
        if (!(await stat(absolute)).isFile()) throw new Error('not a file');
      } catch {
        throw providerError('not_ready', `native-anime input asset is missing: ${relativePath}`);
      }
    }

    const jobId = randomUUID();
    const jobRoot = resolve(this.projectRoot, '.makewatch', 'runtime-requests', 'native-anime', jobId);
    const outputDir = resolve(this.projectRoot, '.makewatch', 'artifacts', 'video', safePart(shotAnim.shotId));
    const outputPath = resolve(outputDir, `${jobId}.mp4`);
    const requestPath = resolve(jobRoot, 'request.json');
    await mkdir(jobRoot, { recursive: true });
    await mkdir(outputDir, { recursive: true });

    const workerRequest = {
      shotAnim,
      projectMediaRoot: resolve(this.projectRoot, '.makewatch'),
      outputFile: outputPath,
      ffmpeg: ffmpeg.ffmpeg,
      ffprobe: ffmpeg.ffprobe,
      seed: deterministicSeed(shotAnim.shotId, shotAnim),
    };
    await writeFile(requestPath, JSON.stringify(workerRequest), 'utf8');

    const startedAt = Date.now();
    try {
      const worker = await this.workerRunner(python.launcher, this.workerPath, requestPath, {
        cwd: this.projectRoot,
        prefixArgs: python.prefixArgs ?? [],
      });
      const info = await stat(outputPath);
      if (!info.isFile() || info.size <= 1024) throw providerError('provider_error', 'native-anime output file is missing or empty');
      const [sha256, media] = await Promise.all([
        sha256File(outputPath),
        this.videoProbe(outputPath, this.ffmpegResolver),
      ]);
      const makewatchRoot = resolve(this.projectRoot, '.makewatch');
      return {
        mediaType: 'video',
        relativePath: relative(makewatchRoot, outputPath).replaceAll('\\', '/'),
        sha256,
        mimeType: 'video/mp4',
        durationSeconds: media.durationSeconds,
        width: media.width,
        height: media.height,
        fps: media.fps,
        providerMetadata: {
          engine: 'native-anime',
          deterministic: true,
          residentVideoModel: false,
          frameCachePersisted: false,
          layerCount: shotAnim.layers.length,
          dynamicChains: shotAnim.layers.filter((layer) => layer.dynamic).length,
          correctiveRedraws: shotAnim.correctiveKeys,
          hasAudio: media.hasAudio,
          framesSha256: worker?.payload?.framesSha256 ?? null,
          renderSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
          bytesPerOutputSecond: Math.round(info.size / Math.max(1, media.durationSeconds)),
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

export const nativeAnimeProviderLimits = Object.freeze({
  maxShotSeconds: MAX_SHOT_SECONDS,
  workerTimeoutMs: WORKER_TIMEOUT_MS,
  maxLogBytes: MAX_LOG_BYTES,
});
