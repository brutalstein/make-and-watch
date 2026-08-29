import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CodexAppServerClient } from './codex-app-server.mjs';
import { CodexChatSession } from './codex-chat-session.mjs';
import { discoverProviderExecutable, spawnProviderExecutable } from './provider-executable.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const planSchemaPath = resolve(root, 'schemas', 'v1', 'director-autopilot-plan.schema.json');

const STATUS_TIMEOUT_MS = 5_000;
const PLAN_TIMEOUT_MS = 120_000;
const PROVIDER_SHUTDOWN_WAIT_MS = 2_000;
const MAX_STATUS_BYTES = 256 * 1024;
const MAX_PLAN_PROCESS_BYTES = 2 * 1024 * 1024;
const MAX_CHAT_REPLY_CHARS = 32_000;
const MAX_DIRECTOR_CONVERSATIONS = 4;
const EXPERIMENTAL_CLAUDE_CODE = process.env.MAKEWATCH_ENABLE_EXPERIMENTAL_CLAUDE_CODE === '1';

let activeRun = null;
let activePlanChild = null;
let codexClient = null;
let codexClientPath = '';
let codexChat = null;
let claudeSchemaPromise = null;
const conversations = new Map();

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
  return String(result.stdout || result.stderr || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 160);
}

function unavailableStatus(provider, policy, integration, detail) {
  return {
    provider,
    policy,
    integration,
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

function resetCodexConversationState() {
  conversations.clear();
  codexChat = null;
}

async function clientForCodex(executable) {
  if (codexClient && codexClientPath === executable.path) return codexClient;
  if (codexClient) await codexClient.shutdown().catch(() => undefined);
  resetCodexConversationState();
  codexClient = new CodexAppServerClient({ executable });
  codexClientPath = executable.path;
  return codexClient;
}

async function chatForCodex(executable) {
  const client = await clientForCodex(executable);
  if (!codexChat) codexChat = new CodexChatSession(client);
  return codexChat;
}

async function codexStatus() {
  const policy = 'supported_local_client';
  const integration = 'codex_app_server';
  const executable = discoverProviderExecutable('codex');
  if (!executable) {
    return unavailableStatus('codex', policy, integration, 'Codex CLI was not found in PATH or common user CLI locations');
  }

  let version = '';
  try {
    const versionResult = await runBounded(executable, ['--version']);
    if (versionResult.code !== 0) throw new Error('codex --version failed');
    version = compactVersion(versionResult);
  } catch {
    return {
      ...unavailableStatus('codex', policy, integration, 'Codex CLI was found but could not be launched by the local bridge'),
      installed: true,
      executableName: executable.name,
      discovery: executable.discovery,
    };
  }

  let client;
  let accountState;
  try {
    client = await clientForCodex(executable);
    accountState = await client.accountRead();
  } catch {
    return {
      provider: 'codex',
      policy,
      integration,
      installed: true,
      authenticated: false,
      authMethod: '',
      planType: '',
      version,
      capable: false,
      loginAvailable: false,
      planningAvailable: false,
      chatAvailable: false,
      loginPending: false,
      executableName: executable.name,
      discovery: executable.discovery,
      capabilityIssues: ['Codex app-server is unavailable; update the official Codex client'],
      detail: 'Codex CLI is detected, but its product-embedding app-server could not be initialized',
    };
  }

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
    installed: true,
    authenticated: chatGptConnected,
    authMethod: chatGptConnected ? 'chatgpt' : authMethod,
    planType,
    version,
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

  let version = '';
  try {
    const versionResult = await runBounded(executable, ['--version']);
    if (versionResult.code !== 0) throw new Error('claude --version failed');
    version = compactVersion(versionResult);
  } catch {
    return {
      ...unavailableStatus('claude', policy, integration, 'Claude CLI was found but could not be launched by the local bridge'),
      installed: true,
      executableName: executable.name,
      discovery: executable.discovery,
    };
  }

  const cliHelp = await runBounded(executable, ['--help']).catch(() => ({ code: -1, stdout: '', stderr: '' }));
  const help = `${cliHelp.stdout}\n${cliHelp.stderr}`;
  const technicallyCapable = cliHelp.code === 0
    && help.includes('--output-format')
    && help.includes('--max-turns')
    && help.includes('--permission-mode')
    && help.includes('--json-schema')
    && help.includes('--tools');

  let authenticated = false;
  let authMethod = '';
  if (EXPERIMENTAL_CLAUDE_CODE && technicallyCapable) {
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
  else if (!technicallyCapable) capabilityIssues.push('Claude Code must be updated for bounded structured-output planning');

  return {
    provider: 'claude',
    policy,
    integration,
    installed: true,
    authenticated: EXPERIMENTAL_CLAUDE_CODE && authenticated,
    authMethod: EXPERIMENTAL_CLAUDE_CODE ? authMethod : '',
    planType: '',
    version,
    capable: EXPERIMENTAL_CLAUDE_CODE && technicallyCapable,
    loginAvailable: EXPERIMENTAL_CLAUDE_CODE && technicallyCapable && !authenticated,
    planningAvailable: EXPERIMENTAL_CLAUDE_CODE && technicallyCapable && authenticated,
    chatAvailable: false,
    loginPending: false,
    executableName: executable.name,
    discovery: executable.discovery,
    capabilityIssues,
    detail: EXPERIMENTAL_CLAUDE_CODE
      ? technicallyCapable
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

async function invokeCodex(prompt) {
  const executable = discoverProviderExecutable('codex');
  if (!executable) throw new Error('Codex official client is no longer available');
  const client = await clientForCodex(executable);
  return client.runDirectorPlan(prompt);
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
    const plan = provider === 'codex' ? await invokeCodex(prompt) : await invokeClaude(prompt);
    if (plan.provider !== provider) {
      throw new Error(`Director plan provider mismatch: expected ${provider}, got ${String(plan.provider)}`);
    }
    return plan;
  } finally {
    if (activeRun === run) activeRun = null;
  }
}

async function evictOldestConversation(chat) {
  if (conversations.size < MAX_DIRECTOR_CONVERSATIONS) return;
  const oldest = [...conversations.values()].sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
  if (!oldest) return;
  conversations.delete(oldest.id);
  await chat.deleteThread(oldest.threadId).catch(() => undefined);
}

export async function invokeDirectorChat(provider, prompt, conversationId = null) {
  if (provider !== 'codex') {
    enforceProviderPolicy(provider);
    throw new Error('Director chat is currently implemented for the supported Codex App Server path; Claude chat will use the future supported Anthropic API provider');
  }
  if (activeRun) throw new Error(`Director provider is busy with ${activeRun.provider}`);

  const status = await codexStatus();
  if (!status.chatAvailable) {
    if (status.loginAvailable) throw new Error('Codex App Server is ready but ChatGPT sign-in is required before chat');
    throw new Error(`Codex is not ready for Director chat: ${status.detail}`);
  }

  const executable = discoverProviderExecutable('codex');
  if (!executable) throw new Error('Codex official client is no longer available');
  const chat = await chatForCodex(executable);

  let conversation = conversationId ? conversations.get(conversationId) : null;
  if (conversationId && !conversation) throw new Error('Director conversation is no longer active; start a new chat');
  if (conversation && conversation.provider !== provider) throw new Error('Director conversation provider mismatch');

  let created = false;
  if (!conversation) {
    await evictOldestConversation(chat);
    conversation = {
      id: randomUUID(),
      provider,
      threadId: await chat.createThread(),
      turnCount: 0,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    conversations.set(conversation.id, conversation);
    created = true;
  }

  const run = { provider, kind: 'chat', startedAt: Date.now() };
  activeRun = run;
  try {
    const rawReply = await chat.send(conversation.threadId, prompt);
    const reply = rawReply.length <= MAX_CHAT_REPLY_CHARS
      ? rawReply
      : `${rawReply.slice(0, MAX_CHAT_REPLY_CHARS - 1)}…`;
    conversation.turnCount += 1;
    conversation.lastUsedAt = Date.now();
    return { conversationId: conversation.id, provider, reply, turnCount: conversation.turnCount };
  } catch (error) {
    if (created) {
      conversations.delete(conversation.id);
      await chat.deleteThread(conversation.threadId).catch(() => undefined);
    }
    throw error;
  } finally {
    if (activeRun === run) activeRun = null;
  }
}

export async function closeDirectorConversation(provider, conversationId) {
  if (typeof conversationId !== 'string' || !conversationId) return { closed: false };
  const conversation = conversations.get(conversationId);
  if (!conversation) return { closed: false };
  if (conversation.provider !== provider) throw new Error('Director conversation provider mismatch');
  conversations.delete(conversationId);

  if (provider === 'codex') {
    const executable = discoverProviderExecutable('codex');
    if (executable) {
      const chat = await chatForCodex(executable);
      await chat.deleteThread(conversation.threadId).catch(() => undefined);
    }
  }
  return { closed: true };
}

export async function shutdownDirectorProviders() {
  const chat = codexChat;
  if (chat) {
    await chat.shutdown().catch(() => undefined);
    for (const conversation of conversations.values()) {
      await chat.deleteThread(conversation.threadId).catch(() => undefined);
    }
  }
  conversations.clear();
  codexChat = null;

  const client = codexClient;
  codexClient = null;
  codexClientPath = '';
  if (client) await client.shutdown().catch(() => undefined);

  const child = activePlanChild;
  if (child) {
    terminateProcessTree(child);
    await waitForProcessExit(child, PROVIDER_SHUTDOWN_WAIT_MS);
  }
  if (activePlanChild === child) activePlanChild = null;
  activeRun = null;
}
