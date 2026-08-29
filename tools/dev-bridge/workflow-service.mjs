function nativeResult(response, operation) {
  if (!response?.ok) {
    const error = new Error(response?.error?.message || `${operation} failed`);
    error.code = response?.error?.code || 'native_error';
    throw error;
  }
  return response.result;
}

function commitContext({ actor = 'user', source, planId = '', reason }) {
  if (actor !== 'user' && actor !== 'ai_director' && actor !== 'system') {
    throw new Error('workflow commit actor is invalid');
  }
  return {
    actor,
    source: String(source ?? '').slice(0, 160),
    planId: String(planId ?? '').slice(0, 192),
    reason: String(reason ?? '').slice(0, 1024),
  };
}

function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('expectedProjectRevision must be a non-negative integer');
  }
  return value;
}

export class WorkflowService {
  constructor({ rpc, store }) {
    if (typeof rpc !== 'function') throw new Error('WorkflowService requires native rpc');
    if (!store) throw new Error('WorkflowService requires a WorkflowStore');
    this.rpc = rpc;
    this.store = store;
  }

  async snapshot() {
    return nativeResult(await this.rpc('project.snapshot'), 'project snapshot');
  }

  async history(limit = 10) {
    return nativeResult(await this.rpc('project.history', { limit }), 'project history');
  }

  async impact(source) {
    return nativeResult(await this.rpc('project.impact', { source }), 'project impact');
  }

  async apply({ expectedProjectRevision, commands, actor = 'user', source = 'workflow-service', planId = '', reason }) {
    const result = await this.rpc('project.apply', {
      expectedProjectRevision: expectedRevision(expectedProjectRevision),
      commands,
      context: commitContext({ actor, source, planId, reason }),
    });
    return nativeResult(result, 'project apply');
  }

  async saveWorkflow({ name, description = '' }) {
    const snapshot = await this.snapshot();
    return this.store.save(snapshot, { name, description, kind: 'saved' });
  }

  async listWorkflows({ includeRecovery = true } = {}) {
    return this.store.list({ includeRecovery });
  }

  async deleteWorkflow({ workflowId }) {
    return this.store.delete(workflowId);
  }

  async #restoreWithRecovery({ targetSnapshot, expectedProjectRevision, actor, source, planId, reason }) {
    const expected = expectedRevision(expectedProjectRevision);
    const before = await this.snapshot();
    if (before.projectRevision !== expected) {
      const error = new Error(`project revision changed from ${expected} to ${before.projectRevision}; inspect live state and retry`);
      error.code = 'revision_conflict';
      throw error;
    }

    const recovery = await this.store.saveRecovery(
      before,
      `${reason || 'workflow replacement'} · before revision ${before.projectRevision}`,
    );
    const restored = nativeResult(await this.rpc('project.restore', {
      expectedProjectRevision: expected,
      snapshot: targetSnapshot,
      context: commitContext({ actor, source, planId, reason }),
    }), 'workflow restore');
    return { ...restored, recoveryWorkflow: recovery };
  }

  async newWorkflow({ expectedProjectRevision, actor = 'user', source = 'workflow-new', planId = '', reason = 'create clean workflow' }) {
    return this.#restoreWithRecovery({
      targetSnapshot: {
        schemaVersion: 1,
        projectRevision: 0,
        nodes: [],
        dependencies: [],
      },
      expectedProjectRevision,
      actor,
      source,
      planId,
      reason,
    });
  }

  async loadWorkflow({ workflowId, expectedProjectRevision, actor = 'user', source = 'workflow-load', planId = '', reason = 'load saved workflow' }) {
    const record = await this.store.read(workflowId);
    const restored = await this.#restoreWithRecovery({
      targetSnapshot: record.snapshot,
      expectedProjectRevision,
      actor,
      source,
      planId,
      reason,
    });
    return {
      ...restored,
      loadedWorkflow: {
        id: record.id,
        kind: record.kind,
        name: record.name,
        description: record.description,
        sourceProjectRevision: record.sourceProjectRevision,
      },
    };
  }

  directorRuntime() {
    return {
      snapshot: () => this.snapshot(),
      history: (limit) => this.history(limit),
      impact: (source) => this.impact(source),
      apply: ({ expectedProjectRevision, commands, reason, callId }) => this.apply({
        expectedProjectRevision,
        commands,
        actor: 'ai_director',
        source: 'codex-dynamic-tool',
        planId: callId,
        reason,
      }),
      newWorkflow: ({ expectedProjectRevision, reason, callId }) => this.newWorkflow({
        expectedProjectRevision,
        actor: 'ai_director',
        source: 'codex-workflow-new',
        planId: callId,
        reason,
      }),
      saveWorkflow: ({ name, description }) => this.saveWorkflow({ name, description }),
      listWorkflows: ({ includeRecovery }) => this.listWorkflows({ includeRecovery }),
      loadWorkflow: ({ workflowId, expectedProjectRevision, reason, callId }) => this.loadWorkflow({
        workflowId,
        expectedProjectRevision,
        actor: 'ai_director',
        source: 'codex-workflow-load',
        planId: callId,
        reason,
      }),
      deleteWorkflow: ({ workflowId }) => this.deleteWorkflow({ workflowId }),
    };
  }
}
