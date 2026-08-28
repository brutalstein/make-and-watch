import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useNodesState,
  type Edge,
  type Node as FlowNode,
  type ReactFlowInstance,
  type XYPosition,
} from '@xyflow/react';
import type {
  EngineHealth,
  ImpactReport,
  ProjectCommand,
  ProjectGraphSnapshot,
  ProjectNode,
  ProjectNodeKind,
  SystemTelemetry,
} from '@makewatch/contracts';
import {
  Activity,
  Bot,
  ChevronRight,
  Clapperboard,
  Cpu,
  Film,
  Gauge,
  GripVertical,
  Layers3,
  LayoutGrid,
  Lock,
  MapPin,
  MessageSquareText,
  Play,
  RefreshCw,
  Scan,
  Sparkles,
  Unlock,
  UserRound,
  WandSparkles,
} from 'lucide-react';

import { engineClient } from './engineClient';
import {
  defaultWorkflowPositions,
  resolveWorkflowPositions,
  saveWorkflowLayout,
  workflowProjectKey,
  type WorkflowPositions,
} from './workflowLayout';

type FlowState = 'ready' | 'review' | 'generating' | 'locked' | 'stale' | 'draft';

interface FlowCardProps {
  eyebrow: string;
  title: string;
  meta: string;
  state: FlowState;
  icon: ReactNode;
}

function FlowCard({ eyebrow, title, meta, state, icon }: FlowCardProps) {
  return (
    <div className={`flow-card flow-card--${state}`}>
      <div className="flow-card__topline">
        <span className="flow-card__icon">{icon}</span>
        <span>{eyebrow}</span>
        <span className="flow-card__state">{state}</span>
        <span className="flow-card__drag" title="Drag to reposition"><GripVertical size={11} /></span>
      </div>
      <strong>{title}</strong>
      <span className="flow-card__meta">{meta}</span>
    </div>
  );
}

function nodeState(node: ProjectNode): FlowState {
  if (node.stale) return 'stale';
  if (node.locked) return 'locked';
  if (node.metadata.status === 'generating') return 'generating';
  if (node.approval === 'review') return 'review';
  if (node.approval === 'approved' || node.metadata.status === 'ready') return 'ready';
  return 'draft';
}

function nodeIcon(kind: ProjectNodeKind): ReactNode {
  if (kind === 'series' || kind === 'episode') return <Film size={14} />;
  if (kind === 'scene') return <Clapperboard size={14} />;
  if (kind === 'shot' || kind === 'generation') return <Play size={14} />;
  if (kind === 'character') return <UserRound size={14} />;
  if (kind === 'location') return <MapPin size={14} />;
  return <Layers3 size={14} />;
}

function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${String(remainder).padStart(2, '0')}s`;
}

function metadataNumber(node: ProjectNode | undefined, key: string) {
  const value = Number(node?.metadata[key]);
  return Number.isFinite(value) ? value : 0;
}

function flowMeta(node: ProjectNode, snapshot: ProjectGraphSnapshot) {
  const dependents = snapshot.dependencies
    .filter((edge) => edge.dependency === node.id)
    .map((edge) => snapshot.nodes.find((candidate) => candidate.id === edge.dependent))
    .filter((candidate): candidate is ProjectNode => candidate !== undefined);

  if (node.kind === 'episode') {
    const scenes = dependents.filter((candidate) => candidate.kind === 'scene').length;
    return `${scenes} scenes · target ${formatDuration(metadataNumber(node, 'targetDurationSeconds'))}`;
  }
  if (node.kind === 'scene') {
    const shots = dependents.filter((candidate) => candidate.kind === 'shot').length;
    return `${shots} linked shots · ${formatDuration(metadataNumber(node, 'durationSeconds'))}`;
  }
  if (node.kind === 'shot') {
    return `${formatDuration(metadataNumber(node, 'durationSeconds'))} · ${node.metadata.generationStrategy ?? 'strategy pending'}`;
  }
  if (node.kind === 'character') return `${node.metadata.role ?? 'character'} · identity ${node.locked ? 'locked' : 'editable'}`;
  if (node.kind === 'location') return `${node.metadata.city ?? 'location'} · ${node.metadata.time ?? 'time unset'}`;
  if (node.kind === 'generation') return `${node.metadata.mode ?? 'mode pending'} · ${node.metadata.status ?? 'draft'}`;
  return `rev ${node.revision}`;
}

function createFlowNode(node: ProjectNode, snapshot: ProjectGraphSnapshot, position: XYPosition): FlowNode {
  return {
    id: node.id,
    position,
    data: {
      label: (
        <FlowCard
          eyebrow={node.kind.toUpperCase()}
          title={node.title}
          meta={flowMeta(node, snapshot)}
          state={nodeState(node)}
          icon={nodeIcon(node.kind)}
        />
      ),
    },
    className: `workflow-node workflow-node--${nodeState(node)}`,
    style: { padding: 0, border: 0, background: 'transparent', width: 235 },
  };
}

function positionsFromNodes(nodes: FlowNode[]): WorkflowPositions {
  return Object.fromEntries(nodes.map((node) => [node.id, { x: node.position.x, y: node.position.y }]));
}

export function App() {
  const [snapshot, setSnapshot] = useState<ProjectGraphSnapshot | null>(null);
  const [health, setHealth] = useState<EngineHealth | null>(null);
  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [impact, setImpact] = useState<ImpactReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState<FlowNode>([]);
  const [layoutStatus, setLayoutStatus] = useState('Drag nodes · layout auto-saves');

  const layoutKey = useMemo(() => snapshot ? workflowProjectKey(snapshot) : null, [snapshot]);

  const refreshAll = useCallback(async () => {
    try {
      const [nextHealth, nextSnapshot, nextTelemetry] = await Promise.all([
        engineClient.health(),
        engineClient.snapshot(),
        engineClient.system(),
      ]);
      setHealth(nextHealth);
      setSnapshot(nextSnapshot);
      setTelemetry(nextTelemetry);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);

  useEffect(() => {
    void refreshAll();
    const timer = window.setInterval(() => {
      void engineClient.system().then(setTelemetry).catch(() => undefined);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [refreshAll]);

  useEffect(() => {
    if (!snapshot || snapshot.nodes.length === 0) {
      setSelectedId(null);
      setFlowNodes([]);
      return;
    }

    const key = workflowProjectKey(snapshot);
    const positions = resolveWorkflowPositions(snapshot, key);
    setFlowNodes(snapshot.nodes.map((node) => createFlowNode(node, snapshot, positions[node.id] ?? { x: 0, y: 0 })));
    setLayoutStatus('Drag nodes · layout auto-saves');

    if (selectedId && snapshot.nodes.some((node) => node.id === selectedId)) return;
    setSelectedId(
      snapshot.nodes.find((node) => node.kind === 'shot')?.id
      ?? snapshot.nodes.find((node) => node.kind === 'scene')?.id
      ?? snapshot.nodes[0]?.id
      ?? null,
    );
  }, [selectedId, setFlowNodes, snapshot]);

  useEffect(() => {
    setFlowNodes((nodes) => nodes.map((node) => ({ ...node, selected: node.id === selectedId })));
  }, [selectedId, setFlowNodes]);

  const selected = snapshot?.nodes.find((node) => node.id === selectedId);
  const episode = snapshot?.nodes.find((node) => node.kind === 'episode');
  const scenes = useMemo(() => (snapshot?.nodes ?? [])
    .filter((node) => node.kind === 'scene')
    .sort((left, right) => metadataNumber(left, 'index') - metadataNumber(right, 'index')),
  [snapshot]);

  const flowEdges = useMemo<Edge[]>(() => {
    if (!snapshot) return [];
    return snapshot.dependencies.map((edge) => {
      const stale = snapshot.nodes.find((node) => node.id === edge.dependent)?.stale ?? false;
      const color = stale ? '#87505f' : '#4c5568';
      return {
        id: `${edge.dependency}->${edge.dependent}`,
        source: edge.dependency,
        target: edge.dependent,
        type: 'smoothstep',
        animated: stale,
        className: stale ? 'workflow-edge workflow-edge--stale' : 'workflow-edge',
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 13, height: 13 },
        style: { stroke: color },
      };
    });
  }, [snapshot]);

  const persistLayout = useCallback((nodeId: string, position: XYPosition) => {
    if (!layoutKey) return;
    setFlowNodes((nodes) => {
      const next = nodes.map((node) => node.id === nodeId ? { ...node, position } : node);
      saveWorkflowLayout(layoutKey, positionsFromNodes(next));
      return next;
    });
    setLayoutStatus('Layout saved locally');
  }, [layoutKey, setFlowNodes]);

  const fitWorkflow = useCallback(() => {
    void flowInstance?.fitView({ padding: 0.14, duration: 320, maxZoom: 1.15 });
  }, [flowInstance]);

  const arrangeWorkflow = useCallback(() => {
    if (!snapshot || !layoutKey) return;
    const positions = defaultWorkflowPositions(snapshot);
    setFlowNodes((nodes) => nodes.map((node) => ({
      ...node,
      position: positions[node.id] ?? node.position,
    })));
    saveWorkflowLayout(layoutKey, positions);
    setLayoutStatus('Dependency layout restored · saved');
    window.setTimeout(() => fitWorkflow(), 0);
  }, [fitWorkflow, layoutKey, setFlowNodes, snapshot]);

  const focusNode = useCallback((id: string, center = false) => {
    setSelectedId(id);
    setImpact(null);
    setFlowNodes((nodes) => nodes.map((node) => ({ ...node, selected: node.id === id })));

    if (!center || !flowInstance) return;
    const target = flowNodes.find((node) => node.id === id);
    if (!target) return;
    void flowInstance.setCenter(target.position.x + 118, target.position.y + 42, {
      zoom: 1.05,
      duration: 320,
    });
  }, [flowInstance, flowNodes, setFlowNodes]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
      if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        fitWorkflow();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fitWorkflow]);

  const applyCommands = useCallback(async (commands: ProjectCommand[]) => {
    setBusy(true);
    try {
      const result = await engineClient.apply(commands);
      setSnapshot(result.snapshot);
      setHealth((current) => current ? { ...current, projectRevision: result.projectRevision, nodeCount: result.snapshot.nodes.length } : current);
      setImpact(null);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, []);

  const previewImpact = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      setImpact(await engineClient.impact(selected.id));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [selected]);

  const approveSelected = useCallback(() => {
    if (!selected || selected.locked || selected.stale || selected.approval === 'approved') return;
    void applyCommands([{
      type: 'node.patch',
      id: selected.id,
      expectedRevision: selected.revision,
      approval: 'approved',
    }]);
  }, [applyCommands, selected]);

  const toggleSelectedLock = useCallback(() => {
    if (!selected) return;
    void applyCommands([{
      type: 'node.lock',
      id: selected.id,
      expectedRevision: selected.revision,
      locked: !selected.locked,
    }]);
  }, [applyCommands, selected]);

  const gpu = telemetry?.gpu;
  const vramPercent = gpu && gpu.memoryTotalMb > 0
    ? Math.min(100, Math.round((gpu.memoryUsedMb / gpu.memoryTotalMb) * 100))
    : 0;
  const metadata = selected ? Object.entries(selected.metadata).slice(0, 7) : [];

  return (
    <main className="studio-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark"><WandSparkles size={17} /></span>
          <div>
            <strong>Make & Watch</strong>
            <span>Studio · Native Foundation</span>
          </div>
        </div>
        <div className="episode-title">
          <span className={health ? 'status-dot' : 'status-dot status-dot--offline'} />
          {episode ? `Episode ${episode.metadata.episodeNumber ?? '—'} · ${episode.title}` : 'Project loading'}
          {snapshot ? <span className="revision-pill">rev {snapshot.projectRevision}</span> : null}
        </div>
        <div className="system-strip">
          <span><Cpu size={14} /> {health ? 'Native online' : 'Native offline'}</span>
          <span><Gauge size={14} /> {gpu ? `${(gpu.memoryUsedMb / 1024).toFixed(1)} / ${(gpu.memoryTotalMb / 1024).toFixed(1)} GB` : 'GPU telemetry —'}</span>
          <button className="primary-action" onClick={() => void refreshAll()} disabled={busy}><RefreshCw size={14} /> Sync</button>
        </div>
      </header>

      {error ? (
        <div className="error-banner">
          <strong>Runtime connection issue</strong>
          <span>{error}</span>
          <button onClick={() => void refreshAll()}>Retry</button>
        </div>
      ) : null}

      <section className="workspace">
        <aside className="director-panel">
          <div className="panel-heading">
            <div>
              <span className="kicker">AI DIRECTOR</span>
              <h2>Creative control</h2>
            </div>
            <span className={health ? 'connected-pill' : 'connected-pill connected-pill--offline'}><Bot size={13} /> {health ? 'Engine live' : 'Offline'}</span>
          </div>

          <div className="chat-history">
            <div className="message message--user">
              Select a scene, character, or shot. The workflow reads authoritative state from the native C++ engine while canvas layout remains a separate local workspace preference.
            </div>
            <div className="message message--system">
              <span className="message__title"><Sparkles size={14} /> Native impact preview</span>
              {selected
                ? `Before an AI Director edit touches “${selected.title}”, Make & Watch can calculate every downstream entity that becomes stale.`
                : 'Select a workflow node to inspect its dependency impact.'}
              <div className="impact-list">
                <span>{impact ? `${impact.affected.length} affected` : 'impact not calculated'}</span>
                <span>{impact ? `${impact.locked.length} locked` : 'locks protected'}</span>
                <span>{impact ? `${impact.alreadyStale.length} already stale` : 'incremental only'}</span>
              </div>
              <div className="message-actions">
                <button onClick={() => void previewImpact()} disabled={!selected || busy}>Preview impact</button>
                <button
                  className="message-actions__approve"
                  onClick={approveSelected}
                  disabled={!selected || selected.locked || selected.stale || selected.approval === 'approved' || busy}
                >Approve node</button>
              </div>
            </div>
            <div className="director-note">
              Claude/Codex natural-language provider wiring is intentionally not faked yet. It will submit validated operations through this same native boundary.
            </div>
          </div>

          <div className="director-input director-input--disabled">
            <MessageSquareText size={17} />
            <span>Natural-language Director arrives after provider authentication…</span>
            <kbd>next</kbd>
          </div>
        </aside>

        <section className="canvas-panel">
          <div className="canvas-toolbar">
            <div className="canvas-toolbar__title">
              <span className="kicker">LIVE WORKFLOW</span>
              <strong>{snapshot ? `${snapshot.nodes.length} native nodes · ${snapshot.dependencies.length} dependencies` : 'Connecting to native project graph'}</strong>
            </div>
            <div className="canvas-toolbar__right">
              <span className="layout-status"><GripVertical size={12} /> {layoutStatus}</span>
              <div className="canvas-tools">
                <button onClick={arrangeWorkflow} disabled={!snapshot} title="Restore dependency-aware layout"><LayoutGrid size={12} /> Arrange</button>
                <button onClick={fitWorkflow} disabled={!snapshot} title="Fit workflow to viewport"><Scan size={12} /> Fit <kbd>F</kbd></button>
              </div>
              <div className="view-tabs">
                <button className="view-tab view-tab--active">Workflow</button>
                <button className="view-tab">Episode</button>
                <button className="view-tab">Timeline</button>
              </div>
            </div>
          </div>
          <div className="flow-surface">
            {snapshot ? (
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                onNodesChange={onFlowNodesChange}
                onInit={setFlowInstance}
                fitView
                fitViewOptions={{ padding: 0.14, maxZoom: 1.15 }}
                minZoom={0.22}
                maxZoom={1.8}
                snapToGrid
                snapGrid={[8, 8]}
                nodesDraggable
                nodesConnectable={false}
                onNodeClick={(_, node) => focusNode(node.id)}
                onNodeDoubleClick={(_, node) => focusNode(node.id, true)}
                onNodeDragStart={(_, node) => { focusNode(node.id); setLayoutStatus('Repositioning node…'); }}
                onNodeDragStop={(_, node) => persistLayout(node.id, node.position)}
                elementsSelectable
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={28} size={1} />
                <MiniMap
                  pannable
                  zoomable
                  nodeColor={(node) => node.id === selectedId ? '#8f7cf3' : '#272d3a'}
                  maskColor="rgba(5, 7, 12, .78)"
                />
                <Controls showInteractive={false} />
              </ReactFlow>
            ) : (
              <div className="empty-surface"><Activity size={18} /> Loading native graph…</div>
            )}
          </div>

          <div className="timeline-dock">
            <div className="timeline-dock__header">
              <span><Clapperboard size={14} /> Scene strip · native state</span>
              <span>{episode ? `target ${formatDuration(metadataNumber(episode, 'targetDurationSeconds'))}` : '—'}</span>
            </div>
            <div className="scene-strip" style={{ gridTemplateColumns: `repeat(${Math.max(1, scenes.length)}, minmax(74px, 1fr))` }}>
              {scenes.map((scene, index) => {
                const state = nodeState(scene);
                return (
                  <button
                    key={scene.id}
                    className={`scene-chip scene-chip--${state} ${selectedId === scene.id ? 'scene-chip--selected' : ''}`}
                    onClick={() => focusNode(scene.id, true)}
                  >
                    <span>{scene.locked ? <Lock size={11} /> : null} S{String(metadataNumber(scene, 'index') || index + 1).padStart(2, '0')}</span>
                    <small>{state} · {formatDuration(metadataNumber(scene, 'durationSeconds'))}</small>
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        <aside className="inspector-panel">
          <div className="panel-heading">
            <div>
              <span className="kicker">INSPECTOR</span>
              <h2>{selected?.title ?? 'No selection'}</h2>
            </div>
            <ChevronRight size={16} />
          </div>

          <div className="preview-frame">
            <div className="preview-frame__glow" />
            <div className="preview-frame__content">
              <span>{selected?.kind.toUpperCase() ?? 'PROJECT'} · NATIVE REV {selected?.revision ?? '—'}</span>
              <strong>{selected?.title ?? 'Select a workflow node'}</strong>
              <small>{selected?.stale ? 'Downstream state is stale and requires trusted regeneration' : 'Persistent project state · media preview not generated'}</small>
            </div>
          </div>

          <div className="inspector-section">
            <span className="kicker">AUTHORITATIVE STATE</span>
            <div className="metric-row"><span>Kind</span><strong>{selected?.kind ?? '—'}</strong></div>
            <div className="metric-row"><span>Approval</span><strong>{selected?.approval ?? '—'}</strong></div>
            <div className="metric-row"><span>Revision</span><strong>{selected?.revision ?? '—'}</strong></div>
            <div className="metric-row"><span>Lock</span><strong>{selected?.locked ? 'Locked' : 'Editable'}</strong></div>
            <div className="metric-row"><span>Freshness</span><strong>{selected?.stale ? 'Stale' : 'Fresh'}</strong></div>
          </div>

          {metadata.length > 0 ? (
            <div className="inspector-section">
              <span className="kicker">METADATA</span>
              {metadata.map(([key, value]) => (
                <div className="metric-row" key={key}><span>{key}</span><strong>{value}</strong></div>
              ))}
            </div>
          ) : null}

          <div className="inspector-section">
            <span className="kicker">LOCAL SYSTEM</span>
            <div className="resource-card">
              <div><Activity size={15} /><span>{gpu?.name ?? 'GPU telemetry unavailable'}</span><strong>{gpu ? `${gpu.utilizationPercent}%` : '—'}</strong></div>
              <div className="resource-bar"><span style={{ width: `${vramPercent}%` }} /></div>
              <small>{gpu ? `${gpu.memoryUsedMb} MB used · ${gpu.memoryFreeMb} MB free · ${gpu.temperatureC}°C` : 'Media capability will be discovered locally.'}</small>
            </div>
          </div>

          <div className="inspector-actions">
            <button className="secondary-action" onClick={() => selected && focusNode(selected.id, true)} disabled={!selected}>
              <Scan size={14} /> Focus selected node
            </button>
            <button className="secondary-action" onClick={toggleSelectedLock} disabled={!selected || busy}>
              {selected?.locked ? <Unlock size={14} /> : <Lock size={14} />}
              {selected?.locked ? 'Unlock selected node' : 'Lock selected node'}
            </button>
          </div>
        </aside>
      </section>
    </main>
  );
}
