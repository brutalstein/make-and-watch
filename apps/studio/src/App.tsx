import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  ProjectHistoryTransaction,
  ProjectNode,
  ProjectNodeKind,
  SystemTelemetry,
} from '@makewatch/contracts';
import {
  Activity,
  Bot,
  BrainCircuit,
  ChevronRight,
  CircleStop,
  Clapperboard,
  Cpu,
  Film,
  Gauge,
  GripVertical,
  History,
  Layers3,
  LayoutGrid,
  Lock,
  MapPin,
  MessageSquareText,
  MousePointer2,
  Pause,
  Play,
  RefreshCw,
  Scan,
  ShieldCheck,
  Sparkles,
  Unlock,
  UserRound,
  WandSparkles,
} from 'lucide-react';

import { engineClient } from './engineClient';
import { AutopilotCancelledError, AutopilotExecutionControl, controlledDelay } from './director/autopilotControl';
import { executeAutopilotPlan, type AutopilotRuntime } from './director/autopilotExecutor';
import { buildWorkspaceAutopilotPlan } from './director/autopilotPlan';
import {
  IDLE_AUTOPILOT_STATE,
  type AutopilotUiState,
  type CursorVisualState,
} from './director/autopilotTypes';
import { validateAutopilotPlan } from './director/autopilotValidation';
import {
  animateCursor,
  durationForDistance,
  runDeterministicAnimation,
} from './director/cinematicMotion';
import {
  INITIAL_VIRTUAL_CURSOR_STATE,
  setVirtualCursorState,
  VirtualCursor,
} from './director/VirtualCursor';
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

function isAutopilotBlocking(state: AutopilotUiState) {
  return state.status === 'planning'
    || state.status === 'executing'
    || state.status === 'paused'
    || state.status === 'waiting_approval';
}

function historyActorLabel(transaction: ProjectHistoryTransaction) {
  if (transaction.actor === 'ai_director') return 'AI Director';
  if (transaction.actor === 'user') return 'You';
  return 'System';
}

function historyActorIcon(transaction: ProjectHistoryTransaction) {
  if (transaction.actor === 'ai_director') return <BrainCircuit size={11} />;
  if (transaction.actor === 'user') return <UserRound size={11} />;
  return <Cpu size={11} />;
}

function historyChangeCount(transaction: ProjectHistoryTransaction) {
  return transaction.events.filter((event) => event.type !== 'transaction.committed').length;
}

function historyPrimaryEntity(transaction: ProjectHistoryTransaction) {
  return transaction.events.find((event) => event.entityId)?.entityId ?? null;
}

export function App() {
  const [snapshot, setSnapshot] = useState<ProjectGraphSnapshot | null>(null);
  const [health, setHealth] = useState<EngineHealth | null>(null);
  const [telemetry, setTelemetry] = useState<SystemTelemetry | null>(null);
  const [history, setHistory] = useState<ProjectHistoryTransaction[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [impact, setImpact] = useState<ImpactReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState<FlowNode>([]);
  const [layoutStatus, setLayoutStatus] = useState('Drag nodes · layout auto-saves');
  const [autopilot, setAutopilot] = useState<AutopilotUiState>(IDLE_AUTOPILOT_STATE);

  const cursorRef = useRef<CursorVisualState>(INITIAL_VIRTUAL_CURSOR_STATE);
  const autopilotControlRef = useRef<AutopilotExecutionControl | null>(null);
  const checkpointResolverRef = useRef<((approved: boolean) => void) | null>(null);

  const layoutKey = useMemo(() => snapshot ? workflowProjectKey(snapshot) : null, [snapshot]);
  const autopilotBlocking = isAutopilotBlocking(autopilot);

  const updateCursor = useCallback((next: CursorVisualState) => {
    cursorRef.current = next;
    setVirtualCursorState(next);
  }, []);

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const result = await engineClient.history(10);
      setHistory(result.transactions);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    try {
      const [nextHealth, nextSnapshot, nextTelemetry, nextHistory] = await Promise.all([
        engineClient.health(),
        engineClient.snapshot(),
        engineClient.system(),
        engineClient.history(10),
      ]);
      setHealth(nextHealth);
      setSnapshot(nextSnapshot);
      setTelemetry(nextTelemetry);
      setHistory(nextHistory.transactions);
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
        animated: stale && !autopilotBlocking,
        className: stale ? 'workflow-edge workflow-edge--stale' : 'workflow-edge',
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 13, height: 13 },
        style: { stroke: color },
      };
    });
  }, [autopilotBlocking, snapshot]);

  const persistLayout = useCallback((nodeId: string, position: XYPosition) => {
    if (!layoutKey) return;
    setFlowNodes((nodes) => {
      const next = nodes.map((node) => node.id === nodeId ? { ...node, position } : node);
      saveWorkflowLayout(layoutKey, positionsFromNodes(next));
      return next;
    });
    setLayoutStatus('Layout saved locally');
  }, [layoutKey, setFlowNodes]);

  const fitWorkflow = useCallback(async () => {
    if (!flowInstance) return;
    await flowInstance.fitView({ padding: 0.14, duration: 520, maxZoom: 1.12 });
  }, [flowInstance]);

  const arrangeWorkflow = useCallback(async () => {
    if (!snapshot || !layoutKey) return;
    const positions = defaultWorkflowPositions(snapshot);
    setFlowNodes((nodes) => nodes.map((node) => ({
      ...node,
      position: positions[node.id] ?? node.position,
    })));
    saveWorkflowLayout(layoutKey, positions);
    setLayoutStatus('Dependency layout restored · saved');
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    await fitWorkflow();
  }, [fitWorkflow, layoutKey, setFlowNodes, snapshot]);

  const focusNode = useCallback(async (id: string, center = false, zoom = 1.05) => {
    setSelectedId(id);
    setImpact(null);
    setFlowNodes((nodes) => nodes.map((node) => ({ ...node, selected: node.id === id })));

    if (!center || !flowInstance) return;
    const target = flowNodes.find((node) => node.id === id);
    if (!target) return;
    await flowInstance.setCenter(target.position.x + 118, target.position.y + 42, {
      zoom,
      duration: 520,
    });
  }, [flowInstance, flowNodes, setFlowNodes]);

  const applyCommands = useCallback(async (
    commands: ProjectCommand[],
    context?: { actor?: 'user' | 'ai_director' | 'system'; source?: string; planId?: string; reason?: string },
  ) => {
    setBusy(true);
    try {
      const result = await engineClient.apply(commands, context);
      setSnapshot(result.snapshot);
      setHealth((current) => current ? { ...current, projectRevision: result.projectRevision, nodeCount: result.snapshot.nodes.length } : current);
      setImpact(null);
      setError(null);
      void engineClient.history(10).then((next) => setHistory(next.transactions)).catch(() => undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setBusy(false);
    }
  }, []);

  const previewImpactFor = useCallback(async (nodeId: string) => {
    setBusy(true);
    try {
      const result = await engineClient.impact(nodeId);
      setImpact(result);
      setError(null);
      return result;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setBusy(false);
    }
  }, []);

  const previewImpact = useCallback(async () => {
    if (!selected) return;
    await previewImpactFor(selected.id);
  }, [previewImpactFor, selected]);

  const approveSelected = useCallback(() => {
    if (!selected || selected.locked || selected.stale || selected.approval === 'approved') return;
    void applyCommands([{
      type: 'node.patch',
      id: selected.id,
      expectedRevision: selected.revision,
      approval: 'approved',
    }], { actor: 'user', source: 'studio-inspector', reason: 'manual Studio approval' });
  }, [applyCommands, selected]);

  const toggleSelectedLock = useCallback(() => {
    if (!selected) return;
    void applyCommands([{
      type: 'node.lock',
      id: selected.id,
      expectedRevision: selected.revision,
      locked: !selected.locked,
    }], {
      actor: 'user',
      source: 'studio-inspector',
      reason: selected.locked ? 'manual Studio unlock' : 'manual Studio lock',
    });
  }, [applyCommands, selected]);

  const locateNodeCenter = useCallback((nodeId: string) => {
    const escaped = CSS.escape(nodeId);
    const element = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${escaped}"]`);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width * 0.52, y: rect.top + Math.min(34, rect.height * 0.42) };
  }, []);

  const moveCursorToNode = useCallback(async (nodeId: string, label: string, duration?: number) => {
    const control = autopilotControlRef.current;
    if (!control) throw new AutopilotCancelledError();
    const center = locateNodeCenter(nodeId);
    if (!center) throw new Error(`workflow node ${nodeId} is not visible`);
    const start = cursorRef.current.visible
      ? cursorRef.current
      : { ...cursorRef.current, visible: true, x: window.innerWidth * 0.56, y: 82, label };
    const travel = Math.hypot(center.x - start.x, center.y - start.y);
    const travelDuration = duration ?? durationForDistance(travel, {
      speedPxPerSecond: 470,
      minimumMs: 520,
      maximumMs: 1450,
    });
    await animateCursor(start, center, travelDuration, label, control, updateCursor);
  }, [locateNodeCenter, updateCursor]);

  const autopilotDragNode = useCallback(async (
    nodeId: string,
    to: { x: number; y: number },
    durationMs: number,
    label: string,
  ) => {
    const control = autopilotControlRef.current;
    if (!control) throw new AutopilotCancelledError();
    await focusNode(nodeId, false);
    await controlledDelay(control, 100);
    await moveCursorToNode(nodeId, label);

    const source = flowNodes.find((node) => node.id === nodeId);
    if (!source) throw new Error(`workflow node ${nodeId} does not exist`);

    let previousPosition = source.position;
    updateCursor({
      ...cursorRef.current,
      visible: true,
      pressed: true,
      pulse: cursorRef.current.pulse + 1,
      label,
    });

    await runDeterministicAnimation(durationMs, control, (eased) => {
      const nextPosition = {
        x: source.position.x + (to.x - source.position.x) * eased,
        y: source.position.y + (to.y - source.position.y) * eased,
      };
      const zoom = flowInstance?.getViewport().zoom ?? 1;
      const delta = {
        x: nextPosition.x - previousPosition.x,
        y: nextPosition.y - previousPosition.y,
      };
      previousPosition = nextPosition;

      setFlowNodes((nodes) => nodes.map((node) => node.id === nodeId ? { ...node, position: nextPosition } : node));
      updateCursor({
        ...cursorRef.current,
        visible: true,
        pressed: true,
        x: cursorRef.current.x + delta.x * zoom,
        y: cursorRef.current.y + delta.y * zoom,
        label,
      });
    });

    if (layoutKey) {
      setFlowNodes((nodes) => {
        const next = nodes.map((node) => node.id === nodeId ? { ...node, position: to } : node);
        saveWorkflowLayout(layoutKey, positionsFromNodes(next));
        return next;
      });
    }
    updateCursor({ ...cursorRef.current, pressed: false, pulse: cursorRef.current.pulse + 1, label });
    await controlledDelay(control, 240);
  }, [flowInstance, flowNodes, focusNode, layoutKey, moveCursorToNode, setFlowNodes, updateCursor]);

  const stopAutopilot = useCallback(() => {
    checkpointResolverRef.current?.(false);
    checkpointResolverRef.current = null;
    autopilotControlRef.current?.cancel();
    autopilotControlRef.current = null;
    updateCursor({ ...cursorRef.current, visible: false, pressed: false, label: '' });
    setAutopilot((current) => ({
      ...current,
      status: 'cancelled',
      activity: 'Control returned to you',
      error: null,
    }));
  }, [updateCursor]);

  const pauseAutopilot = useCallback(() => {
    const control = autopilotControlRef.current;
    if (!control || control.isPaused) return;
    control.pause();
    setAutopilot((current) => ({ ...current, status: 'paused', activity: 'AI Director paused safely' }));
    updateCursor({ ...cursorRef.current, pressed: false, label: 'Paused' });
  }, [updateCursor]);

  const resumeAutopilot = useCallback(() => {
    const control = autopilotControlRef.current;
    if (!control) return;
    control.resume();
    setAutopilot((current) => ({ ...current, status: 'executing', activity: 'AI Director resumed' }));
  }, []);

  const approveAutopilotCheckpoint = useCallback(() => {
    checkpointResolverRef.current?.(true);
    checkpointResolverRef.current = null;
    setAutopilot((current) => ({ ...current, status: 'executing', activity: 'Approved · continuing' }));
  }, []);

  const startWorkspaceAutopilot = useCallback(() => {
    if (!snapshot || autopilotBlocking || !flowInstance) return;
    const plan = buildWorkspaceAutopilotPlan(snapshot, positionsFromNodes(flowNodes));
    const validation = validateAutopilotPlan(plan, snapshot);
    if (!validation.ok) {
      setError(`AI plan rejected: ${validation.errors.join(' · ')}`);
      return;
    }

    const control = new AutopilotExecutionControl();
    autopilotControlRef.current = control;
    setAutopilot({
      status: 'planning',
      planId: plan.planId,
      title: plan.title,
      stepIndex: 0,
      stepCount: plan.steps.length,
      activity: 'Validating the workflow and preparing a safe execution path',
      error: null,
    });
    updateCursor({
      visible: true,
      x: window.innerWidth * 0.56,
      y: 82,
      pressed: false,
      pulse: cursorRef.current.pulse,
      label: 'AI Director',
    });

    const runtime: AutopilotRuntime = {
      announce: (message) => updateCursor({ ...cursorRef.current, label: message }),
      focusNode: async (nodeId, zoom) => {
        await focusNode(nodeId, true, zoom ?? 1.04);
        await controlledDelay(control, 180);
        await moveCursorToNode(nodeId, `Inspecting ${snapshot.nodes.find((node) => node.id === nodeId)?.title ?? nodeId}`);
        updateCursor({ ...cursorRef.current, pulse: cursorRef.current.pulse + 1, pressed: false });
      },
      dragNode: autopilotDragNode,
      previewImpact: async (nodeId) => {
        await moveCursorToNode(nodeId, 'Checking dependency impact');
        updateCursor({ ...cursorRef.current, pressed: true, pulse: cursorRef.current.pulse + 1 });
        const report = await previewImpactFor(nodeId);
        updateCursor({ ...cursorRef.current, pressed: false, pulse: cursorRef.current.pulse + 1, label: `${report.affected.length} downstream entities checked` });
        await controlledDelay(control, 640);
        return report;
      },
      arrangeWorkflow: async () => {
        updateCursor({ ...cursorRef.current, label: 'Applying dependency-aware layout' });
        await controlledDelay(control, 180);
        await arrangeWorkflow();
        await controlledDelay(control, 520);
      },
      fitWorkflow: async () => {
        updateCursor({ ...cursorRef.current, label: 'Framing the full workflow' });
        await controlledDelay(control, 150);
        await fitWorkflow();
        await controlledDelay(control, 300);
      },
      applyCommands: async (commands, context) => {
        await applyCommands(commands, {
          actor: 'ai_director',
          source: 'studio-autopilot',
          planId: context.planId,
          reason: context.reason,
        });
      },
      checkpoint: (message) => new Promise<boolean>((resolve) => {
        updateCursor({ ...cursorRef.current, pressed: false, label: message });
        checkpointResolverRef.current = resolve;
      }),
      setUiState: setAutopilot,
    };

    window.setTimeout(() => {
      void executeAutopilotPlan(plan, runtime, control)
        .then(() => {
          if (autopilotControlRef.current === control) autopilotControlRef.current = null;
          window.setTimeout(() => updateCursor({ ...cursorRef.current, visible: false, pressed: false, label: '' }), 650);
        })
        .catch((reason) => {
          if (!(reason instanceof AutopilotCancelledError)) setError(reason instanceof Error ? reason.message : String(reason));
          if (autopilotControlRef.current === control) autopilotControlRef.current = null;
          updateCursor({ ...cursorRef.current, visible: false, pressed: false, label: '' });
        });
    }, 260);
  }, [applyCommands, arrangeWorkflow, autopilotBlocking, autopilotDragNode, fitWorkflow, flowInstance, flowNodes, focusNode, moveCursorToNode, previewImpactFor, snapshot, updateCursor]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;

      if (autopilotBlocking) {
        if (event.key === 'Escape') {
          event.preventDefault();
          stopAutopilot();
        } else if (event.code === 'Space' && autopilot.status !== 'waiting_approval') {
          event.preventDefault();
          if (autopilot.status === 'paused') resumeAutopilot();
          else pauseAutopilot();
        }
        return;
      }

      if (event.key.toLowerCase() === 'f') {
        event.preventDefault();
        void fitWorkflow();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [autopilot.status, autopilotBlocking, fitWorkflow, pauseAutopilot, resumeAutopilot, stopAutopilot]);

  const gpu = telemetry?.gpu;
  const vramPercent = gpu && gpu.memoryTotalMb > 0
    ? Math.min(100, Math.round((gpu.memoryUsedMb / gpu.memoryTotalMb) * 100))
    : 0;
  const metadata = selected ? Object.entries(selected.metadata).slice(0, 7) : [];
  const autopilotProgress = autopilot.stepCount > 0 ? Math.round((autopilot.stepIndex / autopilot.stepCount) * 100) : 0;

  return (
    <main className={`studio-shell ${autopilotBlocking ? 'studio-shell--autopilot' : ''}`}>
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
          <button className="primary-action" onClick={() => void refreshAll()} disabled={busy || autopilotBlocking}><RefreshCw size={14} /> Sync</button>
        </div>
      </header>

      {error ? (
        <div className="error-banner">
          <strong>Runtime connection issue</strong>
          <span>{error}</span>
          <button onClick={() => void refreshAll()}>Retry</button>
        </div>
      ) : null}

      {autopilot.status !== 'idle' ? (
        <div className={`autopilot-banner autopilot-banner--${autopilot.status}`}>
          <div className="autopilot-banner__identity">
            <span className="autopilot-orb"><BrainCircuit size={15} /></span>
            <div>
              <strong>{autopilot.title || 'AI Director'}</strong>
              <span>{autopilot.activity || 'Preparing workflow control'}</span>
            </div>
          </div>
          <div className="autopilot-banner__progress">
            <span><MousePointer2 size={12} /> AI has workflow control</span>
            <div><i style={{ width: `${autopilotProgress}%` }} /></div>
            <small>{autopilot.stepCount ? `${autopilot.stepIndex}/${autopilot.stepCount}` : '—'} · Esc always returns control</small>
          </div>
          <div className="autopilot-banner__actions">
            {autopilot.status === 'waiting_approval' ? (
              <button className="autopilot-continue" onClick={approveAutopilotCheckpoint}><ShieldCheck size={13} /> Continue</button>
            ) : autopilot.status === 'paused' ? (
              <button onClick={resumeAutopilot}><Play size={13} /> Resume</button>
            ) : autopilotBlocking ? (
              <button onClick={pauseAutopilot}><Pause size={13} /> Pause</button>
            ) : null}
            {autopilotBlocking ? <button className="autopilot-stop" onClick={stopAutopilot}><CircleStop size={13} /> Take back control</button> : null}
          </div>
        </div>
      ) : null}

      {autopilotBlocking ? <div className="autopilot-interaction-lock" aria-hidden="true" /> : null}
      <VirtualCursor />

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

            <div className="autopilot-card">
              <div className="autopilot-card__head">
                <span className="autopilot-card__icon"><BrainCircuit size={16} /></span>
                <div>
                  <strong>Don’t know workflows?</strong>
                  <span>Let the AI Director take the controls.</span>
                </div>
              </div>
              <p>It can focus, inspect and physically organize nodes with a visible virtual cursor. Your semantic project stays protected unless a validated native operation is explicitly part of the plan.</p>
              <div className="autopilot-card__trust">
                <span><ShieldCheck size={11} /> typed plan</span>
                <span><MousePointer2 size={11} /> visible actions</span>
                <span><CircleStop size={11} /> instant takeover</span>
              </div>
              <button className="autopilot-start" onClick={startWorkspaceAutopilot} disabled={!snapshot || !health || autopilotBlocking}>
                <Sparkles size={14} /> Let AI drive this workflow
              </button>
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
                <button onClick={() => void previewImpact()} disabled={!selected || busy || autopilotBlocking}>Preview impact</button>
                <button
                  className="message-actions__approve"
                  onClick={approveSelected}
                  disabled={!selected || selected.locked || selected.stale || selected.approval === 'approved' || busy || autopilotBlocking}
                >Approve node</button>
              </div>
            </div>
            <div className="director-note">
              Claude/Codex authentication is still intentionally not faked. Their future output plugs into the same validated Autopilot plan and native command boundary already used here.
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
                <button onClick={() => void arrangeWorkflow()} disabled={!snapshot || autopilotBlocking} title="Restore dependency-aware layout"><LayoutGrid size={12} /> Arrange</button>
                <button onClick={() => void fitWorkflow()} disabled={!snapshot || autopilotBlocking} title="Fit workflow to viewport"><Scan size={12} /> Fit <kbd>F</kbd></button>
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
                nodesDraggable={!autopilotBlocking}
                nodesConnectable={false}
                onNodeClick={(_, node) => { if (!autopilotBlocking) void focusNode(node.id); }}
                onNodeDoubleClick={(_, node) => { if (!autopilotBlocking) void focusNode(node.id, true); }}
                onNodeDragStart={(_, node) => {
                  if (autopilotBlocking) return;
                  void focusNode(node.id);
                  setLayoutStatus('Repositioning node…');
                }}
                onNodeDragStop={(_, node) => { if (!autopilotBlocking) persistLayout(node.id, node.position); }}
                elementsSelectable={!autopilotBlocking}
                proOptions={{ hideAttribution: true }}
              >
                <Background gap={28} size={1} />
                <MiniMap
                  pannable={!autopilotBlocking}
                  zoomable={!autopilotBlocking}
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
                    onClick={() => { if (!autopilotBlocking) void focusNode(scene.id, true); }}
                    disabled={autopilotBlocking}
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

          <div className="inspector-section inspector-section--activity">
            <div className="activity-heading">
              <div>
                <span className="kicker">DURABLE ACTIVITY</span>
                <small>Native journal · newest first</small>
              </div>
              <button onClick={() => void refreshHistory()} disabled={historyLoading || autopilotBlocking} title="Refresh native history">
                <RefreshCw size={11} className={historyLoading ? 'spin' : ''} />
              </button>
            </div>
            <div className="activity-feed">
              {history.length === 0 ? (
                <div className="activity-empty"><History size={14} /> No committed history yet</div>
              ) : history.slice(0, 6).map((transaction) => {
                const primaryEntity = historyPrimaryEntity(transaction);
                const canFocus = Boolean(primaryEntity && snapshot?.nodes.some((node) => node.id === primaryEntity));
                const title = transaction.reason || transaction.source || 'Native project transaction';
                return (
                  <button
                    key={`${transaction.projectRevision}-${transaction.actor}-${transaction.planId}`}
                    className={`activity-entry activity-entry--${transaction.actor}`}
                    onClick={() => {
                      if (!autopilotBlocking && primaryEntity && canFocus) void focusNode(primaryEntity, true);
                    }}
                    disabled={autopilotBlocking || !canFocus}
                  >
                    <span className="activity-entry__actor">{historyActorIcon(transaction)}</span>
                    <span className="activity-entry__body">
                      <strong>{title}</strong>
                      <small>{historyActorLabel(transaction)} · rev {transaction.projectRevision} · {historyChangeCount(transaction)} changes</small>
                    </span>
                    <span className="activity-entry__rev">R{transaction.projectRevision}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="inspector-section">
            <span className="kicker">LOCAL SYSTEM</span>
            <div className="resource-card">
              <div><Activity size={15} /><span>{gpu?.name ?? 'GPU telemetry unavailable'}</span><strong>{gpu ? `${gpu.utilizationPercent}%` : '—'}</strong></div>
              <div className="resource-bar"><span style={{ width: `${vramPercent}%` }} /></div>
              <small>{gpu ? `${gpu.memoryUsedMb} MB used · ${gpu.memoryFreeMb} MB free · ${gpu.temperatureC}°C` : 'Media capability will be discovered locally.'}</small>
            </div>
          </div>

          <div className="inspector-actions">
            <button className="secondary-action" onClick={() => selected && void focusNode(selected.id, true)} disabled={!selected || autopilotBlocking}>
              <Scan size={14} /> Focus selected node
            </button>
            <button className="secondary-action" onClick={toggleSelectedLock} disabled={!selected || busy || autopilotBlocking}>
              {selected?.locked ? <Unlock size={14} /> : <Lock size={14} />}
              {selected?.locked ? 'Unlock selected node' : 'Lock selected node'}
            </button>
          </div>
        </aside>
      </section>
    </main>
  );
}