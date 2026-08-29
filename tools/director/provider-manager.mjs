import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexAppServerClient } from './codex-app-server.mjs';
import { CodexChatSession } from './codex-chat-session.mjs';
import { ConversationStore, deriveTitle } from './conversation-store.mjs';
import {
  appendCompatibilityTranscript,
  CodexExecRuntime,
  extractUserMessage,
  parseCodexExecHelp,
  parseCodexLoginStatus,
} from './codex-exec-runtime.mjs';
import { discoverProviderExecutable, spawnProviderExecutable } from './provider-executable.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const directorRuntimeRoot = resolve(root, 'tools', 'director', 'runtime');
const planSchemaPath = resolve(root, 'schemas', 'v1', 'director-autopilot-plan.schema.json');
const conversationDirectory = resolve(root, process.env.MAKEWATCH_CONVERSATION_DIR ?? '.makewatch/conversations');

const STATUS_TIMEOUT_MS = 5_000;
const PLAN_TIMEOUT_MS = 120_000;
const PROVIDER_SHUTDOWN_WAIT_MS = 2_000;
const MAX_STATUS_BYTES = 256 * 1024;
const MAX_PLAN_PROCESS_BYTES = 2 * 1024 * 1024;
const MAX_CHAT_REPLY_CHARS = 32_000;
const EXPERIMENTAL_CLAUDE_CODE = process.env.MAKEWATCH_ENABLE_EXPERIMENTAL_CLAUDE_CODE === '1';

let activeRun = null;
let activePlanChild = null;
let activeLoginChild = null;
let codexClient = null;
let codexClientPath = '';
let codexChat = null;
let codexExecRuntime = null;
let codexExecRuntimePath = '';
let claudeSchemaPromise = null;
const codexStaticProbeCache = new Map();
const claudeStaticProbeCache = new Map();
const codexAppServerFailures = new Map();
const conversationStore = new ConversationStore({ rootDirectory: conversationDirectory });

function boundedText(value, maximum = 500) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
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

function runBounded(executable, args, {
  input = '',
  timeoutMs = STATUS_TIMEOUT_MS,
  maxOutputBytes = MAX_STATUS_BYTES,
  cwd = root,
  env = {},
  trackPlanChild = false,
} = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnProviderExecutable(executable, args, {
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
    const reject = (error) => {
      if (settled) return;
      settled = true;
      clearOwnership();
      rejectPromise(error);
    };
    const resolveResult = (value) => {
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
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const stdoutText = Buffer.concat(stdout.chunks).toString('utf8').trim();
      const stderrText = Buffer.concat(stderr.chunks).toString('utf8').trim();
      if (stdout.error) return reject(stdout.error);
      if (stderr.error) return reject(stderr.error);
      if (timedOut) return reject(new Error(`provider process timed out after ${timeoutMs} ms`));
      resolveResult({ code: code ?? -1, signal, stdout: stdoutText, stderr: stderrText });
    });

    child.stdin.end(input || undefined);
  });
}

function compactVersion(result) {
  return boundedText(result.stdout || result.stderr || '', 160);
}

function unavailableStatus(provider, policy, integration, detail) {
  return {
    provider,
    policy,
    integration,
    runtimeMode: 'none',
    installed: false,
    authenticated: false,
    authMethod: '',
    planType: '',
    version: '',
    capable: false,
    loginAvailable: false,
    planningAvailable: false,
    chatAvailable: false,
    loginPending: false,
    executableName: '',
    discovery: '',
    capabilityIssues: [],
    detail,
  };
}

async function resetCodexClient() {
  const client = codexClient;
  codexClient = null;
  codexClientPath = '';
  codexChat = null;
  if (client) await client.shutdown().catch(() => undefined);
}

async function clientForCodex(executable) {
  if (codexClient && codexClientPath === executable.path) return codexClient;
  await resetCodexClient();
  codexClient = new CodexAppServerClient({ executable });
  codexClientPath = executable.path;
  return codexClient;
}

async function chatForCodex(executable) {
  const client = await clientForCodex(executable);
  if (!codexChat) codexChat = new CodexChatSession(client);
  return codexChat;
}

function execRuntimeForCodex(executable) {
  if (codexExecRuntime && codexExecRuntimePath === executable.path) return codexExecRuntime;
  codexExecRuntime = new CodexExecRuntime({
    executable,
    runBounded,
    schemaPath: planSchemaPath,
    cwd: directorRuntimeRoot,
    timeoutMs: PLAN_TIMEOUT_MS,
    maxOutputBytes: MAX_PLAN_PROCESS_BYTES,
  });
  codexExecRuntimePath = executable.path;
  return codexExecRuntime;
}

function codexStaticProbe(executable) {
  const cached = codexStaticProbeCache.get(executable.path);
  if (cached) return cached;
  const probe = (async () => {
    const versionResult = await runBounded(executable, ['--version']);
    if (versionResult.code !== 0) throw new Error('codex --version failed');
    const [appServerHelp, execHelp] = await Promise.all([
      runBounded(executable, ['app-server', '--help']).catch((error) => ({ code: -1, stdout: '', stderr: String(error) })),
      runBounded(executable, ['exec', '--help']).catch((error) => ({ code: -1, stdout: '', stderr: String(error) })),
    ]);
    return {
      version: compactVersion(versionResult),
      appServerAdvertised: appServerHelp.code === 0,
      appServerHelpDetail: boundedText(appServerHelp.stderr || appServerHelp.stdout, 220),
      exec: parseCodexExecHelp(execHelp),
    };
  })();
  codexStaticProbeCache.set(executable.path, probe);
  return probe;
}

function claudeStaticProbe(executable) {
  const cached = claudeStaticProbeCache.get(executable.path);
  if (cached) return cached;
  const probe = (async () => {
    const [versionResult, helpResult] = await Promise.all([
      runBounded(executable, ['--version']),
      runBounded(executable, ['--help']).catch(() => ({ code: -1, stdout: '', stderr: '' })),
    ]);
    if (versionResult.code !== 0) throw new Error('claude --version failed');
    const help = `${helpResult.stdout}\n${helpResult.stderr}`;
    return {
      version: compactVersion(versionResult),
      technicallyCapable: helpResult.code === 0
        && help.includes('--output-format')
        && help.includes('--max-turns')
        && help.includes('--permission-mode')
        && help.includes('--json-schema')
        && help.includes('--tools'),
    };
  })();
  claudeStaticProbeCache.set(executable.path, probe);
  return probe;
}

async function codexCliLoginState(executable) {
  const result = await runBounded(executable, ['login', 'status']).catch((error) => ({ code: -1, stdout: '', stderr: String(error) }));
  return parseCodexLoginStatus(result);
}

async function codexStatus() {
  const policy = 'supported_local_client';
  const integration = 'codex_app_server';
  const executable = discoverProviderExecutable('codex');
  if (!executable) {
    return unavailableStatus('codex', policy, integration, 'Codex CLI was not found in PATH or common user CLI locations');
  }

  let probe;
  try {
    probe = await codexStaticProbe(executable);
  } catch {
    return {
      ...unavailableStatus('codex', policy, integration, 'Codex CLI was found but could not be launched by the local bridge'),
      installed: true,
      executableName: executable.name,
      discovery: executable.discovery,
    };
  }

  if (probe.appServerAdvertised && !codexAppServerFailures.has(executable.path)) {
    try {
      const client = await clientForCodex(executable);
      const accountState = await client.accountRead();
      const account = accountState.account;
      const chatGptConnected = account?.type === 'chatgpt';
      const planType = chatGptConnected ? String(account.planType ?? '').slice(0, 40) : '';
      const authMethod = account?.type ? String(account.type).slice(0, 60) : '';
      const capabilityIssues = [];
      if (account && account.type !== 'chatgpt') {
        capabilityIssues.push('Codex is authenticated with a non-ChatGPT credential; connect ChatGPT to use subscription access');
      }
      return {
        provider: 'codex',
        policy,
        integration,
        runtimeMode: 'app_server',
        installed: true,
        authenticated: chatGptConnected,
        authMethod: chatGptConnected ? 'chatgpt' : authMethod,
        planType,
        version: probe.version,
        capable: true,
        loginAvailable: !chatGptConnected,
        planningAvailable: chatGptConnected,
        chatAvailable: chatGptConnected,
        loginPending: Boolean(client.loginState && !client.loginState.failed),
        executableName: executable.name,
        discovery: executable.discovery,
        capabilityIssues,
        detail: chatGptConnected
          ? `Codex App Server is connected through ChatGPT${planType ? ` · ${planType}` : ''} and ready for Director chat + planning`
          : account
            ? 'Codex App Server is ready; connect ChatGPT to switch this Director to subscription access'
            : 'Codex App Server is ready for first-party ChatGPT sign-in',
      };
    } catch (error) {
      const detail = boundedText(error instanceof Error ? error.message : error, 240);
      codexAppServerFailures.set(executable.path, detail);
      await resetCodexClient();
    }
  }

  const login = await codexCliLoginState(executable);
  const capabilityIssues = [];
  const appServerFailure = codexAppServerFailures.get(executable.path);
  if (appServerFailure) capabilityIssues.push(`App Server unavailable; using official Codex CLI compatibility mode. ${appServerFailure}`);
  else if (!probe.appServerAdvertised) capabilityIssues.push('This Codex build does not advertise App Server; using official Codex CLI compatibility mode.');
  if (!probe.exec.chatAvailable) capabilityIssues.push('Codex exec must support read-only sandbox + final-message output for compatibility chat.');
  if (!probe.exec.planAvailable) capabilityIssues.push('Codex exec must support output-schema for typed Director plan previews.');

  const capable = probe.exec.chatAvailable;
  const authenticated = login.authenticated;
  return {
    provider: 'codex',
    policy,
    integration,
    runtimeMode: capable ? 'exec_fallback' : 'none',
    installed: true,
    authenticated,
    authMethod: login.authMethod,
    planType: '',
    version: probe.version,
    capable,
    loginAvailable: capable && !authenticated,
    planningAvailable: capable && authenticated && probe.exec.planAvailable,
    chatAvailable: capable && authenticated,
    loginPending: Boolean(activeLoginChild && activeLoginChild.exitCode === null),
    executableName: executable.name,
    discovery: executable.discovery,
    capabilityIssues,
    detail: capable
      ? authenticated
        ? 'Codex is connected through the official CLI session. Make & Watch is using bounded read-only exec compatibility mode because App Server is unavailable.'
        : 'Codex compatibility runtime is ready; complete the official Codex ChatGPT sign-in to enable Director chat.'
      : 'Codex CLI is detected, but neither App Server nor the bounded exec compatibility runtime is usable in this installed build.',
  };
}

async function claudeStatus() {
  const policy = EXPERIMENTAL_CLAUDE_CODE ? 'experimental_local_client' : 'api_required';
  const integration = EXPERIMENTAL_CLAUDE_CODE ? 'claude_code_preview' : 'anthropic_api_required';
  const executable = discoverProviderExecutable('claude');
  if (!executable) {
    return unavailableStatus(
      'claude',
      policy,
      integration,
      EXPERIMENTAL_CLAUDE_CODE
        ? 'Claude Code was not found in PATH or common user CLI locations'
        : 'Production Claude integration requires a supported Anthropic API/Console path',
    );
  }

  let probe;
  try {
    probe = await claudeStaticProbe(executable);
  } catch {
    return {
      ...unavailableStatus('claude', policy, integration, 'Claude CLI was found but could not be launched by the local bridge'),
      installed: true,
      executableName: executable.name,
      discovery: executable.discovery,
    };
  }

  let authenticated = false;
  let authMethod = '';
  if (EXPERIMENTAL_CLAUDE_CODE && probe.technicallyCapable) {
    try {
      const status = await runBounded(executable, ['auth', 'status']);
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
  }

  const capabilityIssues = [];
  if (!EXPERIMENTAL_CLAUDE_CODE) capabilityIssues.push('Public product integration requires an Anthropic API/Console provider');
  else if (!probe.technicallyCapable) capabilityIssues.push('Claude Code must be updated for bounded structured-output planning');

  return {
    provider: 'claude',
    policy,
    integration,
    runtimeMode: 'none',
    installed: true,
    authenticated: EXPERIMENTAL_CLAUDE_CODE && authenticated,
    authMethod: EXPERIMENTAL_CLAUDE_CODE ? authMethod : '',
    planType: '',
    version: probe.version,
    capable: EXPERIMENTAL_CLAUDE_CODE && probe.technicallyCapable,
    loginAvailable: EXPERIMENTAL_CLAUDE_CODE && probe.technicallyCapable && !authenticated,
    planningAvailable: EXPERIMENTAL_CLAUDE_CODE && probe.technicallyCapable && authenticated,
    chatAvailable: false,
    loginPending: false,
    executableName: executable.name,
    discovery: executable.discovery,
    capabilityIssues,
    detail: EXPERIMENTAL_CLAUDE_CODE
      ? probe.technicallyCapable
        ? authenticated
          ? 'Developer-preview Claude Code bridge is authenticated for bounded plan previews; chat is not enabled in this product path'
          : 'Developer-preview Claude Code bridge is ready for first-party sign-in'
        : 'Claude Code is detected but must be updated for the developer-preview bridge'
      : 'Claude Code is detected locally; production product use requires a supported Anthropic API/Console provider',
  };
}

export async function providerStatuses() {
  const [codex, claude] = await Promise.all([codexStatus(), claudeStatus()]);
  return { providers: [codex, claude], activeProviderRun: activeRun?.provider ?? null };
}

function enforceProviderPolicy(provider) {
  if (provider === 'claude' && !EXPERIMENTAL_CLAUDE_CODE) {
    throw new Error('Claude Code subscription routing is disabled for the public product; configure a supported Anthropic API provider instead');
  }
}

export async function launchProviderLogin(provider) {
  enforceProviderPolicy(provider);

  if (provider === 'codex') {
    const executable = discoverProviderExecutable('codex');
    if (!executable) throw new Error('Codex official client is not installed');
    const status = await codexStatus();
    if (status.authenticated) {
      return {
        provider: 'codex',
        launched: false,
        command: status.runtimeMode === 'app_server' ? 'codex app-server' : 'codex login status',
        loginMode: 'none',
        loginId: null,
        authUrl: null,
        message: 'Codex is already connected through the official local ChatGPT session.',
      };
    }

    if (status.runtimeMode === 'app_server') {
      const client = await clientForCodex(executable);
      const result = await client.startChatGptLogin();
      if (result.alreadyConnected) {
        return {
          provider: 'codex',
          launched: false,
          command: 'codex app-server',
          loginMode: 'browser',
          loginId: null,
          authUrl: null,
          message: 'Codex is already connected through ChatGPT.',
        };
      }
      return {
        provider: 'codex',
        launched: true,
        command: 'codex app-server · account/login/start',
        loginMode: 'browser',
        loginId: result.loginId,
        authUrl: result.authUrl,
        message: 'Continue in the official ChatGPT sign-in page. Codex App Server owns and refreshes the OAuth session; Make & Watch never receives the token.',
      };
    }

    if (!status.capable) throw new Error(status.detail);
    if (activeLoginChild && activeLoginChild.exitCode === null) {
      return {
        provider: 'codex',
        launched: true,
        command: 'codex login',
        loginMode: 'cli',
        loginId: null,
        authUrl: null,
        message: 'Official Codex ChatGPT sign-in is already in progress.',
      };
    }
    const child = spawnProviderExecutable(executable, ['login'], {
      cwd: root,
      windowsHide: false,
      stdio: 'ignore',
      env: process.env,
    });
    activeLoginChild = child;
    child.once('close', () => {
      if (activeLoginChild === child) activeLoginChild = null;
    });
    return {
      provider: 'codex',
      launched: true,
      command: 'codex login',
      loginMode: 'cli',
      loginId: null,
      authUrl: null,
      message: 'The official Codex CLI sign-in flow was started. Complete the ChatGPT browser flow; Make & Watch never receives the credential.',
    };
  }

  const status = await claudeStatus();
  const executable = discoverProviderExecutable('claude');
  if (!status.installed || !executable) throw new Error('Claude Code official client is not installed');
  if (!status.capable) throw new Error('Claude Code client does not meet the developer-preview integration capability');

  const child = spawnProviderExecutable(executable, ['auth', 'login'], {
    cwd: root,
    detached: true,
    windowsHide: false,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  return {
    provider: 'claude',
    launched: true,
    command: `${executable.name} auth login`,
    loginMode: 'cli',
    loginId: null,
    authUrl: null,
    message: 'Developer-preview authentication remains inside Claude Code. Make & Watch does not receive Claude credentials.',
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
    if (key === '$ref' && typeof child === 'string') converted[nextKey] = child.replace('#/$defs/', '#/definitions/');
    else converted[nextKey] = toClaudeDraft7Schema(child);
  }
  return converted;
}

async function claudeSchemaString() {
  if (!claudeSchemaPromise) {
    claudeSchemaPromise = readFile(planSchemaPath, 'utf8').then((text) => JSON.stringify(toClaudeDraft7Schema(JSON.parse(text))));
  }
  return claudeSchemaPromise;
}

async function invokeCodex(prompt, status) {
  const executable = discoverProviderExecutable('codex');
  if (!executable) throw new Error('Codex official client is no longer available');
  if (status.runtimeMode === 'app_server') {
    const client = await clientForCodex(executable);
    return client.runDirectorPlan(prompt);
  }
  return execRuntimeForCodex(executable).plan(prompt);
}

async function invokeClaude(prompt) {
  enforceProviderPolicy('claude');
  const executable = discoverProviderExecutable('claude');
  if (!executable) throw new Error('Claude Code official client is no longer available');
  const schema = await claudeSchemaString();
  const result = await runBounded(executable, [
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
  if (result.code !== 0) throw new Error(result.stderr || result.stdout || `Claude exited with code ${result.code}`);

  let envelope;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    throw new Error('Claude Code did not return its documented JSON print envelope');
  }
  if (envelope.is_error === true) throw new Error(String(envelope.result ?? 'Claude Code reported an error'));
  if (envelope.structured_output) return parsePlanObject(envelope.structured_output);
  if (typeof envelope.result === 'string') return parsePlanText(envelope.result);
  throw new Error('Claude Code completed without validated structured_output');
}

export async function invokeDirectorPlan(provider, prompt) {
  enforceProviderPolicy(provider);
  if (activeRun) throw new Error(`Director provider is busy with ${activeRun.provider}`);
  const status = provider === 'codex' ? await codexStatus() : await claudeStatus();
  if (!status.installed) throw new Error(`${provider} official client is not installed`);
  if (!status.planningAvailable) {
    if (provider === 'codex' && status.loginAvailable) throw new Error('Codex is ready but ChatGPT sign-in is still required');
    throw new Error(`${provider} is not ready for Director planning: ${status.detail}`);
  }

  const run = { provider, kind: 'plan', startedAt: Date.now() };
  activeRun = run;
  try {
    const plan = provider === 'codex' ? await invokeCodex(prompt, status) : await invokeClaude(prompt);
    if (plan.provider !== provider) {
      throw new Error(`Director plan provider mismatch: expected ${provider}, got ${String(plan.provider)}`);
    }
    return plan;
  } finally {
    if (activeRun === run) activeRun = null;
  }
}

function compatibilityTranscript(document) {
  let transcript = [];
  for (const message of document.messages) {
    if (message.delivery === 'failed') continue;
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    transcript = appendCompatibilityTranscript(transcript, message.role, message.text);
  }
  return transcript;
}

async function codexConversationTools() {
  const executable = discoverProviderExecutable('codex');
  if (!executable) return { executable: null, chat: null };
  return { executable, chat: await chatForCodex(executable) };
}

async function ensureProviderThreadAvailable(document) {
  if (document.runtimeMode !== 'app_server' || !document.providerThreadId) return document;
  const { chat } = await codexConversationTools();
  if (!chat) return document;
  if (document.providerThreadArchived) {
    try {
      await chat.unarchiveThread(document.providerThreadId);
      await conversationStore.setProviderState(document.id, {
        runtimeMode: document.runtimeMode,
        providerThreadId: document.providerThreadId,
        providerThreadArchived: false,
      });
      return { ...document, providerThreadArchived: false };
    } catch {
      return document;
    }
  }
  return document;
}

export async function invokeDirectorChat(provider, prompt, conversationId = null, options = {}) {
  if (provider !== 'codex') {
    enforceProviderPolicy(provider);
    throw new Error('Director chat is currently implemented for the supported Codex local-client path; Claude chat will use the future supported Anthropic API provider');
  }
  if (activeRun) throw new Error(`Director provider is busy with ${activeRun.provider}`);

  const status = await codexStatus();
  if (!status.chatAvailable) {
    if (status.loginAvailable) throw new Error('Codex is ready but ChatGPT sign-in is required before chat');
    throw new Error(`Codex is not ready for Director chat: ${status.detail}`);
  }

  const executable = discoverProviderExecutable('codex');
  if (!executable) throw new Error('Codex official client is no longer available');

  const userMessage = boundedText(options.userMessage ?? extractUserMessage(prompt), 6_000);
  const projectRevision = Number.isSafeInteger(options.projectRevision) && options.projectRevision >= 0
    ? options.projectRevision
    : null;

  let conversation;
  let created = false;
  if (conversationId) {
    conversation = await conversationStore.read(conversationId);
    if (conversation.archivedAt) throw new Error('Director conversation is archived; restore it before sending a new message');
    if (conversation.provider !== provider) throw new Error('Director conversation provider mismatch');
    conversation = await ensureProviderThreadAvailable(conversation);
  } else {
    const summary = await conversationStore.create({
      provider,
      runtimeMode: status.runtimeMode,
      title: deriveTitle(userMessage),
      projectRevision,
    });
    conversation = await conversationStore.read(summary.id);
    created = true;
    if (conversation.runtimeMode === 'app_server') {
      const chat = await chatForCodex(executable);
      const providerThreadId = await chat.createThread();
      await conversationStore.setProviderState(conversation.id, {
        runtimeMode: 'app_server',
        providerThreadId,
        providerThreadArchived: false,
      });
      conversation = await conversationStore.read(conversation.id);
    }
  }

  const run = { provider, kind: 'chat', conversationId: conversation.id, startedAt: Date.now() };
  activeRun = run;
  try {
    let rawReply;
    let runtimeMode = conversation.runtimeMode;
    let providerThreadId = conversation.providerThreadId;

    if (runtimeMode === 'app_server' && providerThreadId) {
      try {
        const chat = await chatForCodex(executable);
        rawReply = await chat.send(providerThreadId, prompt);
      } catch (error) {
        const probe = await codexStaticProbe(executable);
        if (!probe.exec.chatAvailable) throw error;
        runtimeMode = 'exec_fallback';
        providerThreadId = null;
        codexAppServerFailures.set(executable.path, boundedText(error instanceof Error ? error.message : error, 240));
        await resetCodexClient();
        rawReply = await execRuntimeForCodex(executable).chat(prompt, compatibilityTranscript(conversation));
      }
    } else {
      runtimeMode = 'exec_fallback';
      providerThreadId = null;
      rawReply = await execRuntimeForCodex(executable).chat(prompt, compatibilityTranscript(conversation));
    }

    const reply = rawReply.length <= MAX_CHAT_REPLY_CHARS
      ? rawReply
      : `${rawReply.slice(0, MAX_CHAT_REPLY_CHARS - 1)}…`;
    const summary = await conversationStore.appendTurn(conversation.id, {
      userText: userMessage,
      assistantText: reply,
      projectRevision,
      runtimeMode,
      providerThreadId,
    });

    if (created && runtimeMode === 'app_server' && providerThreadId) {
      const chat = await chatForCodex(executable);
      await chat.nameThread(providerThreadId, summary.title).catch(() => undefined);
    }

    return {
      conversationId: conversation.id,
      provider,
      reply,
      turnCount: summary.turnCount,
      title: summary.title,
      updatedAt: summary.updatedAt,
      runtimeMode: summary.runtimeMode,
    };
  } catch (error) {
    await conversationStore.appendFailure(conversation.id, {
      userText: userMessage || 'Director request',
      message: error instanceof Error ? error.message : String(error),
      projectRevision,
    }).catch(() => undefined);
    throw error;
  } finally {
    if (activeRun === run) activeRun = null;
  }
}

export async function listDirectorConversations({ archived = false, limit = 100 } = {}) {
  return { conversations: await conversationStore.list({ archived, limit }) };
}

export async function readDirectorConversation(conversationId) {
  return { conversation: await conversationStore.read(conversationId) };
}

export async function renameDirectorConversation(conversationId, title) {
  if (activeRun?.conversationId === conversationId) throw new Error('Director conversation is busy');
  const summary = await conversationStore.rename(conversationId, title);
  let providerWarning = '';
  if (summary.runtimeMode === 'app_server' && summary.providerThreadId) {
    try {
      const { chat } = await codexConversationTools();
      await chat?.nameThread(summary.providerThreadId, summary.title);
    } catch (error) {
      providerWarning = boundedText(error instanceof Error ? error.message : error, 240);
    }
  }
  return { conversation: summary, providerWarning };
}

export async function archiveDirectorConversation(conversationId) {
  if (activeRun?.conversationId === conversationId) throw new Error('Director conversation is busy');
  const document = await conversationStore.read(conversationId);
  let providerArchived = document.providerThreadArchived;
  let providerWarning = '';
  if (document.runtimeMode === 'app_server' && document.providerThreadId && !providerArchived) {
    try {
      const { chat } = await codexConversationTools();
      if (chat) {
        await chat.archiveThread(document.providerThreadId);
        providerArchived = true;
      }
    } catch (error) {
      providerWarning = boundedText(error instanceof Error ? error.message : error, 240);
    }
  }
  const summary = await conversationStore.archive(conversationId, providerArchived);
  return { conversation: summary, providerWarning };
}

export async function unarchiveDirectorConversation(conversationId) {
  if (activeRun?.conversationId === conversationId) throw new Error('Director conversation is busy');
  const document = await conversationStore.read(conversationId);
  let providerArchived = document.providerThreadArchived;
  let providerWarning = '';
  if (document.runtimeMode === 'app_server' && document.providerThreadId && providerArchived) {
    try {
      const { chat } = await codexConversationTools();
      if (chat) {
        await chat.unarchiveThread(document.providerThreadId);
        providerArchived = false;
      }
    } catch (error) {
      providerWarning = boundedText(error instanceof Error ? error.message : error, 240);
    }
  }
  const summary = await conversationStore.unarchive(conversationId, providerArchived);
  return { conversation: summary, providerWarning };
}

export async function deleteDirectorConversation(conversationId) {
  if (activeRun?.conversationId === conversationId) throw new Error('Director conversation is busy');
  const document = await conversationStore.read(conversationId);
  let providerWarning = '';
  if (document.runtimeMode === 'app_server' && document.providerThreadId) {
    try {
      const { chat } = await codexConversationTools();
      await chat?.deleteThread(document.providerThreadId);
    } catch (error) {
      providerWarning = boundedText(error instanceof Error ? error.message : error, 240);
    }
  }
  const deleted = await conversationStore.delete(conversationId);
  return { deleted: true, conversation: deleted, providerWarning };
}

export async function closeDirectorConversation(provider, conversationId) {
  if (typeof conversationId !== 'string' || !conversationId) return { closed: false };
  const conversation = await conversationStore.read(conversationId).catch(() => null);
  if (!conversation) return { closed: false };
  if (conversation.provider !== provider) throw new Error('Director conversation provider mismatch');
  if (conversation.runtimeMode === 'app_server' && conversation.providerThreadId) {
    const executable = discoverProviderExecutable('codex');
    if (executable) {
      const chat = await chatForCodex(executable);
      await chat.unsubscribeThread(conversation.providerThreadId).catch(() => undefined);
    }
  }
  return { closed: true };
}

export async function shutdownDirectorProviders() {
  const chat = codexChat;
  if (chat) await chat.shutdown().catch(() => undefined);
  codexChat = null;

  await resetCodexClient();
  codexExecRuntime = null;
  codexExecRuntimePath = '';

  const planChild = activePlanChild;
  if (planChild) {
    terminateProcessTree(planChild);
    await waitForProcessExit(planChild, PROVIDER_SHUTDOWN_WAIT_MS);
  }
  if (activePlanChild === planChild) activePlanChild = null;

  const loginChild = activeLoginChild;
  if (loginChild) {
    terminateProcessTree(loginChild);
    await waitForProcessExit(loginChild, PROVIDER_SHUTDOWN_WAIT_MS);
  }
  if (activeLoginChild === loginChild) activeLoginChild = null;
  activeRun = null;
}
