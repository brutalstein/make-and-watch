import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = process.cwd();
const isWindows = process.platform === 'win32';
const bridgeBaseUrl = `http://127.0.0.1:${process.env.MAKEWATCH_BRIDGE_PORT ?? 4177}`;
const CHILD_GRACE_MS = 4_000;

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
let shutdownPromise = null;

function start(command, args, options = {}, label = command) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
  children.push({ child, label, processGroup: options.detached === true });
  return child;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('close', onClose);
      resolvePromise(value);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('close', onClose);
  });
}

function forceProcessTree(entry) {
  const { child, processGroup } = entry;
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;

  if (isWindows) {
    spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }

  try {
    if (processGroup) process.kill(-child.pid, 'SIGKILL');
    else child.kill('SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') console.warn(`[dev] force-stop failed for ${entry.label}: ${error.message}`);
  }
}

async function stopEntry(entry) {
  const { child, label, processGroup } = entry;
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (!isWindows && processGroup && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch (error) {
    if (error?.code !== 'ESRCH') console.warn(`[dev] graceful stop failed for ${label}: ${error.message}`);
  }

  if (await waitForExit(child, CHILD_GRACE_MS)) return;
  console.warn(`[dev] ${label} exceeded shutdown grace; terminating its owned process tree`);
  forceProcessTree(entry);
  await waitForExit(child, 2_000);
}

function shutdown(exitCode = 0) {
  if (shutdownPromise) {
    if (exitCode !== 0) process.exitCode = exitCode;
    return shutdownPromise;
  }
  shuttingDown = true;
  process.exitCode = exitCode;

  // Studio is presentation-only; stop it first. The bridge then receives a
  // normal termination signal and owns its Codex/native shutdown sequence.
  shutdownPromise = (async () => {
    const ordered = [...children].reverse();
    for (const entry of ordered) await stopEntry(entry);
  })();
  return shutdownPromise;
}

const bridge = start(
  process.execPath,
  [resolve(root, 'tools/dev-bridge/server.mjs')],
  {},
  'local bridge',
);
bridge.on('exit', (code) => {
  if (!shuttingDown) {
    console.error(`[dev] local bridge exited with code ${code ?? 'unknown'}`);
    void shutdown(code ?? 1);
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
    const launcher = codex.executableName
      ? `${codex.executableName}${codex.discovery ? ` · ${codex.discovery}` : ''}`
      : 'no executable';
    if (codex.chatAvailable) {
      console.log(`  [dev] Codex Director ready · ${runtime}${codex.planType ? ` · ${codex.planType}` : ''}`);
      console.log(`  [dev] Codex launcher: ${launcher}`);
      return;
    }
    if (codex.loginAvailable) {
      console.log(`  [dev] Codex ${runtime} ready · official ChatGPT sign-in starts automatically on first Send`);
      console.log(`  [dev] Codex launcher: ${launcher}`);
      return;
    }
    console.log(`  [dev] Codex Director (${runtime}): ${codex.detail}`);
    console.log(`  [dev] Codex launcher: ${launcher}`);
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
  await shutdown(1);
  process.exit(1);
}

const studio = isWindows
  ? start(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', 'pnpm --filter @makewatch/studio dev'],
      {},
      'Studio',
    )
  : start(
      'pnpm',
      ['--filter', '@makewatch/studio', 'dev'],
      { detached: true },
      'Studio',
    );

studio.on('exit', (code) => {
  if (!shuttingDown) void shutdown(code ?? 0);
});

process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
