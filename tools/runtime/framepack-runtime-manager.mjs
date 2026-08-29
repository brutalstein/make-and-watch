import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const FRAMEPACK_MIN_VRAM_MB = 6 * 1024;
const FRAMEPACK_MODEL_DOWNLOAD_WARNING_GB = 30;
const REQUIRED_HF_CACHE_REPOS = [
  'models--hunyuanvideo-community--HunyuanVideo',
  'models--lllyasviel--flux_redux_bfl',
  'models--lllyasviel--FramePackI2V_HY',
];

async function exists(path) {
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function isFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map((value) => resolve(value)))];
}

function managedRuntimeBase() {
  if (process.env.MAKEWATCH_RUNTIME_HOME) return resolve(process.env.MAKEWATCH_RUNTIME_HOME);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'MakeWatch', 'runtimes');
  }
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, 'makewatch', 'runtimes');
  return join(homedir(), '.local', 'share', 'makewatch', 'runtimes');
}

function candidateBases() {
  const home = homedir();
  const oneDrive = process.env.OneDrive || process.env.OneDriveConsumer || '';
  return unique([
    process.env.MAKEWATCH_FRAMEPACK_HOME,
    process.env.FRAMEPACK_HOME,
    join(managedRuntimeBase(), 'FramePack'),
    join(home, 'FramePack'),
    join(home, 'Documents', 'FramePack'),
    join(home, 'Documents', 'GitHub', 'FramePack'),
    join(home, 'Desktop', 'FramePack'),
    join(home, 'Downloads', 'FramePack'),
    oneDrive && join(oneDrive, 'Documents', 'FramePack'),
    oneDrive && join(oneDrive, 'Documents', 'GitHub', 'FramePack'),
    oneDrive && join(oneDrive, 'Desktop', 'FramePack'),
  ]);
}

async function inspectModelCache(root) {
  const hub = join(root, 'hf_download', 'hub');
  const states = [];
  for (const repo of REQUIRED_HF_CACHE_REPOS) {
    states.push({ repo, present: await exists(join(hub, repo)) });
  }
  return {
    hub,
    requiredRepos: states,
    likelyReady: states.every((entry) => entry.present),
  };
}

async function inspectRoot(root) {
  const sourceEntry = join(root, 'demo_gradio.py');
  const helperDirectory = join(root, 'diffusers_helper');
  const runBat = join(root, 'run.bat');
  const updateBat = join(root, 'update.bat');
  const sourceInstall = await isFile(sourceEntry) && await exists(helperDirectory);
  const oneClickInstall = process.platform === 'win32' && await isFile(runBat);
  if (!sourceInstall && !oneClickInstall) return null;

  const likelyPython = process.platform === 'win32'
    ? [
        join(root, 'python_embeded', 'python.exe'),
        join(root, 'python_embedded', 'python.exe'),
        join(root, '.venv', 'Scripts', 'python.exe'),
        join(root, 'venv', 'Scripts', 'python.exe'),
      ]
    : [join(root, '.venv', 'bin', 'python'), join(root, 'venv', 'bin', 'python')];
  let python = null;
  for (const candidate of likelyPython) {
    if (await isFile(candidate)) {
      python = candidate;
      break;
    }
  }

  const modelCache = await inspectModelCache(root);
  return {
    root,
    kind: oneClickInstall ? 'official-one-click' : 'source',
    sourceEntry: sourceInstall ? sourceEntry : null,
    runScript: oneClickInstall ? runBat : null,
    updateScript: await isFile(updateBat) ? updateBat : null,
    python,
    modelCache,
    score: oneClickInstall ? 100 : python ? 90 : 70,
  };
}

export async function discoverFramePackInstallations() {
  const found = [];
  for (const root of candidateBases()) {
    const installation = await inspectRoot(root);
    if (installation) found.push(installation);
  }
  return found.sort((left, right) => right.score - left.score || left.root.localeCompare(right.root));
}

export function framePackHardwareAssessment({ gpuName = '', totalVramMb = 0 } = {}) {
  const vram = Math.max(0, Number(totalVramMb) || 0);
  const name = String(gpuName ?? '');
  const nvidia = /nvidia|geforce|rtx/i.test(name);
  const enoughVram = vram >= FRAMEPACK_MIN_VRAM_MB;
  return {
    supportedFamily: nvidia,
    enoughVram,
    totalVramMb: vram,
    minimumVramMb: FRAMEPACK_MIN_VRAM_MB,
    recommendedExclusiveGpu: true,
    recommendedReserveVramMb: vram <= 10 * 1024 ? 1536 : 2048,
    readyForAttempt: nvidia && enoughVram,
  };
}

export async function framePackRuntimeStatus(hardware = {}) {
  const installations = await discoverFramePackInstallations();
  const hardwareAssessment = framePackHardwareAssessment(hardware);
  const selected = installations[0] ?? null;
  const modelsReady = Boolean(selected?.modelCache?.likelyReady);
  return {
    provider: 'framepack',
    installed: Boolean(selected),
    launchable: Boolean(selected?.runScript || selected?.sourceEntry),
    modelsReady,
    selected,
    discovered: installations.map(({ root, kind, score, python, modelCache }) => ({
      root,
      kind,
      score,
      python: Boolean(python),
      modelsReady: Boolean(modelCache?.likelyReady),
    })),
    hardware: hardwareAssessment,
    automaticBootstrap: false,
    bootstrapPolicy: 'explicit-only',
    modelDownloadWarningGb: FRAMEPACK_MODEL_DOWNLOAD_WARNING_GB,
    detail: !selected
      ? `FramePack is not installed. Automatic installation is intentionally disabled because the official model download is over ${FRAMEPACK_MODEL_DOWNLOAD_WARNING_GB} GB.`
      : !modelsReady
        ? `FramePack code is installed, but its required Hugging Face model cache is incomplete. Explicit setup is required before generation; Make & Watch will not trigger the ${FRAMEPACK_MODEL_DOWNLOAD_WARNING_GB}+ GB download implicitly.`
        : !hardwareAssessment.readyForAttempt
          ? 'FramePack code and models are present, but hardware assessment is not ready.'
          : 'FramePack code and required model-cache roots are present; offline execution can be attempted.',
  };
}

export const framePackRuntimeConstants = Object.freeze({
  minimumVramMb: FRAMEPACK_MIN_VRAM_MB,
  modelDownloadWarningGb: FRAMEPACK_MODEL_DOWNLOAD_WARNING_GB,
  requiredHfCacheRepos: REQUIRED_HF_CACHE_REPOS,
  managedRoot: join(managedRuntimeBase(), 'FramePack'),
  parentOfManagedRoot: dirname(join(managedRuntimeBase(), 'FramePack')),
});
