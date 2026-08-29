import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const planSchemaPath = resolve(root, 'schemas', 'v1', 'director-autopilot-plan.schema.json');

const STATUS_TIMEOUT_MS = 5_000;
const PLAN_TIMEOUT_MS = 120_000;
const MAX_STATUS_BYTES = 256 * 1024;
const MAX_PLAN_PROCESS_BYTES = 2 * 1024 * 1024;

let activeRun = null;

function providerCommand(provider) {
  if (provider === 'codex') return 'codex';
  if (provider === 'claude') return 'claude';
  throw new Error(`unsupported Director provider: ${provider}`);
}

function appendChunk(state, chunk, maximum, label, child) {
  state.bytes += chunk.length;
  if (state.bytes > maximum) {
    state.error = new Error(`${label} exceeded ${maximum} byte output limit`);
    terminateProcessTree(child);
    return;
  }
  state.chunks.push(chunk);
}

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.unref();
    return;
  }
  child.kill('SIGTERM');
  const timer = setTimeout(() => {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  }, 700);
  timer.unref();
}

function runBounded(command, args, {
  input = '',
  timeoutMs = STATUS_TIMEOUT_MS,
  maxOutputBytes = MAX_STATUS_BYTES,
  cwd = root,
  env = {},
} = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    const stdout = { chunks: [], bytes: 0, error: null };
    const stderr = { chunks: [], bytes: 0, error: null };
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk) => appendChunk(stdout, chunk, maxOutputBytes, 'provider stdout', child));
    child.stderr.on('data', (chunk) => appendChunk(stderr, chunk, maxOutputBytes, 'provider stderr', child));
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout.chunks).toString('utf8').trim();
      const stderrText = Buffer.concat(stderr.chunks).toString('utf8').trim();
      if (stdout.error) return rejectPromise(stdout.error);
      if (stderr.error) return rejectPromise(stderr.error);
      if (timedOut) return rejectPromise(new Error(`provider process timed out after ${timeoutMs} ms`));
      resolvePromise({ code: code ?? -1, signal, stdout: stdoutText, stderr: stderrText });
    });

    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function helpText(command, args) {
  try {
    const result = await runBounded(command, args, { timeoutMs: STATUS_TIMEOUT_MS });
    return `${result.stdout}\n${result.stderr}`;
  } catch {
    return '';
  }
}

async function codexStatus() {
  const command = providerCommand('codex');
  let version;
  try {
    const versionResult = await runBounded(command, ['--version']);
    if (versionResult.code !== 0) throw new Error(versionResult.stderr || 'codex --version failed');
    version = versionResult.stdout || versionResult.stderr;
  } catch (error) {
    return {
      provider: 'codex', installed: false, authenticated: false, authMethod: '', version: '',
      capable: false, detail: error instanceof Error ? error.message : String(error),
    };
  }

  const execHelp = await helpText(command, ['exec', '--help']);
  const capable = execHelp.includes('--output-schema')
    && execHelp.includes('--output-last-message')
    && execHelp.includes('--sandbox');

  let authenticated = false;
  let authMethod = '';
  let detail = '';
  try {
    const status = await runBounded(command, ['login', 'status']);
    const text = `${status.stdout}\n${status.stderr}`.trim();
    authenticated = status.code === 0 && !/not logged in/i.test(text);
    if (/chatgpt/i.test(text)) authMethod = 'chatgpt';
    else if (/api key/i.test(text)) authMethod = 'api_key';
    else if (/agent identity/i.test(text)) authMethod = 'agent_identity';
    detail = text;
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }

  return {
    provider: 'codex', installed: true, authenticated, authMethod, version,
    capable, detail,
  };
}

async function claudeStatus() {
  const command = providerCommand('claude');
  let version;
  try {
    const versionResult = await runBounded(command, ['--version']);
    if (versionResult.code !== 0) throw new Error(versionResult.stderr || 'claude --version failed');
    version = versionResult.stdout || versionResult.stderr;
  } catch (error) {
    return {
      provider: 'claude', installed: false, authenticated: false, authMethod: '', version: '',
      capable: false, detail: error instanceof Error ? error.message : String(error),
    };
  }

  const cliHelp = await helpText(command, ['--help']);
  const capable = cliHelp.includes('--output-format')
    && cliHelp.includes('--max-turns')
    && cliHelp.includes('--permission-mode');

  let authenticated = false;
  let authMethod = '';
  let detail = '';
  try {
    const status = await runBounded(command, ['auth', 'status']);
    const text = `${status.stdout}\n${status.stderr}`.trim();
    detail = text;
    try {
      const parsed = JSON.parse(status.stdout);
      authenticated = Boolean(parsed.loggedIn);
      authMethod = String(parsed.authMethod ?? parsed.apiProvider ?? '');
    } catch {
      authenticated = status.code === 0 && /logged.?in|claude\.ai|oauth/i.test(text) && !/logged.?out|not logged/i.test(text);
      if (/claude\.ai/i.test(text)) authMethod = 'claude.ai';
      else if (/oauth/i.test(text)) authMethod = 'oauth';
    }
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }

  return {
    provider: 'claude', installed: true, authenticated, authMethod, version,
    capable, detail,
  };
}

export async function providerStatuses() {
  const [codex, claude] = await Promise.all([codexStatus(), claudeStatus()]);
  return { providers: [codex, claude], activeProviderRun: activeRun?.provider ?? null };
}

export async function launchProviderLogin(provider) {
  const command = providerCommand(provider);
  const status = provider === 'codex' ? await codexStatus() : await claudeStatus();
  if (!status.installed) throw new Error(`${provider} official client is not installed`);

  const args = provider === 'codex' ? ['login'] : ['auth', 'login'];
  const child = spawn(command, args, {
    cwd: root,
    detached: true,
    windowsHide: false,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  return {
    provider,
    launched: true,
    command: `${command} ${args.join(' ')}`,
    message: 'Authentication remains inside the official provider client. Make & Watch does not receive OAuth credentials.',
  };
}

function parsePlanText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Error('Director provider returned an empty result');
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1 || !Array.isArray(parsed.steps)) {
    throw new Error('Director provider result is not an AutopilotPlan v1 object');
  }
  return parsed;
}

async function invokeCodex(prompt) {
  const temp = await mkdtemp(join(tmpdir(), 'makewatch-codex-'));
  const outputPath = join(temp, 'plan.json');
  try {
    const args = [
      'exec',
      '--sandbox', 'read-only',
      '--ephemeral',
      '--output-schema', planSchemaPath,
      '--output-last-message', outputPath,
    ];
    const result = await runBounded('codex', args, {
      input: prompt,
      timeoutMs: PLAN_TIMEOUT_MS,
      maxOutputBytes: MAX_PLAN_PROCESS_BYTES,
      env: { MAKEWATCH_DIRECTOR_MODE: '1' },
    });
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `Codex exited with code ${result.code}`);
    }
    const final = await readFile(outputPath, 'utf8');
    return parsePlanText(final);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function invokeClaude(prompt) {
  const result = await runBounded('claude', [
    '-p',
    '--output-format', 'json',
    '--permission-mode', 'plan',
    '--max-turns', '1',
  ], {
    input: prompt,
    timeoutMs: PLAN_TIMEOUT_MS,
    maxOutputBytes: MAX_PLAN_PROCESS_BYTES,
    env: { MAKEWATCH_DIRECTOR_MODE: '1' },
  });
  if (result.code !== 0) {
    throw new Error(result.stderr || result.stdout || `Claude exited with code ${result.code}`);
  }

  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    throw new Error('Claude Code did not return its documented JSON print envelope');
  }
  if (envelope.is_error === true) {
    throw new Error(String(envelope.result ?? 'Claude Code reported an error'));
  }
  return parsePlanText(envelope.result);
}

export async function invokeDirectorPlan(provider, prompt) {
  if (activeRun) throw new Error(`Director provider is busy with ${activeRun.provider}`);
  const status = provider === 'codex' ? await codexStatus() : await claudeStatus();
  if (!status.installed) throw new Error(`${provider} official client is not installed`);
  if (!status.authenticated) throw new Error(`${provider} official client is not authenticated`);
  if (!status.capable) throw new Error(`${provider} client version lacks required safe automation flags; update the official client`);

  const run = { provider, startedAt: Date.now() };
  activeRun = run;
  try {
    const plan = provider === 'codex' ? await invokeCodex(prompt) : await invokeClaude(prompt);
    if (plan.provider !== provider) {
      throw new Error(`Director plan provider mismatch: expected ${provider}, got ${String(plan.provider)}`);
    }
    return plan;
  } finally {
    if (activeRun === run) activeRun = null;
  }
}

export function shutdownDirectorProviders() {
  // Provider invocations are request-scoped children. The bounded runner owns
  // their timeout/termination. No long-lived OAuth or provider daemon is owned
  // by Make & Watch.
  activeRun = null;
}
