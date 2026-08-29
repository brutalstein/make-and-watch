import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from '@xyflow/react';
import {
  Clapperboard,
  Eye,
  GitMerge,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  Lock,
  Plus,
  RefreshCw,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import type { ProjectCommand, ProjectGraphSnapshot, ProjectNode } from '@makewatch/contracts';

import { engineClient } from './engineClient';
import { generationClient, type GenerationProviderStatus, type SceneGenerationJob } from './generationClient';
import { announceProjectChanged, PROJECT_CHANGED_EVENT } from './projectEvents';

type MenuState = {
  x: number;
  y: number;
  nodeId: string | null;
  selectionIds: string[];
};

function node(snapshot: ProjectGraphSnapshot | null, id: string | null) {
  return id ? snapshot?.nodes.find((candidate) => candidate.id === id) ?? null : null;
}

function selectedNodes(snapshot: ProjectGraphSnapshot | null, ids: string[]) {
  if (!snapshot) return [];
  const selected = new Set(ids);
  return snapshot.nodes.filter((candidate) => selected.has(candidate.id));
}

function safeNextIndex(snapshot: ProjectGraphSnapshot, kind: 'scene' | 'shot') {
  return snapshot.nodes
    .filter((candidate) => candidate.kind === kind)
    .reduce((maximum, candidate) => {
      const value = Number(candidate.metadata.index ?? candidate.metadata.shotNumber ?? '0');
      return Number.isFinite(value) ? Math.max(maximum, Math.floor(value)) : maximum;
    }, 0) + 1;
}

function contextPosition(event: MouseEvent) {
  const width = 312;
  const height = 480;
  return {
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
  };
}

export function WorkflowContextMenuDock() {
  const flow = useReactFlow();
  const [snapshot, setSnapshot] = useState<ProjectGraphSnapshot | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [provider, setProvider] = useState<GenerationProviderStatus | null>(null);
  const [job, setJob] = useState<SceneGenerationJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const jobIdRef = useRef<string | null>(null);

  const refreshSnapshot = useCallback(async () => {
    const next = await engineClient.snapshot();
    setSnapshot(next);
    return next;
  }, []);

  const refreshProvider = useCallback(async () => {
    const next = await generationClient.provider().catch((error) => ({
      provider: 'comfyui' as const,
      online: false,
      mode: 'storyboard-preview' as const,
      detail: error instanceof Error ? error.message : String(error),
    }));
    setProvider(next);
    return next;
  }, []);

  useEffect(() => {
    void Promise.all([refreshSnapshot(), refreshProvider()]);
    const onProjectChanged = () => { void refreshSnapshot(); };
    window.addEventListener(PROJECT_CHANGED_EVENT, onProjectChanged);
    return () => window.removeEventListener(PROJECT_CHANGED_EVENT, onProjectChanged);
  }, [refreshProvider, refreshSnapshot]);

  useEffect(() => {
    const onContextMenu = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const surface = target?.closest('.flow-surface');
      if (!surface) return;
      event.preventDefault();
      const nodeElement = target?.closest<HTMLElement>('.react-flow__node') ?? null;
      const nodeId = nodeElement?.dataset.id ?? null;
      const selected = flow.getNodes().filter((candidate) => candidate.selected).map((candidate) => candidate.id);
      const selectionIds = nodeId && !selected.includes(nodeId) ? [nodeId] : selected;
      const position = contextPosition(event);
      setMenu({ ...position, nodeId, selectionIds });
      if (nodeElement) {
        nodeElement.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: event.clientX, clientY: event.clientY }));
      }
    };
    const onPointer = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.workflow-context-menu')) return;
      setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
      if (flow.getNodes().some((candidate) => candidate.selected)) {
        // React Flow must never delete authoritative project nodes locally.
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [flow]);

  useEffect(() => {
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return;
    jobIdRef.current = job.id;
    let cancelled = false;
    const poll = async () => {
      while (!cancelled && jobIdRef.current === job.id) {
        await new Promise((resolvePromise) => window.setTimeout(resolvePromise, 700));
        if (cancelled) return;
        try {
          const next = (await generationClient.job(job.id)).job;
          if (cancelled) return;
          setJob(next);
          if (next.status === 'completed' || next.status === 'failed') {
            const live = await refreshSnapshot().catch(() => null);
            if (live) announceProjectChanged({ projectRevision: live.projectRevision, source: 'external' });
            return;
          }
        } catch (error) {
          if (!cancelled) setNotice(error instanceof Error ? error.message : String(error));
          return;
        }
      }
    };
    void poll();
    return () => { cancelled = true; };
  }, [job?.id, job?.status, refreshSnapshot]);

  const clicked = node(snapshot, menu?.nodeId ?? null);
  const selection = useMemo(
    () => selectedNodes(snapshot, menu?.selectionIds ?? []),
    [menu?.selectionIds, snapshot],
  );
  const selectedScene = selection.length === 1 && selection[0]?.kind === 'scene' ? selection[0] : null;

  const commit = useCallback(async (build: (live: ProjectGraphSnapshot) => ProjectCommand[], reason: string) => {
    setBusy(true);
    setNotice('');
    try {
      const live = await engineClient.snapshot();
      const commands = build(live);
      if (commands.length === 0) {
        setNotice('Nothing to change.');
        return;
      }
      const result = await engineClient.apply(commands, {
        actor: 'user',
        source: 'studio-context-menu',
        reason,
      }, live.projectRevision);
      setSnapshot(result.snapshot);
      announceProjectChanged({ projectRevision: result.projectRevision, source: 'external' });
      setMenu(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const addScene = useCallback(() => {
    void commit((live) => {
      const episode = clicked?.kind === 'episode'
        ? live.nodes.find((candidate) => candidate.id === clicked.id && candidate.kind === 'episode')
        : live.nodes.find((candidate) => candidate.kind === 'episode');
      if (!episode) throw new Error('Create an Episode before adding a Scene.');
      const index = safeNextIndex(live, 'scene');
      const id = `scene.${crypto.randomUUID()}`;
      return [
        {
          type: 'node.create',
          node: {
            id,
            kind: 'scene',
            title: `Scene ${String(index).padStart(2, '0')}`,
            metadata: { index: String(index), durationSeconds: '30', summary: 'New scene' },
            approval: 'draft',
            locked: false,
            stale: false,
          },
        },
        { type: 'dependency.add', dependent: id, dependency: episode.id },
        { type: 'node.markFresh', id },
      ];
    }, 'create scene from workflow context menu');
  }, [clicked, commit]);

  const addShot = useCallback((scene: ProjectNode) => {
    void commit((live) => {
      const currentScene = live.nodes.find((candidate) => candidate.id === scene.id && candidate.kind === 'scene');
      if (!currentScene) throw new Error('Scene no longer exists.');
      if (currentScene.locked) throw new Error('Unlock the Scene before adding a Shot.');
      const index = safeNextIndex(live, 'shot');
      const id = `shot.${crypto.randomUUID()}`;
      return [
        {
          type: 'node.create',
          node: {
            id,
            kind: 'shot',
            title: `Shot ${String(index).padStart(3, '0')}`,
            metadata: {
              index: String(index),
              durationSeconds: '4',
              framing: 'medium',
              camera: 'static',
              generationStrategy: 'T2I-preview',
            },
            approval: 'draft',
            locked: false,
            stale: false,
          },
        },
        { type: 'dependency.add', dependent: id, dependency: currentScene.id },
        { type: 'node.markFresh', id },
      ];
    }, `add shot to ${scene.id}`);
  }, [commit]);

  const linkSelectionIntoClicked = useCallback(() => {
    if (!clicked) return;
    void commit((live) => {
      const selected = new Set(menu?.selectionIds ?? []);
      selected.delete(clicked.id);
      return [...selected]
        .filter((id) => live.nodes.some((candidate) => candidate.id === id))
        .filter((id) => !live.dependencies.some((edge) => edge.dependent === clicked.id && edge.dependency === id))
        .map((id) => ({ type: 'dependency.add', dependent: clicked.id, dependency: id } as ProjectCommand));
    }, `link selected nodes as dependencies of ${clicked.id}`);
  }, [clicked, commit, menu?.selectionIds]);

  const feedClickedIntoSelection = useCallback(() => {
    if (!clicked) return;
    void commit((live) => {
      const selected = new Set(menu?.selectionIds ?? []);
      selected.delete(clicked.id);
      return [...selected]
        .filter((id) => live.nodes.some((candidate) => candidate.id === id))
        .filter((id) => !live.dependencies.some((edge) => edge.dependent === id && edge.dependency === clicked.id))
        .map((id) => ({ type: 'dependency.add', dependent: id, dependency: clicked.id } as ProjectCommand));
    }, `feed ${clicked.id} into selected nodes`);
  }, [clicked, commit, menu?.selectionIds]);

  const toggleLock = useCallback(() => {
    if (!clicked) return;
    void commit((live) => {
      const current = live.nodes.find((candidate) => candidate.id === clicked.id);
      if (!current) throw new Error('Node no longer exists.');
      return [{ type: 'node.lock', id: current.id, locked: !current.locked, expectedRevision: current.revision }];
    }, clicked.locked ? `unlock ${clicked.id}` : `lock ${clicked.id}`);
  }, [clicked, commit]);

  const removeClicked = useCallback(() => {
    if (!clicked || clicked.locked) return;
    if (!window.confirm(`Delete “${clicked.title}” from the authoritative project graph?`)) return;
    void commit((live) => {
      const current = live.nodes.find((candidate) => candidate.id === clicked.id);
      if (!current) return [];
      return [{ type: 'node.remove', id: current.id, expectedRevision: current.revision }];
    }, `delete ${clicked.id} from workflow context menu`);
  }, [clicked, commit]);

  const generateScene = useCallback(async (scene: ProjectNode) => {
    setBusy(true);
    setNotice('');
    setMenu(null);
    try {
      const status = await refreshProvider();
      if (!status.online) throw new Error(status.detail || 'ComfyUI is offline. Start ComfyUI on port 8188 first.');
      const started = await generationClient.startScene(scene.id);
      setJob(started.job);
      setNotice(`Generating ${scene.title} · ${started.job.shotCount} shot preview${started.job.shotCount === 1 ? '' : 's'}`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [refreshProvider]);

  const focusClicked = useCallback(async () => {
    if (!clicked) return;
    setMenu(null);
    await flow.fitView({ nodes: [{ id: clicked.id }], padding: 0.65, duration: 350, maxZoom: 1.15 });
  }, [clicked, flow]);

  const sync = useCallback(async () => {
    setBusy(true);
    try {
      const live = await refreshSnapshot();
      announceProjectChanged({ projectRevision: live.projectRevision, source: 'external' });
      await refreshProvider();
      setMenu(null);
    } finally {
      setBusy(false);
    }
  }, [refreshProvider, refreshSnapshot]);

  const canLink = Boolean(clicked && menu && menu.selectionIds.some((id) => id !== clicked.id));
  const menuScene = clicked?.kind === 'scene' ? clicked : selectedScene;

  return (
    <>
      {menu ? (
        <div className="workflow-context-menu" style={{ left: menu.x, top: menu.y }} role="menu" aria-label="Workflow actions">
          <div className="workflow-context-menu__head">
            <div>
              <small>{clicked ? clicked.kind.toUpperCase() : 'WORKFLOW'}</small>
              <strong>{clicked?.title ?? `${menu.selectionIds.length} selected nodes`}</strong>
            </div>
            <button onClick={() => setMenu(null)} title="Close"><X size={13} /></button>
          </div>

          {clicked ? <button onClick={() => void focusClicked()}><Eye size={14} /><span>Focus node</span></button> : null}
          {clicked?.kind === 'episode' ? <button onClick={addScene}><Plus size={14} /><span>Add Scene</span></button> : null}
          {menuScene ? <button onClick={() => addShot(menuScene)} disabled={menuScene.locked}><Clapperboard size={14} /><span>Add Shot to Scene</span></button> : null}
          {menuScene ? (
            <button className="workflow-context-menu__primary" onClick={() => void generateScene(menuScene)} disabled={busy || !provider?.online}>
              {busy ? <LoaderCircle size={14} className="spin" /> : <ImageIcon size={14} />}
              <span>Generate Scene Preview</span>
              {!provider?.online ? <small>ComfyUI offline</small> : null}
            </button>
          ) : null}

          {canLink ? <div className="workflow-context-menu__separator" /> : null}
          {canLink ? <button onClick={linkSelectionIntoClicked}><GitMerge size={14} /><span>Selected → this node</span></button> : null}
          {canLink ? <button onClick={feedClickedIntoSelection}><Link2 size={14} /><span>This node → selected</span></button> : null}

          {clicked ? <div className="workflow-context-menu__separator" /> : null}
          {clicked ? (
            <button onClick={toggleLock} disabled={busy}>
              {clicked.locked ? <Unlock size={14} /> : <Lock size={14} />}
              <span>{clicked.locked ? 'Unlock node' : 'Lock node'}</span>
            </button>
          ) : null}
          {clicked ? <button className="danger" onClick={removeClicked} disabled={clicked.locked || busy}><Trash2 size={14} /><span>Delete node</span></button> : null}

          {!clicked ? <button onClick={addScene}><Plus size={14} /><span>Add Scene</span></button> : null}
          {!clicked && selectedScene ? <button onClick={() => addShot(selectedScene)}><Clapperboard size={14} /><span>Add Shot to selected Scene</span></button> : null}
          <button onClick={() => void sync()} disabled={busy}><RefreshCw size={14} className={busy ? 'spin' : ''} /><span>Sync native workflow</span></button>
        </div>
      ) : null}

      {(job || notice) ? (
        <aside className="generation-monitor" aria-live="polite">
          <div className="generation-monitor__head">
            <div>
              <small>LOCAL GENERATION</small>
              <strong>{job?.sceneTitle ?? 'Scene Preview'}</strong>
            </div>
            <button onClick={() => { setJob(null); setNotice(''); }} title="Dismiss"><X size={13} /></button>
          </div>
          {job ? (
            <>
              <div className="generation-monitor__status">
                <span>{job.status}</span>
                <span>{job.completedShots}/{job.shotCount} shots</span>
                <span>{job.progress}%</span>
              </div>
              <div className="generation-monitor__bar"><i style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} /></div>
              {job.currentShotId ? <small>Rendering {job.currentShotId}</small> : null}
              {job.error ? <p className="generation-monitor__error">{job.error}</p> : null}
              {job.artifacts.length ? (
                <div className="generation-monitor__artifacts">
                  {job.artifacts.map((artifact) => (
                    <figure key={artifact.shotId}>
                      <img src={generationClient.artifactUrl(job.id, artifact.shotId)} alt={`Generated storyboard frame for ${artifact.shotId}`} />
                      <figcaption>{artifact.shotId}</figcaption>
                    </figure>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
          {notice ? <p>{notice}</p> : null}
          <small className={`generation-monitor__provider ${provider?.online ? 'is-online' : ''}`}>
            {provider?.online ? `ComfyUI · ${provider.checkpoint ?? 'checkpoint ready'}` : provider?.detail ?? 'Generation gateway checking ComfyUI…'}
          </small>
        </aside>
      ) : null}
    </>
  );
}
