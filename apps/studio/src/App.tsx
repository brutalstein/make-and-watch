import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node as FlowNode,
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
  Check,
  ChevronRight,
  Clapperboard,
  Cpu,
  Film,
  Gauge,
  Layers3,
  Lock,
  MapPin,
  MessageSquareText,
  Play,
  RefreshCw,
  Sparkles,
  Unlock,
  UserRound,
  WandSparkles,
} from 'lucide-react';

import { engineClient } from './engineClient';

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

export function App() {
  const [snapshot, setSnapshot] = useState<ProjectGraphSnapshot | null>(null);
  const [health, setHealth] = useState<EngineHealth | null>(null);
  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [impact, setImpact] = useState<ImpactReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      return;
    }
    if (selectedId && snapshot.nodes.some((node) => node.id === selectedId)) return;
    setSelectedId(
      snapshot.nodes.find((node) => node.kind === 'shot')?.id
      ?? snapshot.nodes.find((node) => node.kind === 'scene')?.id
      ?? snapshot.nodes[0]?.id
      ?? null,
    );
  }, [selectedId, snapshot]);

  const selected = snapshot?.nodes.find((node) => node.id === selectedId);
  const episode = snapshot?.nodes.find((node) => node.kind === 'episode');
  const scenes = useMemo(() => (snapshot?.nodes ?? [])
    .filter((node) => node.kind === 'scene')
    .sort((left, right) => metadataNumber(left, 'index') - metadataNumber(right, 'index')),
  [snapshot]);

  const flowNodes = useMemo<FlowNode[]>(() => {
    if (!snapshot) return [];
    const xByKind: Record<ProjectNodeKind, number> = {
      series: 0,
      episode: 0,
      scene: 300,
      character: 610,
      location: 610,
      shot: 910,
      asset: 910,
      audio: 910,
      generation: 1210,
    };
    const rows = new Map<number, number>();
    return snapshot.nodes.map((node) => {
      const x = xByKind[node.kind];
      const row = rows.get(x) ?? 0;
      rows.set(x, row + 1);
      return {
        id: node.id,
        position: { x, y: row * 145 },
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
        style: { padding: 0, border: 0, background: 'transparent', width: 235 },
      };
    });
  }, [snapshot]);

  const flowEdges = useMemo<Edge[]>(() => {
    if (!snapshot) return [];
    return snapshot.dependencies.map((edge) => ({
      id: `${edge.dependency}->${edge.dependent}`,
      source: edge.dependency,
      target: edge.dependent,
      animated: snapshot.nodes.find((node) => node.id === edge.dependent)?.stale ?? false,
    }));
  }, [snapshot]);

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
              Select a scene, character, or shot. The workflow now reads authoritative state from the native C++ engine.
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
            <div>
              <span className="kicker">LIVE WORKFLOW</span>
              <strong>{snapshot ? `${snapshot.nodes.length} native nodes · ${snapshot.dependencies.length} dependencies` : 'Connecting to native project graph'}</strong>
            </div>
            <div className="view-tabs">
              <button className="view-tab view-tab--active">Workflow</button>
              <button className="view-tab">Episode</button>
              <button className="view-tab">Timeline</button>
            </div>
          </div>
          <div className="flow-surface">
            {snapshot ? (
              <ReactFlow
                nodes={flowNodes}
                edges={flowEdges}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                nodesDraggable={false}
                onNodeClick={(_, node) => { setSelectedId(node.id); setImpact(null); }}
                elementsSelectable
              >
                <Background gap={28} size={1} />
                <MiniMap pannable zoomable />
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
                    onClick={() => { setSelectedId(scene.id); setImpact(null); }}
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

          <button className="secondary-action" onClick={toggleSelectedLock} disabled={!selected || busy}>
            {selected?.locked ? <Unlock size={14} /> : <Lock size={14} />}
            {selected?.locked ? 'Unlock selected node' : 'Lock selected node'}
          </button>
        </aside>
      </section>
    </main>
  );
}
