import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

function exists(path) {
  return access(path).then(() => true).catch(() => false);
}

function commandPath(name) {
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(command, [name], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  return String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null;
}

function runtimeBase() {
  if (process.env.MAKEWATCH_RUNTIME_HOME) return resolve(process.env.MAKEWATCH_RUNTIME_HOME);
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, 'MakeWatch', 'runtimes');
  }
  if (process.env.XDG_DATA_HOME) return join(process.env.XDG_DATA_HOME, 'makewatch', 'runtimes');
  return join(homedir(), '.local', 'share', 'makewatch', 'runtimes');
}

export function chatterboxRuntimePaths() {
  const base = join(runtimeBase(), 'chatterbox');
  return {
    base,
    venv: join(base, 'venv'),
    python: process.platform === 'win32' ? join(base, 'venv', 'Scripts', 'python.exe') : join(base, 'venv', 'bin', 'python'),
  };
}

function pythonCandidates() {
  const result = [];
  if (process.env.MAKEWATCH_PYTHON) result.push({ command: process.env.MAKEWATCH_PYTHON, prefix: [] });
  if (process.platform === 'win32') {
    const py = commandPath('py');
    if (py) result.push({ command: py, prefix: ['-3.11'] });
  }
  const python = commandPath('python');
  if (python) result.push({ command: python, prefix: [] });
  const python3 = commandPath('python3');
  if (python3) result.push({ command: python3, prefix: [] });
  return result;
}

function selectPython() {
  for (const candidate of pythonCandidates()) {
    const check = spawnSync(candidate.command, [...candidate.prefix, '-c', 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'], {
      encoding: 'utf8', windowsHide: true,
    });
    if (check.status !== 0) continue;
    const version = String(check.stdout ?? '').trim();
    if (version === '3.11') return candidate;
  }
  return null;
}

function runChecked(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${basename(command)} exited with code ${code ?? 'unknown'}`));
    });
  });
}

export async function chatterboxRuntimeStatus() {
  const paths = chatterboxRuntimePaths();
  if (!await exists(paths.python)) {
    return { installed: false, python: null, model: 'Chatterbox Multilingual V3', languages: ['tr', 'en'] };
  }
  const probe = spawnSync(paths.python, ['-c', 'import chatterbox; print("ok")'], { encoding: 'utf8', windowsHide: true });
  return {
    installed: probe.status === 0,
    python: paths.python,
    model: 'Chatterbox Multilingual V3',
    languages: ['tr', 'en'],
    detail: probe.status === 0 ? 'runtime ready' : String(probe.stderr ?? probe.stdout ?? '').trim().slice(0, 800),
  };
}

let installPromise = null;

export async function ensureChatterboxRuntime() {
  const current = await chatterboxRuntimeStatus();
  if (current.installed && current.python) return current;
  if (installPromise) return installPromise;

  installPromise = (async () => {
    const python = selectPython();
    if (!python) {
      throw new Error('Chatterbox automatic setup requires Python 3.11. Install Python 3.11 once; Make & Watch manages everything else.');
    }
    const paths = chatterboxRuntimePaths();
    await mkdir(paths.base, { recursive: true });
    if (!await exists(paths.python)) {
      console.log(`  [audio] Creating isolated Chatterbox runtime · ${paths.venv}`);
      await runChecked(python.command, [...python.prefix, '-m', 'venv', paths.venv]);
    }
    console.log('  [audio] Installing Chatterbox Multilingual voice runtime…');
    await runChecked(paths.python, ['-m', 'pip', 'install', '--upgrade', 'pip']);
    await runChecked(paths.python, ['-m', 'pip', 'install', 'chatterbox-tts']);

    const ready = await chatterboxRuntimeStatus();
    if (!ready.installed || !ready.python) throw new Error(`Chatterbox runtime installation failed${ready.detail ? `: ${ready.detail}` : ''}`);
    return ready;
  })().finally(() => { installPromise = null; });

  return installPromise;
}
