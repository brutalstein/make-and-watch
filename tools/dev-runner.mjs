import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = process.cwd();
const isWindows = process.platform === 'win32';
const bridgeBaseUrl = `http://127.0.0.1:${process.env.MAKEWATCH_BRIDGE_PORT ?? 4177}`;

console.log('\n  MAKE & WATCH  /  STUDIO RUNTIME');
console.log('  Native engine + local bridge + Director + Studio\n');

const nativeBuild = spawnSync(
  'cmake',
  ['--build', '--preset', 'dev', '--target', 'makewatch_engine_host'],
  { cwd: root, stdio: 'inherit', windowsHide: true },
);
if (nativeBuild.status !== 0) process.exit(nativeBuild.status ?? 1);

const children = [];
let shuttingDown = false;

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
  children.push(child);
  return child;
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null) child.kill();
  }
  process.exitCode = exitCode;
}

const bridge = start(process.execPath, [resolve(root, 'tools/dev-bridge/server.mjs')]);
bridge.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`[dev] local bridge exited with code ${code ?? 'unknown'}`);
    shutdown(code ?? 1);
  }
});

async function waitForBridge() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${bridgeBaseUrl}/api/health`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // Startup race: bridge is still opening the native project database.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error('local native bridge did not become ready');
}

async function warmDirectorRuntime() {
  console.log('  [dev] Preparing Codex Director service…');
  try {
    const response = await fetch(`${bridgeBaseUrl}/api/director/providers`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`provider warm-up returned HTTP ${response.status}`);
    const payload = await response.json();
    const codex = payload?.result?.providers?.find((provider) => provider.provider === 'codex');
    if (!codex) {
      console.log('  [dev] Director warm-up completed without a Codex slot');
      return;
    }
    const runtime = codex.runtimeMode === 'exec_fallback'
      ? 'CLI compatibility'
      : codex.runtimeMode === 'app_server'
        ? 'App Server'
        : 'unavailable';
    if (codex.chatAvailable) {
      console.log(`  [dev] Codex Director ready · ${runtime}${codex.planType ? ` · ${codex.planType}` : ''}`);
      return;
    }
    if (codex.loginAvailable) {
      console.log(`  [dev] Codex ${runtime} ready · official ChatGPT sign-in starts automatically on first Send`);
      return;
    }
    console.log(`  [dev] Codex Director (${runtime}): ${codex.detail}`);
  } catch (error) {
    // Director is optional for project access. Studio still opens and explains the exact readiness issue.
    console.warn(`  [dev] Director warm-up deferred: ${error instanceof Error ? error.message : String(error)}`);
  }
}

try {
  await waitForBridge();
  await warmDirectorRuntime();
} catch (error) {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  shutdown(1);
  process.exit(1);
}

const studio = isWindows
  ? start(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', 'pnpm --filter @makewatch/studio dev'],
    )
  : start('pnpm', ['--filter', '@makewatch/studio', 'dev']);

studio.on('exit', (code) => {
  if (!shuttingDown) shutdown(code ?? 0);
});

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
