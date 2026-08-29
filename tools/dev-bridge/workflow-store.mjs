import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const STORE_SCHEMA_VERSION = 1;
const MAX_NAME_CHARS = 120;
const MAX_DESCRIPTION_CHARS = 800;
const MAX_RECOVERY_ITEMS = 12;
const MAX_WORKFLOW_FILES = 256;
const ID_PATTERN = /^(?:wf|recovery)-[a-zA-Z0-9_-]{8,80}$/;

function boundedText(value, maximum, label, { required = false } = {}) {
  const text = String(value ?? '').trim();
  if (required && !text) throw new Error(`${label} is required`);
  if (text.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return text;
}

function validateId(value) {
  const id = String(value ?? '').trim();
  if (!ID_PATTERN.test(id)) throw new Error('workflow id is invalid');
  return id;
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.schemaVersion !== 1) {
    throw new Error('workflow snapshot must use project schema version 1');
  }
  if (!Number.isSafeInteger(snapshot.projectRevision) || snapshot.projectRevision < 0) {
    throw new Error('workflow snapshot projectRevision is invalid');
  }
  if (!Array.isArray(snapshot.nodes) || !Array.isArray(snapshot.dependencies)) {
    throw new Error('workflow snapshot graph is malformed');
  }
  return snapshot;
}

function workflowSummary(record) {
  return {
    id: record.id,
    kind: record.kind,
    name: record.name,
    description: record.description,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sourceProjectRevision: record.sourceProjectRevision,
    nodeCount: record.snapshot.nodes.length,
    dependencyCount: record.snapshot.dependencies.length,
  };
}

function parseRecord(text, expectedId = null) {
  const record = JSON.parse(text);
  if (!record || typeof record !== 'object' || record.schemaVersion !== STORE_SCHEMA_VERSION) {
    throw new Error('saved workflow schema is unsupported');
  }
  const id = validateId(record.id);
  if (expectedId && id !== expectedId) throw new Error('saved workflow id does not match file name');
  if (record.kind !== 'saved' && record.kind !== 'recovery') throw new Error('saved workflow kind is invalid');
  const name = boundedText(record.name, MAX_NAME_CHARS, 'workflow name', { required: true });
  const description = boundedText(record.description, MAX_DESCRIPTION_CHARS, 'workflow description');
  if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') {
    throw new Error('saved workflow timestamps are invalid');
  }
  if (!Number.isSafeInteger(record.sourceProjectRevision) || record.sourceProjectRevision < 0) {
    throw new Error('saved workflow source revision is invalid');
  }
  const snapshot = validateSnapshot(record.snapshot);
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    id,
    kind: record.kind,
    name,
    description,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    sourceProjectRevision: record.sourceProjectRevision,
    snapshot,
  };
}

function makeId(kind) {
  const prefix = kind === 'recovery' ? 'recovery' : 'wf';
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export class WorkflowStore {
  constructor({ rootDirectory }) {
    if (!rootDirectory) throw new Error('WorkflowStore requires rootDirectory');
    this.rootDirectory = resolve(rootDirectory);
  }

  async #ensureRoot() {
    await mkdir(this.rootDirectory, { recursive: true });
  }

  #path(id) {
    const safeId = validateId(id);
    return resolve(this.rootDirectory, `${safeId}.json`);
  }

  async #writeRecord(record) {
    await this.#ensureRoot();
    const destination = this.#path(record.id);
    const temporary = resolve(
      this.rootDirectory,
      `.${record.id}.${randomUUID().replaceAll('-', '').slice(0, 10)}.tmp`,
    );
    const payload = `${JSON.stringify(record, null, 2)}\n`;
    try {
      await writeFile(temporary, payload, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return workflowSummary(record);
  }

  async save(snapshot, { name, description = '', kind = 'saved' } = {}) {
    if (kind !== 'saved' && kind !== 'recovery') throw new Error('workflow kind is invalid');
    const validatedSnapshot = validateSnapshot(snapshot);
    const now = new Date().toISOString();
    const record = {
      schemaVersion: STORE_SCHEMA_VERSION,
      id: makeId(kind),
      kind,
      name: boundedText(name, MAX_NAME_CHARS, 'workflow name', { required: true }),
      description: boundedText(description, MAX_DESCRIPTION_CHARS, 'workflow description'),
      createdAt: now,
      updatedAt: now,
      sourceProjectRevision: validatedSnapshot.projectRevision,
      snapshot: validatedSnapshot,
    };
    const summary = await this.#writeRecord(record);
    if (kind === 'recovery') await this.pruneRecoveries();
    return summary;
  }

  async saveRecovery(snapshot, reason = 'Automatic recovery checkpoint') {
    const revision = validateSnapshot(snapshot).projectRevision;
    return this.save(snapshot, {
      kind: 'recovery',
      name: `Recovery · revision ${revision}`,
      description: boundedText(reason, MAX_DESCRIPTION_CHARS, 'recovery reason'),
    });
  }

  async read(id) {
    const safeId = validateId(id);
    const text = await readFile(this.#path(safeId), 'utf8');
    return parseRecord(text, safeId);
  }

  async list({ includeRecovery = true } = {}) {
    await this.#ensureRoot();
    const entries = await readdir(this.rootDirectory, { withFileTypes: true });
    const candidates = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .slice(0, MAX_WORKFLOW_FILES);
    const workflows = [];
    const issues = [];

    for (const entry of candidates) {
      const fileName = basename(entry.name, '.json');
      try {
        const record = await this.read(fileName);
        if (includeRecovery || record.kind !== 'recovery') workflows.push(workflowSummary(record));
      } catch (error) {
        issues.push({
          file: entry.name.slice(0, 120),
          message: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
        });
      }
    }

    workflows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return { workflows, issues };
  }

  async delete(id) {
    const record = await this.read(id);
    await rm(this.#path(record.id));
    return workflowSummary(record);
  }

  async pruneRecoveries(maximum = MAX_RECOVERY_ITEMS) {
    const { workflows } = await this.list({ includeRecovery: true });
    const recoveries = workflows
      .filter((workflow) => workflow.kind === 'recovery')
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    for (const stale of recoveries.slice(maximum)) {
      await rm(this.#path(stale.id), { force: true });
    }
  }
}

export const workflowStoreLimits = Object.freeze({
  maxNameChars: MAX_NAME_CHARS,
  maxDescriptionChars: MAX_DESCRIPTION_CHARS,
  maxRecoveryItems: MAX_RECOVERY_ITEMS,
  maxWorkflowFiles: MAX_WORKFLOW_FILES,
});
