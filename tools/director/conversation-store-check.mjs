import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationStore } from './conversation-store.mjs';

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

  await store.setProviderState(created.id, {
    runtimeMode: 'app_server',
    providerThreadId: 'thread_abc-123',
    providerThreadArchived: false,
  });
  await store.appendTurn(created.id, {
    userText: 'Keep Mira consistent and rebuild scene four.',
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
  assert.equal(active[0].providerThreadId, 'thread_abc-123');
  assert.match(active[0].preview, /Saved/);

  const persisted = await store.read(created.id);
  assert.equal(persisted.messages.length, 4);
  assert.equal(persisted.lastProjectRevision, 13);

  // A fresh store instance proves the archive is process/restart durable.
  const restarted = new ConversationStore({ rootDirectory: root });
  const resumed = await restarted.read(created.id);
  assert.equal(resumed.providerThreadId, 'thread_abc-123');
  assert.equal(resumed.messages[0].text, 'Keep Mira consistent and rebuild scene four.');

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
    message: 'simulated provider failure',
    projectRevision: 14,
  });
  const afterFailure = await restarted.read(created.id);
  assert.equal(afterFailure.messages.at(-2)?.delivery, 'failed');
  assert.equal(afterFailure.messages.at(-1)?.role, 'system');

  // Corrupt unrelated files are isolated from the picker instead of bricking it.
  await writeFile(join(root, 'corrupt.json'), '{not-json', 'utf8');
  const safeList = await restarted.list({ archived: false });
  assert.equal(safeList.length, 1);

  // Serialized mutations must not lose writes even when scheduled concurrently.
  await Promise.all([
    restarted.rename(created.id, 'Concurrent A'),
    restarted.rename(created.id, 'Concurrent B'),
    restarted.rename(created.id, 'Concurrent C'),
  ]);
  const afterConcurrentWrites = await restarted.read(created.id);
  assert.ok(['Concurrent A', 'Concurrent B', 'Concurrent C'].includes(afterConcurrentWrites.title));
  assert.equal(afterConcurrentWrites.messages.length, 6, 'concurrent metadata writes must not lose transcript messages');

  const deleted = await restarted.delete(created.id);
  assert.equal(deleted.id, created.id);
  await assert.rejects(restarted.read(created.id), /not found/);
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('director conversation-store check: passed');
