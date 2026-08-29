import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const planSchemaPath = resolve(root, 'schemas', 'v1', 'director-autopilot-plan.schema.json');

const STATUS_TIMEOUT_MS = 5_000;
const PLAN_TIMEOUT_MS = 120_000;
const PROVIDER_SHUTDOWN_WAIT_MS = 2_000;
const MAX_STATUS_BYTES = 256 * 1024;
const MAX_PLAN_PROCESS_BYTES = 2 * 1024 * 1024;
const EXPERIMENTAL_CLAUDE_CODE = process.env.MAKEWATCH_ENABLE_EXPERIMENTAL_CLAUDE_CODE === '1';

let activeRun = null;
let activePlanChild = null;
let claudeSchemaPromise = null;

function providerCommand(provider) {
  if (provider === 'codex') return 'codex';
  if (provider === 'claude') return 'claude';
  throw new Error(`unsupported Director provider: ${provider}`);
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

function waitForProcessExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
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
    const timer = setTimeout(() => finish(child.exitCode !== null), timeoutMs);
    timer.unref();
    child.once('close', onClose);
  });
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

function runBounded(command, args, {
  input = '',
  timeoutMs = STATUS_TIMEOUT_MS,
  maxOutputBytes = MAX_STATUS_BYTES,
  cwd = root,
  env = {},
  trackPlanChild = false,
} = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
    if (trackPlanChild) activePlanChild = child;

    const stdout = { chunks: [], bytes: 0, error: null };
    const stderr = { chunks: [], bytes: 0, error: null };
    let timedOut = false;
    let settled = false;

    const clearOwnership = () => {
      if (activePlanChild === child) activePlanChild = null;
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearOwnership();
      rejectPromise(error);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      clearOwnership();
      resolvePromise(value);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child);
    }, timeoutMs);
    timer.unref();

    child.stdout.on('data', (chunk) => appendChunk(stdout, chunk, maxOutputBytes, 'provider stdout', child));
    child.stderr.on('data', (chunk) => appendChunk(stderr, chunk, maxOutputBytes, 'provider stderr', child));
    child.on('error', (error) => {
      clearTimeout(timer);
      finishReject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout.chunks).toString('utf8').trim();
      const stderrText = Buffer.concat(stderr.chunks).toString('utf8').trim();
      if (stdout.error) return finishReject(stdout.error);
      if (stderr.error) return finishReject(stderr.error);
      if (timedOut) return finishReject(new Error(`provider process timed out after ${timeoutMs} ms`));
      finishResolve({ code: code ?? -1, signal, stdout: stdoutText, stderr: stderrText });
    });

    child.stdin.end(input || undefined);
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

function safeStatusDetail({ provider, installed, authenticated, capable, policy }) {
  if (provider === 'claude' && policy === 'api_required') {
    return installed
      ? 'Claude Code detected; third-party product use requires a supported Anthropic API path'
      : 'Production Claude integration requires Anthropic API/Console credentials';
  }
  if (!installed) return 'Official client not found on PATH';
  if (!capable) return 'Official client must be updated for required safe automation flags';
  if (!authenticated) return 'Official client is installed and awaiting first-party sign-in';
  return policy === 'experimental_local_client'
    ? 'Developer-preview Claude Code bridge is enabled locally'
    : 'Official client is authenticated and ready for Make & Watch Director planning';
}

async function codexStatus() {
  const policy = 'supported_local_client';
  const command = providerCommand('codex');
  let version = '';
  try {
    const versionResult = await runBounded(command, ['--version']);
    if (versionResult.code !== 0) throw new Error('codex --version failed');
    version = (versionResult.stdout || versionResult.stderr).slice(0, 160);
  } catch {
    return {
      provider: 'codex', policy, installed: false, authenticated: false, authMethod: '', version: '', capable: false,
      detail: safeStatusDetail({ provider: 'codex', installed: false, authenticated: false, capable: false, policy }),
    };
  }

  const execHelp = await helpText(command, ['exec', '--help']);
  const capable = execHelp.includes('--output-schema')
    && execHelp.includes('--output-last-message')
    && execHelp.includes('--sandbox')
    && execHelp.includes('--ephemeral');

  let authenticated = false;
  let authMethod = '';
  try {
    const status = await runBounded(command, ['login', 'status']);
    const text = `${status.stdout}\n${status.stderr}`.trim();
    authenticated = status.code === 0 && !/not logged in/i.test(text);
    if (/chatgpt/i.test(text)) authMethod = 'chatgpt';
    else if (/api key/i.test(text)) authMethod = 'api_key';
    else if (/agent identity/i.test(text)) authMethod = 'agent_identity';
  } catch {
    authenticated = false;
  }

  return {
    provider: 'codex', policy, installed: true, authenticated, authMethod, version, capable,
    detail: safeStatusDetail({ provider: 'codex', installed: true, authenticated, capable, policy }),
  };
}

async function claudeStatus() {
  const policy = EXPERIMENTAL_CLAUDE_CODE ? 'experimental_local_client' : 'api_required';
  const command = providerCommand('claude');
  let version = '';
  try {
    const versionResult = await runBounded(command, ['--version']);
    if (versionResult.code !== 0) throw new Error('claude --version failed');
    version = (versionResult.stdout || versionResult.stderr).slice(0, 160);
  } catch {
    return {
      provider: 'claude', policy, installed: false, authenticated: false, authMethod: '', version: '', capable: false,
      detail: safeStatusDetail({ provider: 'claude', installed: false, authenticated: false, capable: false, policy }),
    };
  }

  const cliHelp = await helpText(command, ['--help']);
  const technicallyCapable = cliHelp.includes('--output-format')
    && cliHelp.includes('--max-turns')
    && cliHelp.includes('--permission-mode')
    && cliHelp.includes('--json-schema')
    && cliHelp.includes('--tools');
  const capable = technicallyCapable && EXPERIMENTAL_CLAUDE_CODE;

  let authenticated = false;
  let authMethod = '';
  try {
    const status = await runBounded(command, ['auth', 'status']);
    const text = `${status.stdout}\n${status.stderr}`.trim();
    try {
      const parsed = JSON.parse(status.stdout);
      authenticated = Boolean(parsed.loggedIn);
      authMethod = String(parsed.authMethod ?? parsed.apiProvider ?? '').slice(0, 80);
    } catch {
      authenticated = status.code === 0 && /logged.?in|claude\.ai|oauth/i.test(text) && !/logged.?out|not logged/i.test(text);
      if (/claude\.ai/i.test(text)) authMethod = 'claude.ai';
      else if (/oauth/i.test(text)) authMethod = 'oauth';
    }
  } catch {
    authenticated = false;
  }

  return {
    provider: 'claude', policy, installed: true, authenticated, authMethod, version, capable,
    detail: safeStatusDetail({ provider: 'claude', installed: true, authenticated, capable, policy }),
  };
}

export async function providerStatuses() {
  const [codex, claude] = await Promise.all([codexStatus(), claudeStatus()]);
  return { providers: [codex, claude], activeProviderRun: activeRun?.provider ?? null };
}

function enforceProviderPolicy(provider) {
  if (provider === 'claude' && !EXPERIMENTAL_CLAUDE_CODE) {
    throw new Error('Claude Code subscription routing is disabled for the public product; use Codex or a future supported Anthropic API provider');
  }
}

export async function launchProviderLogin(provider) {
  enforceProviderPolicy(provider);
  const command = providerCommand(provider);
  const status = provider === 'codex' ? await codexStatus() : await claudeStatus();
  if (!status.installed) throw new Error(`${provider} official client is not installed`);
  if (!status.capable) throw new Error(`${provider} official client does not meet the required integration capability`);

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

function parsePlanObject(parsed) {
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1 || !Array.isArray(parsed.steps)) {
    throw new Error('Director provider result is not an AutopilotPlan v1 object');
  }
  return parsed;
}

function parsePlanText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Error('Director provider returned an empty result');
  return parsePlanObject(JSON.parse(trimmed));
}

function toClaudeDraft7Schema(value) {
  if (Array.isArray(value)) return value.map(toClaudeDraft7Schema);
  if (!value || typeof value !== 'object') return value;
  const converted = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === '$schema' || key === '$id') continue;
    const nextKey = key === '$defs' ? 'definitions' : key;
    if (key === '$ref' && typeof child === 'string') {
      converted[nextKey] = child.replace('#/$defs/', '#/definitions/');
    } else {
      converted[nextKey] = toClaudeDraft7Schema(child);
    }
  }
  return converted;
}

async function claudeSchemaString() {
  if (!claudeSchemaPromise) {
    claudeSchemaPromise = readFile(planSchemaPath, 'utf8').then((text) => {
      const parsed = JSON.parse(text);
      return JSON.stringify(toClaudeDraft7Schema(parsed));
    });
  }
  return claudeSchemaPromise;
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
      '-',
    ];
    const result = await runBounded('codex', args, {
      input: prompt,
      timeoutMs: PLAN_TIMEOUT_MS,
      maxOutputBytes: MAX_PLAN_PROCESS_BYTES,
      env: { MAKEWATCH_DIRECTOR_MODE: '1' },
      trackPlanChild: true,
    });
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || `Codex exited with code ${result.code}`);
    }
    return parsePlanText(await readFile(outputPath, 'utf8'));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function invokeClaude(prompt) {
  enforceProviderPolicy('claude');
  const schema = await claudeSchemaString();
  const result = await runBounded('claude', [
    '-p',
    '--output-format', 'json',
    '--permission-mode', 'plan',
    '--max-turns', '1',
    '--tools', '',
    '--disallowedTools', 'mcp__*',
    '--json-schema', schema,
  ], {
    input: prompt,
    timeoutMs: PLAN_TIMEOUT_MS,
    maxOutputBytes: MAX_PLAN_PROCESS_BYTES,
    env: { MAKEWATCH_DIRECTOR_MODE: '1' },
    trackPlanChild: true,
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
  if (envelope.structured_output) return parsePlanObject(envelope.structured_output);
  if (typeof envelope.result === 'string') return parsePlanText(envelope.result);
  throw new Error('Claude Code completed without validated structured_output');
}

export async function invokeDirectorPlan(provider, prompt) {
  enforceProviderPolicy(provider);
  if (activeRun) throw new Error(`Director provider is busy with ${activeRun.provider}`);
  const status = provider === 'codex' ? await codexStatus() : await claudeStatus();
  if (!status.installed) throw new Error(`${provider} official client is not installed`);
  if (!status.authenticated) throw new Error(`${provider} official client is not authenticated`);
  if (!status.capable) throw new Error(`${provider} client does not meet required integration capability`);

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

export async function shutdownDirectorProviders() {
  const child = activePlanChild;
  if (child) {
    terminateProcessTree(child);
    await waitForProcessExit(child, PROVIDER_SHUTDOWN_WAIT_MS);
  }
  if (activePlanChild === child) activePlanChild = null;
  activeRun = null;
}
