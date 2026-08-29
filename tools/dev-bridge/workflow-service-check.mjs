import assert from 'node:assert/strict';

import { WorkflowService } from './workflow-service.mjs';

const baseSnapshot = {
  schemaVersion: 1,
  projectRevision: 9,
  nodes: [{ id: 'scene.current', kind: 'scene', title: 'Current', metadata: {}, revision: 1, approval: 'draft', locked: false, stale: false }],
  dependencies: [],
};

function fixture({ checkpointFailure = false } = {}) {
  const calls = [];
  let liveSnapshot = structuredClone(baseSnapshot);
  const rpc = async (method, params = {}) => {
    calls.push(['rpc', method, params]);
    if (method === 'project.snapshot') return { ok: true, result: structuredClone(liveSnapshot) };
    if (method === 'project.history') return { ok: true, result: { transactions: [] } };
    if (method === 'project.impact') return { ok: true, result: { affected: [], locked: [], alreadyStale: [] } };
    if (method === 'project.apply') {
      return { ok: true, result: { projectRevision: liveSnapshot.projectRevision + 1, events: [], snapshot: liveSnapshot } };
    }
    if (method === 'project.restore') {
      if (params.expectedProjectRevision !== liveSnapshot.projectRevision) {
        return { ok: false, error: { code: 'revision_conflict', message: 'stale restore' } };
      }
      liveSnapshot = { ...structuredClone(params.snapshot), projectRevision: liveSnapshot.projectRevision + 1 };
      return { ok: true, result: { projectRevision: liveSnapshot.projectRevision, events: [], snapshot: structuredClone(liveSnapshot) } };
    }
    throw new Error(`unexpected RPC ${method}`);
  };

  const records = new Map();
  const store = {
    saveRecovery: async (snapshot, reason) => {
      calls.push(['checkpoint', snapshot.projectRevision, reason]);
      if (checkpointFailure) throw new Error('checkpoint disk full');
      const summary = { id: 'recovery-test-12345678', kind: 'recovery', name: 'Recovery', description: reason, createdAt: '', updatedAt: '', sourceProjectRevision: snapshot.projectRevision, nodeCount: snapshot.nodes.length, dependencyCount: snapshot.dependencies.length };
      return summary;
    },
    save: async (snapshot, meta) => ({ id: 'wf-saved-12345678', kind: meta.kind, name: meta.name, description: meta.description, sourceProjectRevision: snapshot.projectRevision, nodeCount: snapshot.nodes.length, dependencyCount: snapshot.dependencies.length }),
    list: async () => ({ workflows: [], issues: [] }),
    read: async (id) => records.get(id),
    delete: async (id) => ({ id, kind: 'saved', name: 'Deleted', description: '', sourceProjectRevision: 1, nodeCount: 0, dependencyCount: 0 }),
  };
  records.set('wf-load-12345678', {
    id: 'wf-load-12345678',
    kind: 'saved',
    name: 'Loaded Draft',
    description: 'saved workflow',
    sourceProjectRevision: 2,
    snapshot: { schemaVersion: 1, projectRevision: 2, nodes: [], dependencies: [] },
  });
  return { service: new WorkflowService({ rpc, store }), calls, getLive: () => liveSnapshot };
}

{
  const { service, calls, getLive } = fixture();
  const result = await service.newWorkflow({
    expectedProjectRevision: 9,
    actor: 'ai_director',
    source: 'codex-workflow-new',
    planId: 'call-1',
    reason: 'user asked for a clean workflow',
  });
  assert.equal(result.projectRevision, 10);
  assert.equal(getLive().nodes.length, 0);
  const checkpointIndex = calls.findIndex((entry) => entry[0] === 'checkpoint');
  const restoreIndex = calls.findIndex((entry) => entry[0] === 'rpc' && entry[1] === 'project.restore');
  assert.ok(checkpointIndex >= 0 && restoreIndex > checkpointIndex, 'recovery checkpoint must finish before native restore');
  const restore = calls[restoreIndex][2];
  assert.equal(restore.context.actor, 'ai_director');
  assert.equal(restore.context.source, 'codex-workflow-new');
  assert.equal(restore.context.planId, 'call-1');
  assert.equal(restore.context.reason, 'user asked for a clean workflow');
}

{
  const { service, calls } = fixture();
  await assert.rejects(
    service.newWorkflow({ expectedProjectRevision: 8, reason: 'stale request' }),
    (error) => error?.code === 'revision_conflict',
  );
  assert.equal(calls.some((entry) => entry[0] === 'checkpoint'), false, 'stale request must not create recovery noise');
  assert.equal(calls.some((entry) => entry[0] === 'rpc' && entry[1] === 'project.restore'), false, 'stale request must not restore');
}

{
  const { service, calls } = fixture({ checkpointFailure: true });
  await assert.rejects(
    service.newWorkflow({ expectedProjectRevision: 9, reason: 'clean workflow' }),
    /checkpoint disk full/,
  );
  assert.equal(calls.some((entry) => entry[0] === 'rpc' && entry[1] === 'project.restore'), false, 'checkpoint failure must fail closed before destructive restore');
}

{
  const { service, calls } = fixture();
  const loaded = await service.loadWorkflow({
    workflowId: 'wf-load-12345678',
    expectedProjectRevision: 9,
    actor: 'ai_director',
    source: 'codex-workflow-load',
    planId: 'call-load',
    reason: 'load the saved draft',
  });
  assert.equal(loaded.loadedWorkflow.name, 'Loaded Draft');
  assert.equal(loaded.projectRevision, 10);
  const restore = calls.find((entry) => entry[0] === 'rpc' && entry[1] === 'project.restore')[2];
  assert.equal(restore.context.planId, 'call-load');
}

console.log('workflow service check: passed');
