import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const directorRuntimeRoot = resolve(root, 'tools', 'director', 'runtime');
const directorReferenceRoot = resolve(root, '.makewatch', 'director-assets');

// One Director chat turn may create a whole scene: several authoritative
// project tool calls plus Codex reasoning between them. This budget must stay
// BELOW the Studio client budget so a genuinely stuck turn is reported by the
// server with a real reason instead of being aborted by the browser.
const CHAT_TURN_TIMEOUT_MS = Number(process.env.MAKEWATCH_DIRECTOR_TURN_TIMEOUT_MS ?? 600_000);
const TURN_START_TIMEOUT_MS = 20_000;
const INTERRUPT_TIMEOUT_MS = 2_500;
const THREAD_TIMEOUT_MS = 15_000;
const MODEL_TIMEOUT_MS = 15_000;
const MODEL_CACHE_MS = 5 * 60 * 1000;
const MAX_LOCAL_IMAGES = 8;
const DEFAULT_DIRECTOR_MODEL = 'gpt-5.6-luna';
const FALLBACK_DIRECTOR_MODELS = ['gpt-5.6-terra', 'gpt-5.4-mini'];
const EFFORT_PREFERENCE = ['low', 'minimal', 'none'];

function safeText(value, fallback = 'Codex Director chat failed') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function invalidParams(error) {
  return error?.code === -32602 || /invalid params|unknown field|excludeTurns/i.test(String(error?.message ?? ''));
}

function modelName(model) {
  return String(model?.model ?? model?.id ?? '').trim();
}

function modelEfforts(model) {
  return Array.isArray(model?.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
      .map((option) => String(option?.reasoningEffort ?? '').trim())
      .filter(Boolean)
    : [];
}

function inputModalities(model) {
  return Array.isArray(model?.inputModalities) && model.inputModalities.length
    ? model.inputModalities.map((value) => String(value))
    : ['text', 'image'];
}

function chooseEffort(model) {
  const supported = modelEfforts(model);
  const requested = String(process.env.MAKEWATCH_DIRECTOR_CHAT_EFFORT ?? '').trim();
  if (requested && supported.includes(requested)) return requested;
  for (const candidate of EFFORT_PREFERENCE) if (supported.includes(candidate)) return candidate;
  const fallback = String(model?.defaultReasoningEffort ?? '').trim();
  if (fallback && supported.includes(fallback)) return fallback;
  return supported[0] ?? '';
}

function chooseDirectorModel(models) {
  const visible = models.filter((model) => model && model.hidden !== true);
  const imageCapable = visible.filter((model) => inputModalities(model).includes('image'));
  const pool = imageCapable.length ? imageCapable : visible;
  if (!pool.length) return null;

  const requested = String(process.env.MAKEWATCH_DIRECTOR_CHAT_MODEL ?? '').trim();
  const priorities = [requested, DEFAULT_DIRECTOR_MODEL, ...FALLBACK_DIRECTOR_MODELS].filter(Boolean);
  let selected = null;
  for (const name of priorities) {
    selected = pool.find((model) => modelName(model) === name || String(model.id ?? '') === name) ?? null;
    if (selected) break;
  }
  selected ??= pool.find((model) => model.isDefault === true) ?? pool[0];
  const model = modelName(selected);
  if (!model) return null;
  return {
    model,
    id: String(selected.id ?? model),
    displayName: String(selected.displayName ?? model),
    effort: chooseEffort(selected),
    inputModalities: inputModalities(selected),
    defaultReasoningEffort: String(selected.defaultReasoningEffort ?? ''),
    source: requested && (model === requested || selected.id === requested) ? 'environment' : model === DEFAULT_DIRECTOR_MODEL ? 'director-default' : 'catalog-fallback',
  };
}

function safeLocalImages(values) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new Error('Director local images must be an array');
  if (values.length > MAX_LOCAL_IMAGES) throw new Error(`Director supports at most ${MAX_LOCAL_IMAGES} reference images per message`);
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Director reference image path must be absolute');
    const candidate = resolve(value);
    const rel = relative(directorReferenceRoot, candidate);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Director reference image must come from the managed reference library');
    }
    if (!seen.has(candidate)) {
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}

export class CodexChatSession {
  constructor(client) {
    if (!client) throw new Error('Codex chat requires an App Server client');
    this.client = client;
    this.activeTurn = null;
    this.attachedThreads = new Set();
    this.profileCache = null;
    this.profileCachedAt = 0;
  }

  threadSecurityParams() {
    return {
      cwd: directorRuntimeRoot,
      approvalPolicy: 'never',
      ...this.client.readOnlyThreadSecurityParams(),
    };
  }

  async directorProfile({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.profileCache && now - this.profileCachedAt < MODEL_CACHE_MS) return { ...this.profileCache };
    await this.client.start();
    let data = [];
    let cursor = null;
    do {
      const result = await this.client.request('model/list', {
        limit: 100,
        cursor,
        includeHidden: false,
      }, MODEL_TIMEOUT_MS);
      if (Array.isArray(result?.data)) data.push(...result.data);
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null;
    } while (cursor && data.length < 300);

    const selected = chooseDirectorModel(data);
    if (!selected) throw new Error('Codex App Server did not advertise a usable Director chat model');
    this.profileCache = selected;
    this.profileCachedAt = now;
    return { ...selected };
  }

  async createThread() {
    await this.client.start();
    const dynamicTools = this.client.dynamicToolSpecs?.() ?? [];
    const profile = await this.directorProfile();
    const result = await this.client.request('thread/start', {
      ...this.threadSecurityParams(),
      model: profile.model,
      ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
      serviceName: 'make_and_watch_director_chat',
    }, THREAD_TIMEOUT_MS);
    const threadId = result?.thread?.id;
    if (typeof threadId !== 'string' || !threadId) throw new Error('Codex App Server did not create a Director chat thread');
    this.attachedThreads.add(threadId);
    return threadId;
  }

  async resumeThread(threadId) {
    if (typeof threadId !== 'string' || !threadId) throw new Error('Director chat thread ID is required');
    if (this.attachedThreads.has(threadId)) return threadId;
    await this.client.start();

    let result;
    try {
      result = await this.client.request('thread/resume', {
        threadId,
        ...this.threadSecurityParams(),
        excludeTurns: true,
      }, THREAD_TIMEOUT_MS);
    } catch (error) {
      if (!invalidParams(error)) throw error;
      result = await this.client.request('thread/resume', {
        threadId,
        ...this.threadSecurityParams(),
      }, THREAD_TIMEOUT_MS);
    }

    const resumedId = result?.thread?.id;
    if (typeof resumedId !== 'string' || resumedId !== threadId) {
      throw new Error('Codex App Server returned an invalid resumed Director thread');
    }
    this.attachedThreads.add(threadId);
    return threadId;
  }

  async readThread(threadId, includeTurns = false) {
    await this.client.start();
    const result = await this.client.request('thread/read', { threadId, includeTurns }, THREAD_TIMEOUT_MS);
    if (!result?.thread || result.thread.id !== threadId) throw new Error('Codex App Server returned an invalid Director thread read');
    return result.thread;
  }

  async nameThread(threadId, name) {
    if (!threadId || !String(name ?? '').trim()) return;
    await this.client.start();
    await this.client.request('thread/name/set', {
      threadId,
      name: String(name).trim().slice(0, 120),
    }, THREAD_TIMEOUT_MS);
  }

  async unsubscribeThread(threadId) {
    if (!threadId || !this.attachedThreads.has(threadId)) return;
    await this.client.start();
    await this.client.request('thread/unsubscribe', { threadId }, THREAD_TIMEOUT_MS).catch(() => undefined);
    this.attachedThreads.delete(threadId);
  }

  async archiveThread(threadId) {
    if (!threadId) return;
    if (this.activeTurn?.threadId === threadId && !this.activeTurn.settled) {
      throw new Error('Cannot archive the Director conversation while its turn is active');
    }
    await this.client.start();
    await this.client.request('thread/archive', { threadId }, THREAD_TIMEOUT_MS);
    this.attachedThreads.delete(threadId);
  }

  async unarchiveThread(threadId) {
    if (!threadId) return;
    await this.client.start();
    const result = await this.client.request('thread/unarchive', { threadId }, THREAD_TIMEOUT_MS);
    if (result?.thread?.id && result.thread.id !== threadId) {
      throw new Error('Codex App Server returned an invalid unarchived Director thread');
    }
    this.attachedThreads.delete(threadId);
  }

  async deleteThread(threadId) {
    if (!threadId) return;
    if (this.activeTurn?.threadId === threadId && !this.activeTurn.settled) {
      throw new Error('Cannot delete the Director conversation while its turn is active');
    }
    await this.client.start();
    await this.client.request('thread/delete', { threadId }, THREAD_TIMEOUT_MS);
    this.attachedThreads.delete(threadId);
  }

  async send(threadId, prompt, { localImages = [] } = {}) {
    if (this.activeTurn) throw new Error('Codex Director already has an active turn');
    if (typeof threadId !== 'string' || !threadId) throw new Error('Director chat thread ID is required');
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Director chat prompt is required');
    const images = safeLocalImages(localImages);
    const profile = await this.directorProfile();
    if (images.length && !profile.inputModalities.includes('image')) {
      throw new Error(`${profile.displayName} does not advertise image input; Director reference images cannot be silently ignored`);
    }
    await this.resumeThread(threadId);

    let resolveCompletion;
    let rejectCompletion;
    const completion = new Promise((resolvePromise, rejectPromise) => {
      resolveCompletion = resolvePromise;
      rejectCompletion = rejectPromise;
    });
    void completion.catch(() => undefined);
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
      const input = [
        { type: 'text', text: prompt },
        ...images.map((path) => ({ type: 'localImage', path })),
      ];
      const result = await this.client.request('turn/start', {
        threadId,
        input,
        cwd: directorRuntimeRoot,
        approvalPolicy: 'never',
        ...this.client.readOnlyTurnSecurityParams(),
        model: profile.model,
        ...(profile.effort ? { effort: profile.effort } : {}),
        summary: 'concise',
      }, TURN_START_TIMEOUT_MS);
      const returnedTurnId = result?.turn?.id;
      if (typeof returnedTurnId !== 'string' || !returnedTurnId) throw new Error('Codex App Server did not start a Director chat turn');
      if (turn.turnId && turn.turnId !== returnedTurnId) throw new Error('Codex App Server returned conflicting chat turn identifiers');
      turn.turnId = returnedTurnId;
      return safeText(await completion, 'Codex completed without a chat reply');
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

  async shutdown() {
    const turn = this.activeTurn;
    if (!turn || turn.settled) {
      this.attachedThreads.clear();
      return;
    }
    const id = turn.turnId;
    if (id && this.client.isRunning) {
      await this.client.request('turn/interrupt', { threadId: turn.threadId, turnId: id }, INTERRUPT_TIMEOUT_MS).catch(() => undefined);
    }
    this.attachedThreads.clear();
  }
}

export const codexDirectorModelPolicy = Object.freeze({
  preferredModel: DEFAULT_DIRECTOR_MODEL,
  effortPreference: [...EFFORT_PREFERENCE],
  maxLocalImages: MAX_LOCAL_IMAGES,
});
