import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { spawnProviderExecutable } from './provider-executable.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const directorRuntimeRoot = resolve(root, 'tools', 'director', 'runtime');
const planSchemaPath = resolve(root, 'schemas', 'v1', 'director-autopilot-plan.schema.json');

const REQUEST_TIMEOUT_MS = 8_000;
const PLAN_TIMEOUT_MS = 120_000;
const INTERRUPT_GRACE_MS = 2_500;
const SHUTDOWN_GRACE_MS = 2_000;
const MAX_PROTOCOL_LINE_BYTES = 2 * 1024 * 1024;
const MAX_PROTOCOL_WRITE_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

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

function parsePlanText(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new Error('Codex completed without a Director plan');
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1 || !Array.isArray(parsed.steps)) {
    throw new Error('Codex result is not an AutopilotPlan v1 object');
  }
  return parsed;
}

export class CodexAppServerClient extends EventEmitter {
  constructor({ executable, processFactory = null } = {}) {
    super();
    if (!executable) throw new Error('Codex app-server requires a resolved executable');
    this.executable = executable;
    this.processFactory = processFactory;
    this.child = null;
    this.lineReader = null;
    this.readyPromise = null;
    this.initialized = false;
    this.shuttingDown = false;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.activeTurn = null;
    this.pendingLogin = null;
    this.stderrTail = '';
  }

  get isRunning() {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed);
  }

  get loginState() {
    return this.pendingLogin ? { ...this.pendingLogin } : null;
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
    const options = {
      cwd: root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    };
    this.child = this.processFactory
      ? this.processFactory(this.executable, ['app-server'], options)
      : spawnProviderExecutable(this.executable, ['app-server'], options);

    const child = this.child;
    child.stdout.setEncoding?.('utf8');
    child.stderr.setEncoding?.('utf8');
    child.stderr.on('data', (chunk) => {
      const next = `${this.stderrTail}${String(chunk)}`;
      this.stderrTail = next.slice(-MAX_STDERR_BYTES);
    });
    child.on('error', (error) => this.#failConnection(error));
    child.on('close', (code, signal) => {
      const expected = this.shuttingDown;
      this.#failConnection(new Error(
        expected
          ? 'Codex app-server stopped'
          : `Codex app-server exited unexpectedly (${code ?? 'null'} / ${signal ?? 'no-signal'})`,
      ));
    });

    this.lineReader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lineReader.on('line', (line) => this.#handleLine(line));

    try {
      await this.request('initialize', {
        clientInfo: {
          name: 'make_and_watch',
          title: 'Make & Watch',
          version: '0.1.0',
        },
        capabilities: {
          optOutNotificationMethods: [
            'item/agentMessage/delta',
            'item/reasoning/summaryTextDelta',
            'item/reasoning/textDelta',
            'item/commandExecution/outputDelta',
          ],
        },
      }, 12_000);
      this.notify('initialized', {});
      this.initialized = true;
    } catch (error) {
      terminateProcessTree(child);
      throw new Error(`Codex app-server initialization failed: ${safeMessage(error instanceof Error ? error.message : error)}`);
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
    if (!this.child || this.child.exitCode !== null || this.child.killed) {
      return Promise.reject(new Error('Codex app-server is not running'));
    }
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
      this.#handleServerRequest(message);
      return;
    }

    if (message && Object.prototype.hasOwnProperty.call(message, 'id')) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(safeMessage(message.error.message, `${pending.method} failed`)));
      else pending.resolve(message.result);
      return;
    }

    if (message && typeof message.method === 'string') this.#handleNotification(message.method, message.params ?? {});
  }

  #handleServerRequest(message) {
    // Make & Watch Director runs read-only with approvalPolicy=never. Any server-side
    // interactive/tool request is unexpected and is rejected rather than hanging.
    try {
      this.#write({
        id: message.id,
        error: {
          code: -32601,
          message: 'Make & Watch Director does not permit interactive Codex tool requests',
        },
      });
    } catch {
      // Connection teardown will reject any active operation.
    }
    this.emit('protocol-warning', { method: message.method });
  }

  #handleNotification(method, params) {
    if (method === 'account/login/completed') {
      const loginId = typeof params.loginId === 'string' ? params.loginId : null;
      if (!this.pendingLogin || !loginId || this.pendingLogin.loginId === loginId) {
        this.pendingLogin = params.success
          ? null
          : { ...(this.pendingLogin ?? {}), loginId, failed: true, error: safeMessage(params.error, 'Login was not completed') };
      }
    } else if (method === 'account/updated') {
      if (params.authMode === 'chatgpt') this.pendingLogin = null;
    }

    const active = this.activeTurn;
    if (active) {
      if (method === 'item/completed') {
        const turnId = typeof params.turnId === 'string' ? params.turnId : null;
        if (!turnId || turnId === active.turnId) {
          const item = params.item;
          if (item?.type === 'agentMessage' && typeof item.text === 'string') active.finalText = item.text;
        }
      } else if (method === 'turn/completed') {
        const turn = params.turn;
        if (turn?.id === active.turnId) {
          clearTimeout(active.timer);
          this.activeTurn = null;
          const fallback = Array.isArray(turn.items)
            ? [...turn.items].reverse().find((item) => item?.type === 'agentMessage' && typeof item.text === 'string')?.text
            : null;
          if (turn.status === 'completed') active.resolve(active.finalText || fallback || '');
          else active.reject(new Error(safeMessage(turn.error?.message, `Codex turn ${turn.status ?? 'failed'}`)));
        }
      }
    }

    this.emit(method, params);
  }

  #fatalProtocolError(error) {
    this.#failConnection(error);
    terminateProcessTree(this.child);
  }

  #failConnection(error) {
    const reason = error instanceof Error ? error : new Error(String(error));
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    this.pending.clear();

    if (this.activeTurn) {
      clearTimeout(this.activeTurn.timer);
      this.activeTurn.reject(reason);
      this.activeTurn = null;
    }

    this.initialized = false;
    this.readyPromise = null;
    this.lineReader?.close();
    this.lineReader = null;
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

  async runDirectorPlan(prompt) {
    if (this.activeTurn) throw new Error('Codex Director already has an active turn');
    await this.start();

    const schema = await planSchema();
    const threadResult = await this.request('thread/start', {
      cwd: directorRuntimeRoot,
      approvalPolicy: 'never',
      sandbox: 'readOnly',
      serviceName: 'make_and_watch_director',
    }, 15_000);
    const threadId = threadResult?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) throw new Error('Codex app-server did not create a Director thread');

    let turnId = null;
    try {
      const turnResult = await this.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
        cwd: directorRuntimeRoot,
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'readOnly',
          access: {
            type: 'restricted',
            includePlatformDefaults: true,
            readableRoots: [directorRuntimeRoot],
          },
        },
        effort: 'medium',
        summary: 'concise',
        outputSchema: schema,
      }, 20_000);
      turnId = turnResult?.turn?.id;
      if (typeof turnId !== 'string' || !turnId) throw new Error('Codex app-server did not start a Director turn');

      const text = await new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          const active = this.activeTurn;
          if (active?.turnId === turnId) this.activeTurn = null;
          void this.request('turn/interrupt', { threadId, turnId }, INTERRUPT_GRACE_MS).catch(() => undefined);
          rejectPromise(new Error(`Codex Director turn timed out after ${PLAN_TIMEOUT_MS} ms`));
        }, PLAN_TIMEOUT_MS);
        timer.unref();
        this.activeTurn = {
          threadId,
          turnId,
          finalText: '',
          timer,
          resolve: resolvePromise,
          reject: rejectPromise,
        };
      });
      return parsePlanText(text);
    } finally {
      if (this.activeTurn?.threadId === threadId) {
        clearTimeout(this.activeTurn.timer);
        this.activeTurn.reject(new Error('Codex Director turn ended during cleanup'));
        this.activeTurn = null;
      }
      if (turnId && this.isRunning) {
        // A completed turn needs no interrupt. This is only a best-effort guard for
        // failure paths where the turn may still be active.
        void this.request('turn/interrupt', { threadId, turnId }, INTERRUPT_GRACE_MS).catch(() => undefined);
      }
      if (this.isRunning) await this.request('thread/delete', { threadId }, 8_000).catch(() => undefined);
    }
  }

  async shutdown() {
    this.shuttingDown = true;
    const child = this.child;
    const active = this.activeTurn;
    if (active && this.isRunning) {
      await this.request('turn/interrupt', {
        threadId: active.threadId,
        turnId: active.turnId,
      }, INTERRUPT_GRACE_MS).catch(() => undefined);
      clearTimeout(active.timer);
      active.reject(new Error('Codex Director stopped during bridge shutdown'));
      this.activeTurn = null;
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
