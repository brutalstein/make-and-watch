import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { cpus, freemem, platform, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { DEV_SEED_COMMANDS } from './dev-seed.mjs';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bridgePort = Number(process.env.MAKEWATCH_BRIDGE_PORT ?? 4177);
const nativeHost = resolve(
  root,
  'build',
  'dev',
  'engine',
  process.platform === 'win32' ? 'makewatch_engine_host.exe' : 'makewatch_engine_host',
);
const databasePath = resolve(root, process.env.MAKEWATCH_PROJECT_DB ?? '.makewatch/dev-project.sqlite3');

if (!Number.isInteger(bridgePort) || bridgePort < 1024 || bridgePort > 65535) {
  console.error(`[bridge] invalid MAKEWATCH_BRIDGE_PORT: ${process.env.MAKEWATCH_BRIDGE_PORT ?? bridgePort}`);
  process.exit(2);
}

if (!existsSync(nativeHost)) {
  console.error(`[bridge] native host not found: ${nativeHost}`);
  console.error('[bridge] run cmake --build --preset dev --target makewatch_engine_host');
  process.exit(2);
}

let stdoutBuffer = '';
let shuttingDown = false;
const pending = new Map();

const native = spawn(nativeHost, ['--db', databasePath], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

native.stdout.setEncoding('utf8');
native.stderr.setEncoding('utf8');
native.stderr.on('data', (chunk) => process.stderr.write(`[engine] ${chunk}`));
native.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk;
  while (true) {
    const newline = stdoutBuffer.indexOf('\n');
    if (newline < 0) break;
    const line = stdoutBuffer.slice(0, newline).trim();
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    let response;
    try {
      response = JSON.parse(line);
    } catch (error) {
      console.error('[bridge] native host emitted invalid JSON:', error);
      continue;
    }
    const waiter = pending.get(response.id);
    if (!waiter) continue;
    clearTimeout(waiter.timer);
    pending.delete(response.id);
    waiter.resolve(response);
  }
});

native.on('exit', (code, signal) => {
  const message = `native engine exited (${code ?? 'null'} / ${signal ?? 'no-signal'})`;
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(message));
  }
  pending.clear();
  if (!shuttingDown) {
    console.error(`[bridge] ${message}`);
    process.exit(3);
  }
});

function rpc(method, params = {}) {
  if (native.exitCode !== null || native.killed) {
    return Promise.reject(new Error('native engine is not running'));
  }
  const id = randomUUID();
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectPromise(new Error(`native RPC timeout: ${method}`));
    }, 10_000);
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
    native.stdin.write(`${JSON.stringify({ protocol: 1, id, method, params })}\n`);
  });
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
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('request body exceeds 2 MiB');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

async function systemTelemetry() {
  const telemetry = {
    platform: platform(),
    cpu: {
      logicalCores: cpus().length,
      totalMemoryMb: Math.round(totalmem() / 1024 / 1024),
      freeMemoryMb: Math.round(freemem() / 1024 / 1024),
    },
    gpu: null,
  };

  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      [
        '--query-gpu=name,memory.total,memory.used,utilization.gpu,temperature.gpu',
        '--format=csv,noheader,nounits',
      ],
      { timeout: 1800, windowsHide: true },
    );
    const [name, total, used, utilization, temperature] = stdout.trim().split(',').map((value) => value.trim());
    const memoryTotalMb = Number(total);
    const memoryUsedMb = Number(used);
    telemetry.gpu = {
      name,
      memoryTotalMb,
      memoryUsedMb,
      memoryFreeMb: Math.max(0, memoryTotalMb - memoryUsedMb),
      utilizationPercent: Number(utilization),
      temperatureC: Number(temperature),
    };
  } catch {
    // GPU telemetry is optional. The native resource layer remains authoritative for admission.
  }
  return telemetry;
}

const initialHealth = await rpc('health');
if (!initialHealth.ok) {
  throw new Error(`native health failed: ${initialHealth.error?.message ?? 'unknown error'}`);
}
if (initialHealth.result.nodeCount === 0) {
  const seeded = await rpc('project.apply', { commands: DEV_SEED_COMMANDS });
  if (!seeded.ok) throw new Error(`development seed failed: ${seeded.error?.message ?? 'unknown error'}`);
  console.log('[bridge] created persistent development project seed');
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
      sendJson(request, response, 200, await rpc('health'));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/project') {
      sendJson(request, response, 200, await rpc('project.snapshot'));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/system') {
      sendJson(request, response, 200, {
        protocol: 1,
        id: `system-${randomUUID()}`,
        ok: true,
        result: await systemTelemetry(),
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/project/apply') {
      const body = await readJsonBody(request);
      sendJson(request, response, 200, await rpc('project.apply', { commands: body.commands }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/project/impact') {
      const body = await readJsonBody(request);
      sendJson(request, response, 200, await rpc('project.impact', { source: body.source }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/project/replace') {
      const body = await readJsonBody(request);
      sendJson(request, response, 200, await rpc('project.replace', { snapshot: body.snapshot }));
      return;
    }
    sendJson(request, response, 404, { ok: false, error: { code: 'not_found', message: 'route not found' } });
  } catch (error) {
    sendJson(request, response, 502, {
      ok: false,
      error: { code: 'bridge_error', message: error instanceof Error ? error.message : String(error) },
    });
  }
});

server.on('error', (error) => {
  console.error(`[bridge] server error: ${error.message}`);
  process.exit(4);
});

server.listen(bridgePort, '127.0.0.1', () => {
  console.log(`[bridge] native project bridge ready at http://127.0.0.1:${bridgePort}`);
  console.log(`[bridge] project database: ${databasePath}`);
});

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  native.stdin.end();
  if (native.exitCode === null) native.kill();
}

process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('exit', shutdown);
