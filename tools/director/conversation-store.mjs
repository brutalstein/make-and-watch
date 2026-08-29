import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_TITLE_CHARS = 120;
const MAX_MESSAGE_CHARS = 40_000;
const MAX_PROVIDER_THREAD_ID_CHARS = 512;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PROVIDERS = new Set(['codex', 'claude']);
const RUNTIME_MODES = new Set(['app_server', 'exec_fallback', 'none']);
const MESSAGE_ROLES = new Set(['user', 'assistant', 'system']);

function boundedText(value, maximum, label, { required = false } = {}) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (required && !text) throw new Error(`${label} is required`);
  if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return text;
}

function validateId(value, label = 'conversation id') {
  const id = String(value ?? '');
  if (!ID_PATTERN.test(id)) throw new Error(`${label} is invalid`);
  return id;
}

function validateProviderThreadId(value) {
  if (value === null || value === undefined) return null;
  const token = String(value);
  if (!token || token.length > MAX_PROVIDER_THREAD_ID_CHARS || /[\r\n\0]/.test(token)) {
    throw new Error('provider thread id is invalid');
  }
  return token;
}

function isoNow() {
  return new Date().toISOString();
}

function validateIso(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp`);
  return value;
}

function deriveTitle(value) {
  const compact = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!compact) return 'New Director conversation';
  return compact.length <= MAX_TITLE_CHARS ? compact : `${compact.slice(0, MAX_TITLE_CHARS - 1)}…`;
}

function safeSummary(document) {
  const last = [...document.messages].reverse().find((message) => message.role === 'assistant' || message.role === 'user');
  return {
    id: document.id,
    provider: document.provider,
    runtimeMode: document.runtimeMode,
    title: document.title,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    archivedAt: document.archivedAt,
    turnCount: document.turnCount,
    providerThreadId: document.providerThreadId,
    providerThreadArchived: document.providerThreadArchived,
    lastProjectRevision: document.lastProjectRevision,
    messageCount: document.messages.length,
    preview: last ? String(last.text).replace(/\s+/g, ' ').slice(0, 180) : '',
  };
}

function validateMessage(message) {
  if (!message || typeof message !== 'object') throw new Error('conversation message must be an object');
  const role = String(message.role ?? '');
  if (!MESSAGE_ROLES.has(role)) throw new Error('conversation message role is invalid');
  const text = boundedText(message.text, MAX_MESSAGE_CHARS, 'conversation message text', { required: true });
  const id = validateId(message.id ?? randomUUID(), 'conversation message id');
  const createdAt = validateIso(message.createdAt ?? isoNow(), 'conversation message createdAt');
  const projectRevision = message.projectRevision === null || message.projectRevision === undefined
    ? null
    : Number(message.projectRevision);
  if (projectRevision !== null && (!Number.isSafeInteger(projectRevision) || projectRevision < 0)) {
    throw new Error('conversation message projectRevision is invalid');
  }
  const delivery = message.delivery === 'failed' ? 'failed' : 'complete';
  return { id, role, text, createdAt, projectRevision, delivery };
}

function validateDocument(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== SCHEMA_VERSION) {
    throw new Error('conversation archive schema is unsupported');
  }
  const id = validateId(value.id);
  const provider = String(value.provider ?? '');
  if (!PROVIDERS.has(provider)) throw new Error('conversation provider is invalid');
  const runtimeMode = String(value.runtimeMode ?? 'none');
  if (!RUNTIME_MODES.has(runtimeMode)) throw new Error('conversation runtime mode is invalid');
  const title = boundedText(value.title, MAX_TITLE_CHARS, 'conversation title', { required: true });
  const createdAt = validateIso(value.createdAt, 'conversation createdAt');
  const updatedAt = validateIso(value.updatedAt, 'conversation updatedAt');
  const archivedAt = value.archivedAt === null ? null : validateIso(value.archivedAt, 'conversation archivedAt');
  const providerThreadId = validateProviderThreadId(value.providerThreadId);
  const turnCount = Number(value.turnCount ?? 0);
  if (!Number.isSafeInteger(turnCount) || turnCount < 0) throw new Error('conversation turnCount is invalid');
  const lastProjectRevision = value.lastProjectRevision === null || value.lastProjectRevision === undefined
    ? null
    : Number(value.lastProjectRevision);
  if (lastProjectRevision !== null && (!Number.isSafeInteger(lastProjectRevision) || lastProjectRevision < 0)) {
    throw new Error('conversation lastProjectRevision is invalid');
  }
  if (!Array.isArray(value.messages)) throw new Error('conversation messages must be an array');
  const messages = value.messages.map(validateMessage);
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    provider,
    runtimeMode,
    providerThreadId,
    providerThreadArchived: Boolean(value.providerThreadArchived),
    title,
    createdAt,
    updatedAt,
    archivedAt,
    turnCount,
    lastProjectRevision,
    messages,
  };
}

export class ConversationStore {
  constructor({ rootDirectory }) {
    if (!rootDirectory) throw new Error('ConversationStore requires rootDirectory');
    this.rootDirectory = rootDirectory;
    this.writeChain = Promise.resolve();
  }

  #path(id) {
    return join(this.rootDirectory, `${validateId(id)}.json`);
  }

  async #ensureRoot() {
    await mkdir(this.rootDirectory, { recursive: true });
  }

  async #readUnsafe(id) {
    const path = this.#path(id);
    const metadata = await stat(path).catch(() => null);
    if (!metadata?.isFile()) throw new Error('Director conversation was not found');
    if (metadata.size > MAX_FILE_BYTES) throw new Error('Director conversation archive exceeds the safe file-size limit');
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return validateDocument(parsed);
  }

  async #writeUnsafe(document) {
    await this.#ensureRoot();
    const normalized = validateDocument(document);
    const target = this.#path(normalized.id);
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) {
      throw new Error('Director conversation archive exceeds the safe file-size limit');
    }
    await writeFile(temporary, serialized, { encoding: 'utf8', flag: 'wx' });
    try {
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return normalized;
  }

  #serialize(operation) {
    const next = this.writeChain.then(operation, operation);
    this.writeChain = next.catch(() => undefined);
    return next;
  }

  async create({ provider, runtimeMode, providerThreadId = null, title = '', projectRevision = null }) {
    return this.#serialize(async () => {
      const now = isoNow();
      const document = validateDocument({
        schemaVersion: SCHEMA_VERSION,
        id: randomUUID(),
        provider,
        runtimeMode,
        providerThreadId,
        providerThreadArchived: false,
        title: deriveTitle(title),
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        turnCount: 0,
        lastProjectRevision: projectRevision,
        messages: [],
      });
      await this.#writeUnsafe(document);
      return safeSummary(document);
    });
  }

  async read(id) {
    await this.writeChain;
    return this.#readUnsafe(id);
  }

  async list({ archived = false, limit = 100 } = {}) {
    await this.writeChain;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('conversation list limit must be between 1 and 500');
    await this.#ensureRoot();
    const entries = await readdir(this.rootDirectory, { withFileTypes: true });
    const documents = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.includes('.tmp-')) continue;
      const id = basename(entry.name, '.json');
      if (!ID_PATTERN.test(id)) continue;
      try {
        const document = await this.#readUnsafe(id);
        if (Boolean(document.archivedAt) !== Boolean(archived)) continue;
        documents.push(document);
      } catch {
        // One corrupt archive must not make the entire conversation picker unusable.
      }
    }
    documents.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    return documents.slice(0, limit).map(safeSummary);
  }

  async mutate(id, mutator) {
    return this.#serialize(async () => {
      const current = await this.#readUnsafe(id);
      const next = await mutator(structuredClone(current));
      const normalized = validateDocument({ ...next, id: current.id, updatedAt: isoNow() });
      await this.#writeUnsafe(normalized);
      return normalized;
    });
  }

  async setProviderState(id, { runtimeMode, providerThreadId, providerThreadArchived = false }) {
    const document = await this.mutate(id, (current) => ({
      ...current,
      runtimeMode,
      providerThreadId,
      providerThreadArchived: Boolean(providerThreadArchived),
    }));
    return safeSummary(document);
  }

  async appendTurn(id, { userText, assistantText, projectRevision = null, runtimeMode, providerThreadId }) {
    const document = await this.mutate(id, (current) => {
      current.messages.push(validateMessage({
        id: randomUUID(),
        role: 'user',
        text: userText,
        createdAt: isoNow(),
        projectRevision,
      }));
      current.messages.push(validateMessage({
        id: randomUUID(),
        role: 'assistant',
        text: assistantText,
        createdAt: isoNow(),
        projectRevision,
      }));
      current.turnCount += 1;
      current.lastProjectRevision = projectRevision;
      current.runtimeMode = runtimeMode;
      current.providerThreadId = providerThreadId;
      current.providerThreadArchived = false;
      return current;
    });
    return safeSummary(document);
  }

  async appendFailure(id, { userText, message, projectRevision = null }) {
    const document = await this.mutate(id, (current) => {
      current.messages.push(validateMessage({
        id: randomUUID(),
        role: 'user',
        text: userText,
        createdAt: isoNow(),
        projectRevision,
        delivery: 'failed',
      }));
      current.messages.push(validateMessage({
        id: randomUUID(),
        role: 'system',
        text: boundedText(message, MAX_MESSAGE_CHARS, 'conversation failure message', { required: true }),
        createdAt: isoNow(),
        projectRevision,
        delivery: 'failed',
      }));
      current.lastProjectRevision = projectRevision;
      return current;
    });
    return safeSummary(document);
  }

  async rename(id, title) {
    const document = await this.mutate(id, (current) => ({
      ...current,
      title: boundedText(title, MAX_TITLE_CHARS, 'conversation title', { required: true }),
    }));
    return safeSummary(document);
  }

  async archive(id, providerThreadArchived = false) {
    const document = await this.mutate(id, (current) => ({
      ...current,
      archivedAt: current.archivedAt ?? isoNow(),
      providerThreadArchived: Boolean(providerThreadArchived),
    }));
    return safeSummary(document);
  }

  async unarchive(id, providerThreadArchived = false) {
    const document = await this.mutate(id, (current) => ({
      ...current,
      archivedAt: null,
      providerThreadArchived: Boolean(providerThreadArchived),
    }));
    return safeSummary(document);
  }

  async delete(id) {
    return this.#serialize(async () => {
      const existing = await this.#readUnsafe(id);
      await rm(this.#path(id), { force: false });
      return safeSummary(existing);
    });
  }
}

export { deriveTitle };
