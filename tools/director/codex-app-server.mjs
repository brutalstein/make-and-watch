import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import {
  configuredMakeWatchDynamicToolSpecs,
  handleConfiguredMakeWatchToolCall,
} from './makewatch-tool-runtime.mjs';
import { spawnProviderExecutable } from './provider-executable.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const directorRuntimeRoot = resolve(root, 'tools', 'director', 'runtime');
const planSchemaPath = resolve(root, 'schemas', 'v1', 'director-autopilot-plan.schema.json');

const REQUEST_TIMEOUT_MS = 8_000;
// A makewatch tool call reaches the native engine and, for generation tools,
// the local media gateway. 20s was tight enough that legitimate multi-command
// project mutations were reported to Codex as tool failures.
const TOOL_TIMEOUT_MS = Number(process.env.MAKEWATCH_DIRECTOR_TOOL_TIMEOUT_MS ?? 120_000);
const PLAN_TIMEOUT_MS = Number(process.env.MAKEWATCH_DIRECTOR_PLAN_TIMEOUT_MS ?? 300_000);
const INTERRUPT_GRACE_MS = 2_500;
const SHUTDOWN_GRACE_MS = 2_000;
const MAX_PROTOCOL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_PROTOCOL_WRITE_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const BUILT_IN_READ_ONLY_PERMISSION_PROFILE = ':read-only';
const LEGACY_THREAD_READ_ONLY_SANDBOX = 'read-only';
const LEGACY_TURN_READ_ONLY_SANDBOX = 'readOnly';

let planSchemaPromise = null;

function planSchema() {
  if (!planSchemaPromise) {
    planSchemaPromise = readFile(planSchemaPath, 'utf8').then((text) => JSON.parse(text));
  }
  return planSchemaPromise;
}

function safeMessage(value, fallback = 'Codex app-server request failed') {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  return (text || fallback).slice(0, 500);
}

function protocolError(message, fallback) {
  const error = new Error(safeMessage(message?.error?.message, fallback));
  if (Number.isInteger(message?.error?.code)) error.code = message.error.code;
  return error;
}

function isUnsupportedMethod(error) {
  return error?.code === -32601 || /method not found|unknown method|experimental api.*disabled|not supported/i.test(String(error?.message ?? ''));
}

function sanitizeAccount(result) {
  const account = result?.account;
  if (!account || typeof account !== 'object') {
    return { account: null, requiresOpenaiAuth: Boolean(result?.requiresOpenaiAuth) };
  }
  if (account.type === 'chatgpt') {
    return {
      account: {
        type: 'chatgpt',
        planType: typeof account.planType === 'string' ? account.planType.slice(0, 40) : '',
      },
      requiresOpenaiAuth: Boolean(result?.requiresOpenaiAuth),
    };
  }
  return {
    account: { type: String(account.type ?? 'unknown').slice(0, 60) },
    requiresOpenaiAuth: Boolean(result?.requiresOpenaiAuth),
  };
}

function parsePlanText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Error('Codex completed without a Director plan');
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1 || !Array.isArray(parsed.steps)) {
    throw new Error('Codex result is not an AutopilotPlan v1 object');
  }
  return parsed;
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

function waitForExit(child, timeoutMs) {
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

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
    timer.unref();
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

export class CodexAppServerClient extends EventEmitter {
  constructor({ executable, processFactory = null, dynamicTools = null, dynamicToolHandler = null } = {}) {
    super();
    if (!executable) throw new Error('Codex app-server requires a resolved executable');
    this.executable = executable;
    this.processFactory = processFactory;
    this.dynamicTools = Array.isArray(dynamicTools) ? dynamicTools : null;
    this.dynamicToolHandler = typeof dynamicToolHandler === 'function' ? dynamicToolHandler : null;
    this.child = null;
    this.reader = null;
    this.readyPromise = null;
    this.initialized = false;
    this.shuttingDown = false;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.activeTurn = null;
    this.pendingLogin = null;
    this.stderrTail = '';
    this.permissionMode = 'unknown';
    this.permissionProfileId = null;
  }

  get isRunning() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  get loginState() {
    return this.pendingLogin ? { ...this.pendingLogin } : null;
  }

  get readOnlyPermissionMode() {
    return this.permissionMode;
  }

  dynamicToolSpecs() {
    if (this.dynamicTools) return this.dynamicToolHandler ? this.dynamicTools : [];
    return configuredMakeWatchDynamicToolSpecs();
  }

  readOnlyThreadSecurityParams() {
    if (this.permissionMode === 'profile' && this.permissionProfileId) {
      return { permissions: this.permissionProfileId };
    }
    return { sandbox: LEGACY_THREAD_READ_ONLY_SANDBOX };
  }

  readOnlyTurnSecurityParams() {
    if (this.permissionMode === 'profile' && this.permissionProfileId) {
      return { permissions: this.permissionProfileId };
    }
    return { sandboxPolicy: { type: LEGACY_TURN_READ_ONLY_SANDBOX } };
  }

  async start() {
    if (this.initialized && this.isRunning) return;
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.#startInternal();
    try {
      await this.readyPromise;
    } catch (error) {
      this.readyPromise = null;
      throw error;
    }
  }

  async #startInternal() {
    this.shuttingDown = false;
    this.permissionMode = 'unknown';
    this.permissionProfileId = null;
    const options = {
      cwd: root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    };
    const child = this.processFactory
      ? this.processFactory(this.executable, ['app-server'], options)
      : spawnProviderExecutable(this.executable, ['app-server'], options);
    this.child = child;

    child.stdout.setEncoding?.('utf8');
    child.stderr.setEncoding?.('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${String(chunk)}`.slice(-MAX_STDERR_BYTES);
    });
    child.on('error', (error) => this.#failConnection(error));
    child.on('close', (code, signal) => {
      this.#failConnection(new Error(
        this.shuttingDown
          ? 'Codex app-server stopped'
          : `Codex app-server exited unexpectedly (${code ?? 'null'} / ${signal ?? 'no-signal'})`,
      ));
    });

    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => this.#handleLine(line));

    try {
      await this.request('initialize', {
        clientInfo: { name: 'make_and_watch', title: 'Make & Watch', version: '0.1.0' },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: [
            'item/agentMessage/delta',
            'item/reasoning/summaryTextDelta',
            'item/reasoning/textDelta',
            'item/commandExecution/outputDelta',
          ],
        },
      }, 12_000);
      this.notify('initialized', {});
      await this.#negotiateReadOnlyPermissionMode();
      this.initialized = true;
    } catch (error) {
      terminateProcessTree(child);
      throw new Error(`Codex app-server initialization failed: ${safeMessage(error instanceof Error ? error.message : error)}`);
    }
  }

  async #negotiateReadOnlyPermissionMode() {
    try {
      const result = await this.request('permissionProfile/list', {
        cwd: directorRuntimeRoot,
        limit: 64,
      }, REQUEST_TIMEOUT_MS);
      const profiles = Array.isArray(result?.data) ? result.data : [];
      const readOnly = profiles.find((profile) => profile?.id === BUILT_IN_READ_ONLY_PERMISSION_PROFILE);
      if (!readOnly) throw new Error('Codex did not advertise the built-in :read-only permission profile');
      if (readOnly.allowed !== true) throw new Error('Codex policy does not allow the built-in :read-only permission profile');
      this.permissionMode = 'profile';
      this.permissionProfileId = BUILT_IN_READ_ONLY_PERMISSION_PROFILE;
    } catch (error) {
      if (!isUnsupportedMethod(error)) throw error;
      this.permissionMode = 'legacy';
      this.permissionProfileId = null;
    }
  }

  #write(message) {
    if (!this.child || this.child.exitCode !== null || this.child.killed || !this.child.stdin.writable) {
      throw new Error('Codex app-server is not running');
    }
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_WRITE_BYTES) {
      throw new Error('Codex app-server request exceeded the local protocol size limit');
    }
    this.child.stdin.write(line);
  }

  request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.isRunning) return Promise.reject(new Error('Codex app-server is not running'));
    const id = this.nextRequestId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { method, timer, resolve: resolvePromise, reject: rejectPromise });
      try {
        this.#write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(error);
      }
    });
  }

  notify(method, params = {}) {
    this.#write({ method, params });
  }

  #handleLine(line) {
    if (!line.trim()) return;
    if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
      this.#fatalProtocolError(new Error('Codex app-server emitted an oversized protocol message'));
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.#fatalProtocolError(new Error('Codex app-server emitted invalid JSON'));
      return;
    }

    if (message && typeof message.method === 'string' && Object.prototype.hasOwnProperty.call(message, 'id')) {
      void this.#handleServerRequest(message);
      return;
    }
    if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      this.pending.delete(message.id);
      if (message.error) waiter.reject(protocolError(message, `${waiter.method} failed`));
      else waiter.resolve(message.result);
      return;
    }
    if (message && typeof message.method === 'string') this.#handleNotification(message.method, message.params ?? {});
  }

  async #handleServerRequest(message) {
    const handler = this.dynamicToolHandler ?? handleConfiguredMakeWatchToolCall;
    if (message.method !== 'item/tool/call' || this.dynamicToolSpecs().length === 0) {
      try {
        this.#write({
          id: message.id,
          error: {
            code: -32601,
            message: 'Make & Watch Director does not permit this Codex server request',
          },
        });
      } catch {
        // Connection teardown owns failure propagation.
      }
      this.emit('protocol-warning', { method: message.method });
      return;
    }

    const params = message.params ?? {};
    const call = {
      threadId: typeof params.threadId === 'string' ? params.threadId : '',
      turnId: typeof params.turnId === 'string' ? params.turnId : '',
      callId: typeof params.callId === 'string' ? params.callId : `rpc-${message.id}`,
      namespace: typeof params.namespace === 'string' ? params.namespace : '',
      tool: typeof params.tool === 'string' ? params.tool : '',
      arguments: params.arguments ?? {},
    };

    try {
      const text = await withTimeout(
        handler(call),
        TOOL_TIMEOUT_MS,
        `Codex dynamic tool timed out after ${TOOL_TIMEOUT_MS} ms`,
      );
      this.#write({
        id: message.id,
        result: {
          contentItems: [{ type: 'inputText', text: String(text ?? '') }],
          success: true,
        },
      });
      this.emit('tool/completed', { ...call, success: true });
    } catch (error) {
      const text = safeMessage(error instanceof Error ? error.message : error, 'Make & Watch tool failed');
      try {
        this.#write({
          id: message.id,
          result: {
            contentItems: [{ type: 'inputText', text: `Make & Watch tool failed: ${text}` }],
            success: false,
          },
        });
      } catch {
        // Connection teardown owns failure propagation.
      }
      this.emit('tool/completed', { ...call, success: false, error: text });
    }
  }

  #handleNotification(method, params) {
    if (method === 'account/login/completed') {
      const loginId = typeof params.loginId === 'string' ? params.loginId : null;
      if (!this.pendingLogin || !loginId || this.pendingLogin.loginId === loginId) {
        this.pendingLogin = params.success
          ? null
          : { ...(this.pendingLogin ?? {}), loginId, failed: true, error: safeMessage(params.error, 'Login was not completed') };
      }
    } else if (method === 'account/updated' && params.authMode === 'chatgpt') {
      this.pendingLogin = null;
    }

    const turn = this.activeTurn;
    if (turn) {
      if (method === 'item/completed') {
        const notificationTurnId = typeof params.turnId === 'string' ? params.turnId : null;
        if (!turn.turnId || !notificationTurnId || notificationTurnId === turn.turnId) {
          if (!turn.turnId && notificationTurnId) turn.turnId = notificationTurnId;
          const item = params.item;
          if (item?.type === 'agentMessage' && typeof item.text === 'string') turn.finalText = item.text;
        }
      } else if (method === 'turn/completed') {
        const completed = params.turn;
        if (completed && (!turn.turnId || completed.id === turn.turnId)) {
          if (!turn.turnId && typeof completed.id === 'string') turn.turnId = completed.id;
          const fallback = Array.isArray(completed.items)
            ? [...completed.items].reverse().find((item) => item?.type === 'agentMessage' && typeof item.text === 'string')?.text
            : null;
          if (completed.status === 'completed') this.#settleTurn(turn, null, turn.finalText || fallback || '');
          else this.#settleTurn(turn, new Error(safeMessage(completed.error?.message, `Codex turn ${completed.status ?? 'failed'}`)));
        }
      }
    }

    this.emit(method, params);
  }

  #settleTurn(turn, error, text = '') {
    if (turn.settled) return;
    turn.settled = true;
    clearTimeout(turn.timer);
    if (this.activeTurn === turn) this.activeTurn = null;
    if (error) turn.reject(error);
    else turn.resolve(text);
  }

  #fatalProtocolError(error) {
    const child = this.child;
    this.#failConnection(error);
    terminateProcessTree(child);
  }

  #failConnection(error) {
    const reason = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    this.pending.clear();
    if (this.activeTurn) this.#settleTurn(this.activeTurn, reason);
    this.initialized = false;
    this.readyPromise = null;
    this.permissionMode = 'unknown';
    this.permissionProfileId = null;
    this.reader?.close();
    this.reader = null;
    this.child = null;
  }

  async accountRead() {
    await this.start();
    return sanitizeAccount(await this.request('account/read', { refreshToken: false }));
  }

  async startChatGptLogin() {
    await this.start();
    const current = await this.accountRead();
    if (current.account?.type === 'chatgpt') {
      return { alreadyConnected: true, loginId: null, authUrl: null };
    }
    if (this.pendingLogin?.loginId && this.pendingLogin.authUrl && !this.pendingLogin.failed) {
      return { alreadyConnected: false, ...this.pendingLogin };
    }

    const result = await this.request('account/login/start', {
      type: 'chatgpt',
      useHostedLoginSuccessPage: true,
      appBrand: 'chatgpt',
    }, 12_000);
    if (result?.type !== 'chatgpt' || typeof result.loginId !== 'string' || typeof result.authUrl !== 'string') {
      throw new Error('Codex app-server did not return a valid ChatGPT login flow');
    }
    this.pendingLogin = {
      loginId: result.loginId,
      authUrl: result.authUrl,
      failed: false,
      error: '',
      startedAt: Date.now(),
    };
    return { alreadyConnected: false, loginId: result.loginId, authUrl: result.authUrl };
  }

  async cancelLogin(loginId) {
    if (!loginId) return;
    await this.start();
    await this.request('account/login/cancel', { loginId });
    if (this.pendingLogin?.loginId === loginId) this.pendingLogin = null;
  }

  #armTurn(threadId) {
    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolvePromise, rejectPromise) => {
      resolveCompletion = resolvePromise;
      rejectCompletion = rejectPromise;
    });
    void completion.catch(() => undefined);
    const turn = {
      threadId,
      turnId: null,
      finalText: '',
      settled: false,
      resolve: resolveCompletion,
      reject: rejectCompletion,
      completion,
      timer: null,
    };
    turn.timer = setTimeout(() => {
      const id = turn.turnId;
      this.#settleTurn(turn, new Error(`Codex Director turn timed out after ${PLAN_TIMEOUT_MS} ms`));
      if (id && this.isRunning) {
        void this.request('turn/interrupt', { threadId, turnId: id }, INTERRUPT_GRACE_MS).catch(() => undefined);
      }
    }, PLAN_TIMEOUT_MS);
    turn.timer.unref();
    this.activeTurn = turn;
    return turn;
  }

  async runDirectorPlan(prompt) {
    if (this.activeTurn) throw new Error('Codex Director already has an active turn');
    await this.start();

    const schema = await planSchema();
    const threadResult = await this.request('thread/start', {
      cwd: directorRuntimeRoot,
      approvalPolicy: 'never',
      ...this.readOnlyThreadSecurityParams(),
      serviceName: 'make_and_watch_director',
    }, 15_000);
    const threadId = threadResult?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) throw new Error('Codex app-server did not create a Director thread');

    const turn = this.#armTurn(threadId);
    try {
      const turnResult = await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
        cwd: directorRuntimeRoot,
        approvalPolicy: 'never',
        ...this.readOnlyTurnSecurityParams(),
        effort: 'medium',
        summary: 'concise',
        outputSchema: schema,
      }, 20_000);
      const returnedTurnId = turnResult?.turn?.id;
      if (typeof returnedTurnId !== 'string' || !returnedTurnId) {
        throw new Error('Codex app-server did not start a Director turn');
      }
      if (turn.turnId && turn.turnId !== returnedTurnId) {
        throw new Error('Codex app-server returned conflicting turn identifiers');
      }
      turn.turnId = returnedTurnId;
      return parsePlanText(await turn.completion);
    } catch (error) {
      if (!turn.settled) {
        const id = turn.turnId;
        this.#settleTurn(turn, error instanceof Error ? error : new Error(String(error)));
        if (id && this.isRunning) {
          await this.request('turn/interrupt', { threadId, turnId: id }, INTERRUPT_GRACE_MS).catch(() => undefined);
        }
      }
      throw error;
    } finally {
      if (this.activeTurn === turn && !turn.settled) {
        this.#settleTurn(turn, new Error('Codex Director turn ended during cleanup'));
      }
      if (this.isRunning) await this.request('thread/delete', { threadId }, 8_000).catch(() => undefined);
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    const child = this.child;
    const turn = this.activeTurn;
    if (turn && !turn.settled) {
      const id = turn.turnId;
      if (id && this.isRunning) {
        await this.request('turn/interrupt', { threadId: turn.threadId, turnId: id }, INTERRUPT_GRACE_MS).catch(() => undefined);
      }
      this.#settleTurn(turn, new Error('Codex Director stopped during bridge shutdown'));
    }

    if (child && child.exitCode === null) child.stdin.end();
    if (child && !(await waitForExit(child, SHUTDOWN_GRACE_MS))) {
      terminateProcessTree(child);
      await waitForExit(child, SHUTDOWN_GRACE_MS);
    }
    this.#failConnection(new Error('Codex app-server shut down'));
    this.shuttingDown = false;
  }
}
