import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const COMFY_HOST = '127.0.0.1';
const COMFY_PORT = Number(process.env.MAKEWATCH_COMFYUI_PORT ?? 8188);
const COMFY_BASE_URL = process.env.MAKEWATCH_COMFYUI_URL ?? `http://${COMFY_HOST}:${COMFY_PORT}`;
const MANAGED_DIR_NAME = 'MakeWatch';
const PREVIEW_CHECKPOINT = 'v1-5-pruned-emaonly-fp16.safetensors';
const PREVIEW_CHECKPOINT_BYTES = 2_132_696_762;
const PREVIEW_CHECKPOINT_SHA256 = 'e9476a13728cd75d8279f6ec8bad753a66a1957ca375a1464dc63b37db6e3916';
const PREVIEW_CHECKPOINT_URL = `https://huggingface.co/Comfy-Org/stable-diffusion-v1-5-archive/resolve/main/${PREVIEW_CHECKPOINT}?download=true`;

function truthy(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
}

async function exists(path) {
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => resolve(value)))];
}

function commandPath(name) {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(command, [name], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  return String(result.stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

function managedBaseDirectory() {
  if (process.env.MAKEWATCH_RUNTIME_HOME) return resolve(process.env.MAKEWATCH_RUNTIME_HOME);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, MANAGED_DIR_NAME, 'runtimes');
  }
  const xdg = process.env.XDG_DATA_HOME;
  return xdg
    ? join(xdg, 'makewatch', 'runtimes')
    : join(homedir(), '.local', 'share', 'makewatch', 'runtimes');
}

export function managedMediaRuntimePaths() {
  const base = managedBaseDirectory();
  const cliVenv = join(base, 'comfy-cli');
  const workspace = join(base, 'ComfyUI');
  return {
    base,
    cliVenv,
    workspace,
    cliPython: process.platform === 'win32'
      ? join(cliVenv, 'Scripts', 'python.exe')
      : join(cliVenv, 'bin', 'python'),
    comfyExecutable: process.platform === 'win32'
      ? join(cliVenv, 'Scripts', 'comfy.exe')
      : join(cliVenv, 'bin', 'comfy'),
  };
}

async function probeJson(url, timeoutMs = 1_500) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export async function probeComfyUi(baseUrl = COMFY_BASE_URL) {
  try {
    await probeJson(`${baseUrl.replace(/\/$/, '')}/prompt`);
    return { online: true, baseUrl, detail: 'responding' };
  } catch (error) {
    return {
      online: false,
      baseUrl,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function commonComfyRoots() {
  const home = homedir();
  const managed = managedMediaRuntimePaths().workspace;
  const roots = [
    process.env.MAKEWATCH_COMFYUI_HOME,
    process.env.COMFYUI_HOME,
    managed,
    join(home, 'ComfyUI'),
    join(home, 'Documents', 'ComfyUI'),
    join(home, 'Desktop', 'ComfyUI'),
    join(home, 'Downloads', 'ComfyUI'),
    join(home, 'Downloads', 'ComfyUI_windows_portable', 'ComfyUI'),
    join(home, 'Desktop', 'ComfyUI_windows_portable', 'ComfyUI'),
  ];
  if (process.platform === 'win32') roots.push('C:\\ComfyUI', 'D:\\ComfyUI');
  return unique(roots);
}

async function pythonForComfyRoot(comfyRoot) {
  const parent = dirname(comfyRoot);
  const candidates = process.platform === 'win32'
    ? [
        join(parent, 'python_embeded', 'python.exe'),
        join(parent, 'python_embedded', 'python.exe'),
        join(comfyRoot, '.venv', 'Scripts', 'python.exe'),
        join(comfyRoot, 'venv', 'Scripts', 'python.exe'),
      ]
    : [
        join(comfyRoot, '.venv', 'bin', 'python'),
        join(comfyRoot, 'venv', 'bin', 'python'),
      ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return process.env.MAKEWATCH_PYTHON || commandPath('python') || commandPath('python3');
}

export async function discoverComfyUiInstallations() {
  const managed = managedMediaRuntimePaths();
  const results = [];

  if (await exists(managed.comfyExecutable) && await exists(join(managed.workspace, 'main.py'))) {
    results.push({
      kind: 'managed-comfy-cli',
      root: managed.workspace,
      command: managed.comfyExecutable,
      args: [
        '--skip-prompt',
        '--workspace', managed.workspace,
        'launch', '--',
        '--listen', COMFY_HOST,
        '--port', String(COMFY_PORT),
        '--disable-auto-launch',
      ],
      cwd: managed.workspace,
      score: 100,
    });
  }

  for (const root of commonComfyRoots()) {
    if (!await exists(join(root, 'main.py'))) continue;
    if (results.some((candidate) => resolve(candidate.root) === resolve(root))) continue;
    const python = await pythonForComfyRoot(root);
    if (!python) continue;
    const parent = dirname(root);
    const portable = basename(parent).toLowerCase().includes('portable') || basename(dirname(python)).toLowerCase().includes('python_embed');
    results.push({
      kind: portable ? 'portable' : 'python-source',
      root,
      command: python,
      args: [
        ...(portable ? ['-s'] : []),
        join(root, 'main.py'),
        '--listen', COMFY_HOST,
        '--port', String(COMFY_PORT),
        '--disable-auto-launch',
      ],
      cwd: root,
      score: root === managed.workspace ? 90 : portable ? 80 : 60,
    });
  }

  return results.sort((left, right) => right.score - left.score);
}

function pythonCandidateSpecs() {
  const explicit = process.env.MAKEWATCH_PYTHON;
  const specs = [];
  if (explicit) specs.push({ command: explicit, prefix: [] });
  if (process.platform === 'win32' && commandPath('py')) {
    specs.push({ command: commandPath('py'), prefix: ['-3.12'] });
    specs.push({ command: commandPath('py'), prefix: ['-3.11'] });
  }
  const python = commandPath('python');
  if (python) specs.push({ command: python, prefix: [] });
  const python3 = commandPath('python3');
  if (python3) specs.push({ command: python3, prefix: [] });
  return specs;
}

function workingPython() {
  for (const spec of pythonCandidateSpecs()) {
    const result = spawnSync(
      spec.command,
      [...spec.prefix, '-c', 'import sys; print(sys.executable); print(sys.version_info[:2])'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.status !== 0) continue;
    const versionMatch = String(result.stdout ?? '').match(/\((\d+),\s*(\d+)\)/);
    if (!versionMatch) continue;
    const major = Number(versionMatch[1]);
    const minor = Number(versionMatch[2]);
    if (major === 3 && minor >= 10 && minor <= 13) return spec;
  }
  return null;
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: options.stdio ?? 'inherit',
    encoding: options.stdio === 'pipe' ? 'utf8' : undefined,
    cwd: options.cwd,
    env: options.env ?? process.env,
    windowsHide: true,
  });
  if (result.status !== 0) {
    const suffix = options.stdio === 'pipe'
      ? `\n${String(result.stderr ?? result.stdout ?? '').slice(-2000)}`
      : '';
    throw new Error(`${basename(command)} exited with code ${result.status ?? 'unknown'}${suffix}`);
  }
  return result;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  }), new Transform({
    transform(_chunk, _encoding, callback) { callback(); },
  }));
  return hash.digest('hex');
}

async function checkpointIsValid(path) {
  try {
    const info = await stat(path);
    if (info.size !== PREVIEW_CHECKPOINT_BYTES) return false;
    return await sha256File(path) === PREVIEW_CHECKPOINT_SHA256;
  } catch {
    return false;
  }
}

async function downloadCheckpoint(destination) {
  if (await checkpointIsValid(destination)) return { downloaded: false, path: destination };
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.partial`;
  await rm(temporary, { force: true });

  console.log(`  [media] Downloading verified preview model · ${PREVIEW_CHECKPOINT} · 2.13 GB`);
  const response = await fetch(PREVIEW_CHECKPOINT_URL, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`preview model download failed with HTTP ${response.status}`);

  const hash = createHash('sha256');
  let received = 0;
  let lastPercent = -10;
  const tracker = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      hash.update(chunk);
      const percent = Math.floor((received / PREVIEW_CHECKPOINT_BYTES) * 100);
      if (percent >= lastPercent + 10) {
        lastPercent = percent;
        console.log(`  [media] Preview model ${Math.min(100, percent)}%`);
      }
      callback(null, chunk);
    },
  });
  await pipeline(response.body, tracker, createWriteStream(temporary));

  if (received !== PREVIEW_CHECKPOINT_BYTES) {
    await rm(temporary, { force: true });
    throw new Error(`preview model size mismatch: received ${received} bytes`);
  }
  if (hash.digest('hex') !== PREVIEW_CHECKPOINT_SHA256) {
    await rm(temporary, { force: true });
    throw new Error('preview model SHA-256 verification failed');
  }
  await rename(temporary, destination);
  return { downloaded: true, path: destination };
}

export async function bootstrapManagedComfyUi() {
  const managed = managedMediaRuntimePaths();
  await mkdir(managed.base, { recursive: true });
  const python = workingPython();
  if (!python) {
    throw new Error('Python 3.10-3.13 was not found; automatic ComfyUI bootstrap cannot continue');
  }

  if (!await exists(managed.cliPython)) {
    console.log(`  [media] Creating isolated ComfyUI toolchain at ${managed.cliVenv}`);
    runChecked(python.command, [...python.prefix, '-m', 'venv', managed.cliVenv]);
  }

  if (!await exists(managed.comfyExecutable)) {
    console.log('  [media] Installing official comfy-cli into isolated runtime');
    runChecked(managed.cliPython, ['-m', 'pip', 'install', '--upgrade', 'pip', 'comfy-cli']);
  }

  if (!await exists(join(managed.workspace, 'main.py'))) {
    const nvidia = Boolean(commandPath('nvidia-smi'));
    console.log(`  [media] Installing managed ComfyUI · ${nvidia ? 'NVIDIA' : 'CPU'} profile`);
    runChecked(managed.comfyExecutable, [
      '--skip-prompt',
      '--workspace', managed.workspace,
      'install',
      '--fast-deps',
      '--skip-manager',
      ...(nvidia ? ['--nvidia'] : ['--cpu']),
    ]);
  }

  const checkpointPath = join(managed.workspace, 'models', 'checkpoints', PREVIEW_CHECKPOINT);
  await downloadCheckpoint(checkpointPath);
  return managed;
}

export async function ensureComfyUiRuntime({ autoSetup = truthy(process.env.MAKEWATCH_AUTO_SETUP_MEDIA, true) } = {}) {
  const probe = await probeComfyUi();
  if (probe.online) {
    return { status: 'online', ownership: 'external', baseUrl: probe.baseUrl, launch: null };
  }

  let candidates = await discoverComfyUiInstallations();
  if (candidates.length === 0 && autoSetup && process.env.CI !== 'true') {
    try {
      await bootstrapManagedComfyUi();
      candidates = await discoverComfyUiInstallations();
    } catch (error) {
      return {
        status: 'setup_failed',
        ownership: 'none',
        baseUrl: COMFY_BASE_URL,
        launch: null,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const launch = candidates[0] ?? null;
  if (!launch) {
    return {
      status: 'missing',
      ownership: 'none',
      baseUrl: COMFY_BASE_URL,
      launch: null,
      detail: autoSetup ? 'ComfyUI could not be discovered or bootstrapped' : 'automatic media setup is disabled',
    };
  }
  return {
    status: 'launchable',
    ownership: 'makewatch',
    baseUrl: COMFY_BASE_URL,
    launch,
    discovered: candidates.map(({ kind, root, score }) => ({ kind, root, score })),
  };
}

export function discoverFfmpeg() {
  const explicit = process.env.MAKEWATCH_FFMPEG;
  if (explicit) return explicit;
  return commandPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

export const mediaRuntimeConstants = Object.freeze({
  comfyBaseUrl: COMFY_BASE_URL,
  comfyPort: COMFY_PORT,
  previewCheckpoint: PREVIEW_CHECKPOINT,
  previewCheckpointSha256: PREVIEW_CHECKPOINT_SHA256,
  previewCheckpointBytes: PREVIEW_CHECKPOINT_BYTES,
});
