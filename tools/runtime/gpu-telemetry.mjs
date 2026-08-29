import { spawnSync } from 'node:child_process';

const CACHE_MS = 2_000;
let cache = null;
let cacheAt = 0;

function numeric(value) {
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function parseNvidiaSmiRow(row) {
  const parts = String(row ?? '').split(',').map((value) => value.trim());
  if (parts.length < 4) return null;
  const [name, total, free, used] = parts;
  if (!name) return null;
  return {
    gpuName: name.slice(0, 200),
    totalVramMb: numeric(total),
    freeVramMb: numeric(free),
    usedVramMb: numeric(used),
  };
}

export function localGpuTelemetry({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache && now - cacheAt < CACHE_MS) return { ...cache };
  const command = process.platform === 'win32' ? 'nvidia-smi.exe' : 'nvidia-smi';
  const result = spawnSync(command, [
    '--query-gpu=name,memory.total,memory.free,memory.used',
    '--format=csv,noheader,nounits',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 2_000,
  });
  const first = result.status === 0
    ? String(result.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    : '';
  const parsed = parseNvidiaSmiRow(first);
  cache = parsed ?? { gpuName: '', totalVramMb: 0, freeVramMb: 0, usedVramMb: 0 };
  cacheAt = now;
  return { ...cache };
}
