import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationStore, conversationStoreLimits } from './conversation-store.mjs';

const root = await mkdtemp(join(tmpdir(), 'makewatch-conversations-'));
try {
  const store = new ConversationStore({ rootDirectory: root });
  const created = await store.create({
    provider: 'codex',
    runtimeMode: 'app_server',
    title: 'Design episode two',
    projectRevision: 12,
  });
  assert.equal(created.provider, 'codex');
  assert.equal(created.turnCount, 0);
  assert.equal(created.messageCount, 0);
  assert.equal(created.attachmentCount, 0);

  await store.setProviderState(created.id, {
    runtimeMode: 'app_server',
    providerThreadId: 'thread_abc-123',
    providerThreadArchived: false,
  });
  const reference = {
    assetNodeId: 'asset.reference.aaaaaaaaaaaaaaaaaaaaaaaa',
    filename: 'Mira.png',
    mimeType: 'image/png',
    sha256: 'a'.repeat(64),
    relativePath: 'director-assets/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png',
    byteSize: 1234,
  };
  await store.appendTurn(created.id, {
    userText: 'Keep Mira consistent and rebuild scene four.',
    userAttachments: [reference],
    assistantText: 'I rebuilt scene four and preserved Mira continuity.',
    projectRevision: 13,
    runtimeMode: 'app_server',
    providerThreadId: 'thread_abc-123',
  });
  await store.appendTurn(created.id, {
    userText: 'Save this direction.',
    assistantText: 'Saved.',
    projectRevision: 13,
    runtimeMode: 'app_server',
    providerThreadId: 'thread_abc-123',
  });

  const active = await store.list({ archived: false });
  assert.equal(active.length, 1);
  assert.equal(active[0].id, created.id);
  assert.equal(active[0].turnCount, 2);
  assert.equal(active[0].messageCount, 4);
  assert.equal(active[0].attachmentCount, 1);
  assert.equal(active[0].providerThreadId, 'thread_abc-123');
  assert.match(active[0].preview, /Saved/);

  const persisted = await store.read(created.id);
  assert.equal(persisted.schemaVersion, 2);
  assert.equal(persisted.messages.length, 4);
  assert.equal(persisted.messages[0].attachments[0].assetNodeId, reference.assetNodeId);
  assert.equal(persisted.lastProjectRevision, 13);

  // A fresh store instance proves the archive and attachment links survive restart.
  const restarted = new ConversationStore({ rootDirectory: root });
  const resumed = await restarted.read(created.id);
  assert.equal(resumed.providerThreadId, 'thread_abc-123');
  assert.equal(resumed.messages[0].text, 'Keep Mira consistent and rebuild scene four.');
  assert.equal(resumed.messages[0].attachments[0].sha256, reference.sha256);

  const renamed = await restarted.rename(created.id, 'Episode 2 · Mira continuity');
  assert.equal(renamed.title, 'Episode 2 · Mira continuity');

  const archived = await restarted.archive(created.id, true);
  assert.ok(archived.archivedAt);
  assert.equal(archived.providerThreadArchived, true);
  assert.equal((await restarted.list({ archived: false })).length, 0);
  assert.equal((await restarted.list({ archived: true })).length, 1);

  const unarchived = await restarted.unarchive(created.id, false);
  assert.equal(unarchived.archivedAt, null);
  assert.equal(unarchived.providerThreadArchived, false);

  await restarted.appendFailure(created.id, {
    userText: 'This turn failed.',
    userAttachments: [reference],
    message: 'simulated provider failure',
    projectRevision: 14,
  });
  const afterFailure = await restarted.read(created.id);
  assert.equal(afterFailure.messages.at(-2)?.delivery, 'failed');
  assert.equal(afterFailure.messages.at(-2)?.attachments.length, 1);
  assert.equal(afterFailure.messages.at(-1)?.role, 'system');

  // Legacy schema v1 remains readable and is normalized in-memory to v2.
  const legacyId = 'legacy-conversation';
  await writeFile(join(root, `${legacyId}.json`), JSON.stringify({
    schemaVersion: 1,
    id: legacyId,
    provider: 'codex',
    runtimeMode: 'none',
    providerThreadId: null,
    providerThreadArchived: false,
    title: 'Legacy archive',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    turnCount: 1,
    lastProjectRevision: 1,
    messages: [{
      id: 'legacy-message',
      role: 'user',
      text: 'Old conversation stays readable.',
      createdAt: '2026-01-01T00:00:00.000Z',
      projectRevision: 1,
      delivery: 'complete',
    }],
  }), 'utf8');
  const legacy = await restarted.read(legacyId);
  assert.equal(legacy.schemaVersion, 2);
  assert.deepEqual(legacy.messages[0].attachments, []);
  await restarted.rename(legacyId, 'Legacy upgraded');
  assert.equal(JSON.parse(await readFile(join(root, `${legacyId}.json`), 'utf8')).schemaVersion, 2);

  // Corrupt unrelated files are isolated from the picker instead of bricking it.
  await writeFile(join(root, 'corrupt.json'), '{not-json', 'utf8');
  const safeList = await restarted.list({ archived: false });
  assert.equal(safeList.length, 2);

  // Serialized mutations must not lose writes even when scheduled concurrently.
  await Promise.all([
    restarted.rename(created.id, 'Concurrent A'),
    restarted.rename(created.id, 'Concurrent B'),
    restarted.rename(created.id, 'Concurrent C'),
  ]);
  const afterConcurrentWrites = await restarted.read(created.id);
  assert.ok(['Concurrent A', 'Concurrent B', 'Concurrent C'].includes(afterConcurrentWrites.title));
  assert.equal(afterConcurrentWrites.messages.length, 6, 'concurrent metadata writes must not lose transcript messages');
  assert.equal(afterConcurrentWrites.messages[0].attachments.length, 1, 'concurrent metadata writes must not lose reference links');

  assert.equal(conversationStoreLimits.maxAttachmentsPerMessage, 8);
  const tooMany = Array.from({ length: 9 }, (_, index) => ({
    ...reference,
    assetNodeId: `asset.reference.${String(index).padStart(24, '0')}`,
    sha256: index.toString(16).padStart(64, '0'),
  }));
  await assert.rejects(store.appendTurn(created.id, {
    userText: 'Too many images', userAttachments: tooMany, assistantText: 'never',
    projectRevision: 14, runtimeMode: 'app_server', providerThreadId: 'thread_abc-123',
  }), /at most 8 attachments/);

  const deleted = await restarted.delete(created.id);
  assert.equal(deleted.id, created.id);
  await assert.rejects(restarted.read(created.id), /not found/);
  await restarted.delete(legacyId);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('director conversation-store check: passed');
