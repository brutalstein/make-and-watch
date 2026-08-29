import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkflowStore, workflowStoreLimits } from './workflow-store.mjs';

const root = await mkdtemp(join(tmpdir(), 'makewatch-workflow-store-'));
try {
  const store = new WorkflowStore({ rootDirectory: root });
  const snapshot = {
    schemaVersion: 1,
    projectRevision: 4,
    nodes: [{ id: 'scene.one', kind: 'scene', title: 'Scene One', metadata: {}, revision: 1, approval: 'draft', locked: false, stale: false }],
    dependencies: [],
  };

  const saved = await store.save(snapshot, { name: 'Draft One', description: 'manual save' });
  assert.equal(saved.kind, 'saved');
  assert.equal(saved.nodeCount, 1);
  assert.equal(saved.sourceProjectRevision, 4);

  const record = await store.read(saved.id);
  assert.equal(record.snapshot.nodes[0].id, 'scene.one');
  assert.equal(record.name, 'Draft One');

  const listed = await store.list({ includeRecovery: false });
  assert.equal(listed.issues.length, 0);
  assert.equal(listed.workflows.length, 1);
  assert.equal(listed.workflows[0].id, saved.id);

  await assert.rejects(store.read('../outside'), /workflow id is invalid/);

  for (let index = 0; index < workflowStoreLimits.maxRecoveryItems + 2; index += 1) {
    await store.saveRecovery({ ...snapshot, projectRevision: 5 + index }, `recovery ${index}`);
  }
  const withRecovery = await store.list({ includeRecovery: true });
  const recoveries = withRecovery.workflows.filter((workflow) => workflow.kind === 'recovery');
  assert.equal(recoveries.length, workflowStoreLimits.maxRecoveryItems, 'old recovery checkpoints must be pruned');

  const removed = await store.delete(saved.id);
  assert.equal(removed.id, saved.id);
  await assert.rejects(store.read(saved.id));

  console.log('workflow store check: passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
