import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const directorRuntimeRoot = resolve(root, 'tools', 'director', 'runtime');

const CHAT_TURN_TIMEOUT_MS = 120_000;
const TURN_START_TIMEOUT_MS = 20_000;
const INTERRUPT_TIMEOUT_MS = 2_500;
const THREAD_TIMEOUT_MS = 10_000;
const THREAD_READ_ONLY_SANDBOX = 'read-only';
const TURN_READ_ONLY_SANDBOX = 'readOnly';

function safeText(value, fallback = 'Codex Director chat failed') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

export class CodexChatSession {
  constructor(client) {
    if (!client) throw new Error('Codex chat requires an App Server client');
    this.client = client;
    this.activeTurn = null;
  }

  async createThread() {
    await this.client.start();
    const result = await this.client.request('thread/start', {
      cwd: directorRuntimeRoot,
      approvalPolicy: 'never',
      sandbox: THREAD_READ_ONLY_SANDBOX,
      ephemeral: true,
      serviceName: 'make_and_watch_director_chat',
    }, 15_000);
    const threadId = result?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) throw new Error('Codex App Server did not create a Director chat thread');
    return threadId;
  }

  async send(threadId, prompt) {
    if (this.activeTurn) throw new Error('Codex Director already has an active turn');
    if (typeof threadId !== 'string' || !threadId) throw new Error('Director chat thread ID is required');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Director chat prompt is required');
    await this.client.start();

    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolvePromise, rejectPromise) => {
      resolveCompletion = resolvePromise;
      rejectCompletion = rejectPromise;
    });
    const turn = { threadId, turnId: null, finalText: '', settled: false, resolve: resolveCompletion, reject: rejectCompletion, completion, timer: null };

    const finish = (error, text = '') => {
      if (turn.settled) return;
      turn.settled = true;
      clearTimeout(turn.timer);
      this.client.off('item/completed', onItem);
      this.client.off('turn/completed', onCompleted);
      if (this.activeTurn === turn) this.activeTurn = null;
      if (error) turn.reject(error);
      else turn.resolve(text);
    };
    const onItem = (params) => {
      if (params?.threadId && params.threadId !== threadId) return;
      const notificationTurnId = typeof params?.turnId === 'string' ? params.turnId : null;
      if (turn.turnId && notificationTurnId && notificationTurnId !== turn.turnId) return;
      if (!turn.turnId && notificationTurnId) turn.turnId = notificationTurnId;
      const item = params?.item;
      if (item?.type === 'agentMessage' && typeof item.text === 'string') turn.finalText = item.text;
    };
    const onCompleted = (params) => {
      if (params?.threadId && params.threadId !== threadId) return;
      const completed = params?.turn;
      if (!completed) return;
      if (turn.turnId && completed.id && completed.id !== turn.turnId) return;
      if (!turn.turnId && typeof completed.id === 'string') turn.turnId = completed.id;
      const fallback = Array.isArray(completed.items)
        ? [...completed.items].reverse().find((item) => item?.type === 'agentMessage' && typeof item.text === 'string')?.text
        : '';
      if (completed.status === 'completed') finish(null, turn.finalText || fallback || '');
      else finish(new Error(safeText(completed.error?.message, `Codex chat turn ${completed.status ?? 'failed'}`)));
    };

    this.client.on('item/completed', onItem);
    this.client.on('turn/completed', onCompleted);
    turn.timer = setTimeout(() => {
      const id = turn.turnId;
      finish(new Error(`Codex Director chat timed out after ${CHAT_TURN_TIMEOUT_MS} ms`));
      if (id && this.client.isRunning) {
        void this.client.request('turn/interrupt', { threadId, turnId: id }, INTERRUPT_TIMEOUT_MS).catch(() => undefined);
      }
    }, CHAT_TURN_TIMEOUT_MS);
    turn.timer.unref();
    this.activeTurn = turn;

    try {
      const result = await this.client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: prompt }],
        cwd: directorRuntimeRoot,
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: TURN_READ_ONLY_SANDBOX,
          access: {
            type: 'restricted',
            includePlatformDefaults: true,
            readableRoots: [directorRuntimeRoot],
          },
        },
        effort: 'medium',
        summary: 'concise',
      }, TURN_START_TIMEOUT_MS);
      const returnedTurnId = result?.turn?.id;
      if (typeof returnedTurnId !== 'string' || !returnedTurnId) throw new Error('Codex App Server did not start a Director chat turn');
      if (turn.turnId && turn.turnId !== returnedTurnId) throw new Error('Codex App Server returned conflicting chat turn identifiers');
      turn.turnId = returnedTurnId;
      const reply = safeText(await completion, 'Codex completed without a chat reply');
      return reply;
    } catch (error) {
      if (!turn.settled) {
        const id = turn.turnId;
        finish(error instanceof Error ? error : new Error(String(error)));
        if (id && this.client.isRunning) {
          await this.client.request('turn/interrupt', { threadId, turnId: id }, INTERRUPT_TIMEOUT_MS).catch(() => undefined);
        }
      }
      throw error;
    } finally {
      if (!turn.settled) finish(new Error('Codex Director chat ended during cleanup'));
    }
  }

  async deleteThread(threadId) {
    if (!threadId) return;
    await this.client.start();
    await this.client.request('thread/delete', { threadId }, THREAD_TIMEOUT_MS);
  }

  async shutdown() {
    const turn = this.activeTurn;
    if (!turn || turn.settled) return;
    const id = turn.turnId;
    if (id && this.client.isRunning) {
      await this.client.request('turn/interrupt', { threadId: turn.threadId, turnId: id }, INTERRUPT_TIMEOUT_MS).catch(() => undefined);
    }
  }
}
