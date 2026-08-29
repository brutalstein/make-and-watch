import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const WINDOWS_RELEASE_URL = process.env.MAKEWATCH_FFMPEG_WINDOWS_URL
  ?? 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
const WINDOWS_RELEASE_SHA256_URL = process.env.MAKEWATCH_FFMPEG_WINDOWS_SHA256_URL
  ?? 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256';
const MAX_ARCHIVE_BYTES = 300 * 1024 * 1024;

function runtimeBase() {
  if (process.env.MAKEWATCH_RUNTIME_HOME) return resolve(process.env.MAKEWATCH_RUNTIME_HOME);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'MakeWatch', 'runtimes');
  }
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, 'makewatch', 'runtimes');
  return join(homedir(), '.local', 'share', 'makewatch', 'runtimes');
}

function truthy(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
}

async function exists(path) {
  if (!path) return false;
  try { await access(path); return true; } catch { return false; }
}

function commandPath(name) {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(command, [name], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  return String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

async function walkFor(directory, filename, maximumDepth = 5, depth = 0) {
  if (depth > maximumDepth || !await exists(directory)) return null;
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === filename.toLowerCase()) return join(directory, entry.name);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await walkFor(join(directory, entry.name), filename, maximumDepth, depth + 1);
    if (found) return found;
  }
  return null;
}

export function managedFfmpegPaths() {
  const base = join(runtimeBase(), 'ffmpeg');
  return {
    base,
    install: join(base, 'install'),
    downloads: join(base, 'downloads'),
    archive: join(base, 'downloads', 'ffmpeg-release-essentials.zip'),
  };
}

export async function discoverFfmpegRuntime() {
  if (process.env.MAKEWATCH_FFMPEG && await exists(process.env.MAKEWATCH_FFMPEG)) {
    const ffmpeg = resolve(process.env.MAKEWATCH_FFMPEG);
    const ffprobe = await walkFor(dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe', 1);
    return { ffmpeg, ffprobe, ownership: 'external', source: 'MAKEWATCH_FFMPEG' };
  }

  const pathFfmpeg = commandPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (pathFfmpeg) {
    const ffprobe = commandPath(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    return { ffmpeg: pathFfmpeg, ffprobe, ownership: 'external', source: 'PATH' };
  }

  const managed = managedFfmpegPaths();
  const managedFfmpeg = await walkFor(managed.install, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (managedFfmpeg) {
    const ffprobe = await walkFor(managed.install, process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    return { ffmpeg: managedFfmpeg, ffprobe, ownership: 'makewatch', source: 'managed' };
  }
  return null;
}

async function expectedArchiveSha256() {
  const response = await fetch(WINDOWS_RELEASE_SHA256_URL, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`FFmpeg checksum request failed with HTTP ${response.status}`);
  const text = await response.text();
  const match = text.match(/\b([a-fA-F0-9]{64})\b/);
  if (!match) throw new Error('FFmpeg checksum response did not contain a SHA-256 digest');
  return match[1].toLowerCase();
}

async function downloadVerifiedArchive(destination, expectedSha256) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.partial`;
  await rm(temporary, { force: true });
  const response = await fetch(WINDOWS_RELEASE_URL, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`FFmpeg archive request failed with HTTP ${response.status}`);
  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_ARCHIVE_BYTES) throw new Error('FFmpeg archive exceeds managed download size bound');

  const hash = createHash('sha256');
  let bytes = 0;
  let lastBucket = -1;
  const tracker = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) return callback(new Error('FFmpeg archive exceeded managed download size bound'));
      hash.update(chunk);
      if (declaredLength > 0) {
        const bucket = Math.floor((bytes / declaredLength) * 10);
        if (bucket > lastBucket) {
          lastBucket = bucket;
          console.log(`  [media] FFmpeg download ${Math.min(100, bucket * 10)}%`);
        }
      }
      callback(null, chunk);
    },
  });
  await pipeline(response.body, tracker, createWriteStream(temporary));
  const actual = hash.digest('hex');
  if (actual !== expectedSha256) {
    await rm(temporary, { force: true });
    throw new Error(`FFmpeg archive SHA-256 mismatch: expected ${expectedSha256}, received ${actual}`);
  }
  await rename(temporary, destination);
}

function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: options.stdio ?? 'inherit',
      windowsHide: true,
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${basename(command)} exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function expandWindowsArchive(archive, destination) {
  const powershell = commandPath('powershell.exe') ?? commandPath('pwsh.exe');
  if (!powershell) throw new Error('PowerShell is required to extract the managed FFmpeg archive on Windows');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await runProcess(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-Command', 'Expand-Archive -LiteralPath $env:MW_FFMPEG_ARCHIVE -DestinationPath $env:MW_FFMPEG_DEST -Force',
  ], {
    env: { ...process.env, MW_FFMPEG_ARCHIVE: archive, MW_FFMPEG_DEST: destination },
  });
}

let bootstrapPromise = null;

export async function bootstrapManagedFfmpeg() {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = (async () => {
    if (process.platform !== 'win32') {
      throw new Error('Automatic FFmpeg bootstrap is currently enabled on Windows only; install FFmpeg through your OS package manager on this platform');
    }
    const managed = managedFfmpegPaths();
    await mkdir(managed.base, { recursive: true });
    console.log('  [media] Resolving verified FFmpeg Essentials build…');
    const expected = await expectedArchiveSha256();
    await downloadVerifiedArchive(managed.archive, expected);
    await expandWindowsArchive(managed.archive, managed.install);
    const runtime = await discoverFfmpegRuntime();
    if (!runtime || runtime.ownership !== 'makewatch') throw new Error('managed FFmpeg extraction completed but ffmpeg.exe was not found');
    const version = spawnSync(runtime.ffmpeg, ['-version'], { encoding: 'utf8', windowsHide: true });
    if (version.status !== 0) throw new Error('managed FFmpeg executable failed its version probe');
    return runtime;
  })().finally(() => { bootstrapPromise = null; });
  return bootstrapPromise;
}

export async function ensureFfmpegRuntime({ autoSetup = truthy(process.env.MAKEWATCH_AUTO_SETUP_MEDIA, true) } = {}) {
  const current = await discoverFfmpegRuntime();
  if (current) return current;
  if (!autoSetup || process.env.CI === 'true') {
    throw new Error('FFmpeg runtime is missing and automatic media setup is disabled');
  }
  return bootstrapManagedFfmpeg();
}
