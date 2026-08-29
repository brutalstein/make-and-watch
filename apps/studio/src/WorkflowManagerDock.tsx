import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SavedWorkflowSummary } from '@makewatch/contracts';
import {
  ArchiveRestore,
  FilePlus2,
  FolderOpen,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';

import { engineClient } from './engineClient';
import { PROJECT_CHANGED_EVENT } from './projectEvents';

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown time';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function workflowMeta(workflow: SavedWorkflowSummary) {
  return `${workflow.nodeCount} nodes · ${workflow.dependencyCount} deps · source rev ${workflow.sourceProjectRevision}`;
}

export function WorkflowManagerDock() {
  const [open, setOpen] = useState(false);
  const [workflows, setWorkflows] = useState<SavedWorkflowSummary[]>([]);
  const [issues, setIssues] = useState<Array<{ file: string; message: string }>>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState<string | null>(null);

  const saved = useMemo(() => workflows.filter((workflow) => workflow.kind === 'saved'), [workflows]);
  const recoveries = useMemo(() => workflows.filter((workflow) => workflow.kind === 'recovery'), [workflows]);

  const refresh = useCallback(async () => {
    try {
      const result = await engineClient.workflows(true);
      setWorkflows(result.workflows);
      setIssues(result.issues);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  useEffect(() => {
    const onProjectChanged = () => {
      if (open) void refresh();
    };
    window.addEventListener(PROJECT_CHANGED_EVENT, onProjectChanged);
    return () => window.removeEventListener(PROJECT_CHANGED_EVENT, onProjectChanged);
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDeleteArmed(null);
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const run = useCallback(async (operation: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    setDeleteArmed(null);
    try {
      await operation();
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const saveCurrent = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Give this workflow a name before saving.');
      return;
    }
    void run(async () => {
      const result = await engineClient.saveWorkflow(trimmed, description.trim());
      setName('');
      setDescription('');
      setNotice(`Saved “${result.workflow.name}”.`);
    });
  }, [description, name, run]);

  const newWorkflow = useCallback(() => {
    void run(async () => {
      const live = await engineClient.snapshot();
      const result = await engineClient.newWorkflow(
        live.projectRevision,
        'user created a clean workflow from Workflow Manager',
      );
      setNotice(`Clean workflow created at rev ${result.projectRevision}. Recovery checkpoint “${result.recoveryWorkflow.name}” was saved first.`);
    });
  }, [run]);

  const loadWorkflow = useCallback((workflow: SavedWorkflowSummary) => {
    void run(async () => {
      const live = await engineClient.snapshot();
      const result = await engineClient.loadWorkflow(
        workflow.id,
        live.projectRevision,
        `user loaded saved workflow ${workflow.name}`,
      );
      setNotice(`Loaded “${workflow.name}” at rev ${result.projectRevision}. Previous live state is recoverable as “${result.recoveryWorkflow.name}”.`);
    });
  }, [run]);

  const deleteWorkflow = useCallback((workflow: SavedWorkflowSummary) => {
    if (deleteArmed !== workflow.id) {
      setDeleteArmed(workflow.id);
      setNotice(`Press Delete again to remove saved copy “${workflow.name}”. The active project will not be deleted.`);
      return;
    }
    void run(async () => {
      await engineClient.deleteWorkflow(workflow.id);
      setNotice(`Deleted saved copy “${workflow.name}”.`);
    });
  }, [deleteArmed, run]);

  return (
    <>
      <button
        className="workflow-manager-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="workflow-manager-panel"
        title="New, save, load and recover workflows"
      >
        <FolderOpen size={14} />
        <span>Workflows</span>
      </button>

      {open ? (
        <aside id="workflow-manager-panel" className="workflow-manager-panel" aria-label="Workflow manager">
          <header className="workflow-manager-head">
            <div>
              <span className="workflow-manager-kicker">PROJECT LIBRARY</span>
              <strong>Workflows</strong>
              <small>Named snapshots + automatic recovery</small>
            </div>
            <div className="workflow-manager-head__actions">
              <button onClick={() => void refresh()} disabled={busy} title="Refresh saved workflows"><RefreshCw size={13} /></button>
              <button onClick={() => setOpen(false)} title="Close workflow manager"><X size={14} /></button>
            </div>
          </header>

          <section className="workflow-manager-create">
            <div className="workflow-manager-new-row">
              <button className="workflow-manager-new" onClick={newWorkflow} disabled={busy}>
                <FilePlus2 size={14} /> New clean workflow
              </button>
              <span><ShieldCheck size={12} /> auto-recovery first</span>
            </div>
            <label>
              <span>Save current workflow</span>
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                placeholder="Workflow name"
                disabled={busy}
              />
            </label>
            <label>
              <span>Description <em>optional</em></span>
              <textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                maxLength={800}
                placeholder="What is special about this version?"
                rows={2}
                disabled={busy}
              />
            </label>
            <button className="workflow-manager-save" onClick={saveCurrent} disabled={busy || !name.trim()}>
              <Save size={14} /> Save current
            </button>
          </section>

          {error ? <div className="workflow-manager-message workflow-manager-message--error">{error}</div> : null}
          {notice ? <div className="workflow-manager-message">{notice}</div> : null}
          {issues.length > 0 ? (
            <div className="workflow-manager-message workflow-manager-message--warning">
              {issues.length} saved workflow file{issues.length === 1 ? '' : 's'} could not be read. The valid library remains available.
            </div>
          ) : null}

          <section className="workflow-manager-list">
            <div className="workflow-manager-section-title">
              <span>Saved</span><small>{saved.length}</small>
            </div>
            {saved.length === 0 ? (
              <div className="workflow-manager-empty">No named workflows yet.</div>
            ) : saved.map((workflow) => (
              <article className="workflow-manager-item" key={workflow.id}>
                <div className="workflow-manager-item__body">
                  <strong>{workflow.name}</strong>
                  {workflow.description ? <p>{workflow.description}</p> : null}
                  <small>{workflowMeta(workflow)}</small>
                  <small>{formatDate(workflow.updatedAt)}</small>
                </div>
                <div className="workflow-manager-item__actions">
                  <button onClick={() => loadWorkflow(workflow)} disabled={busy} title={`Load ${workflow.name}`}><FolderOpen size={13} /> Load</button>
                  <button
                    className={deleteArmed === workflow.id ? 'workflow-manager-delete workflow-manager-delete--armed' : 'workflow-manager-delete'}
                    onClick={() => deleteWorkflow(workflow)}
                    disabled={busy}
                    title="Delete saved copy"
                  ><Trash2 size={13} /> {deleteArmed === workflow.id ? 'Confirm' : ''}</button>
                </div>
              </article>
            ))}

            <div className="workflow-manager-section-title workflow-manager-section-title--recovery">
              <span>Recovery</span><small>{recoveries.length}</small>
            </div>
            {recoveries.length === 0 ? (
              <div className="workflow-manager-empty">Recovery checkpoints appear automatically before New or Load.</div>
            ) : recoveries.map((workflow) => (
              <article className="workflow-manager-item workflow-manager-item--recovery" key={workflow.id}>
                <div className="workflow-manager-item__body">
                  <strong><ArchiveRestore size={12} /> {workflow.name}</strong>
                  <small>{workflowMeta(workflow)}</small>
                  <small>{formatDate(workflow.createdAt)}</small>
                </div>
                <button onClick={() => loadWorkflow(workflow)} disabled={busy} title="Restore this checkpoint"><ArchiveRestore size={13} /> Restore</button>
              </article>
            ))}
          </section>
        </aside>
      ) : null}
    </>
  );
}
