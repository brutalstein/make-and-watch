import { useMemo, type ReactNode } from 'react';
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react';
import {
  Activity,
  Bot,
  Check,
  ChevronRight,
  Clapperboard,
  Cpu,
  Film,
  Gauge,
  Lock,
  MessageSquareText,
  Play,
  Sparkles,
  WandSparkles,
} from 'lucide-react';

interface FlowCardProps {
  eyebrow: string;
  title: string;
  meta: string;
  state: 'ready' | 'review' | 'generating' | 'locked';
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

export function App() {
  const nodes = useMemo<Node[]>(
    () => [
      {
        id: 'episode',
        position: { x: 0, y: 30 },
        data: {
          label: (
            <FlowCard
              eyebrow="EPISODE"
              title="The Last Signal"
              meta="14 scenes · 18m 24s"
              state="locked"
              icon={<Film size={14} />}
            />
          ),
        },
        style: { padding: 0, border: 0, background: 'transparent', width: 230 },
      },
      {
        id: 'scene',
        position: { x: 310, y: 0 },
        data: {
          label: (
            <FlowCard
              eyebrow="SCENE 04"
              title="The mirrored cafe"
              meta="8 shots · 1m 04s"
              state="review"
              icon={<Clapperboard size={14} />}
            />
          ),
        },
        style: { padding: 0, border: 0, background: 'transparent', width: 230 },
      },
      {
        id: 'performance',
        position: { x: 630, y: -80 },
        data: {
          label: (
            <FlowCard
              eyebrow="PERFORMANCE"
              title="Mira · restrained fear"
              meta="Identity locked · Voice v3"
              state="ready"
              icon={<Sparkles size={14} />}
            />
          ),
        },
        style: { padding: 0, border: 0, background: 'transparent', width: 240 },
      },
      {
        id: 'shot',
        position: { x: 630, y: 105 },
        data: {
          label: (
            <FlowCard
              eyebrow="SHOT 031"
              title="Reflection reveal"
              meta="3.8s · I2V candidate"
              state="generating"
              icon={<Play size={14} />}
            />
          ),
        },
        style: { padding: 0, border: 0, background: 'transparent', width: 240 },
      },
      {
        id: 'qc',
        position: { x: 960, y: 40 },
        data: {
          label: (
            <FlowCard
              eyebrow="QUALITY GATE"
              title="Continuity & motion"
              meta="Waiting for Shot 031"
              state="ready"
              icon={<Check size={14} />}
            />
          ),
        },
        style: { padding: 0, border: 0, background: 'transparent', width: 230 },
      },
    ],
    [],
  );

  const edges = useMemo<Edge[]>(
    () => [
      { id: 'e1', source: 'episode', target: 'scene', animated: true },
      { id: 'e2', source: 'scene', target: 'performance', animated: true },
      { id: 'e3', source: 'scene', target: 'shot', animated: true },
      { id: 'e4', source: 'performance', target: 'qc' },
      { id: 'e5', source: 'shot', target: 'qc', animated: true },
    ],
    [],
  );

  return (
    <main className="studio-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark"><WandSparkles size={17} /></span>
          <div>
            <strong>Make & Watch</strong>
            <span>Studio · Foundation Preview</span>
          </div>
        </div>
        <div className="episode-title">
          <span className="status-dot" />
          Episode 01 · The Last Signal
        </div>
        <div className="system-strip">
          <span><Cpu size={14} /> Local runtime</span>
          <span><Gauge size={14} /> VRAM 6.4 / 8 GB</span>
          <button className="primary-action"><Play size={14} /> Preview</button>
        </div>
      </header>

      <section className="workspace">
        <aside className="director-panel">
          <div className="panel-heading">
            <div>
              <span className="kicker">AI DIRECTOR</span>
              <h2>Creative control</h2>
            </div>
            <span className="connected-pill"><Bot size={13} /> Connected</span>
          </div>

          <div className="chat-history">
            <div className="message message--user">
              Make the cafe reveal less obvious. Keep Mira's face locked and make her voice slightly more tired.
            </div>
            <div className="message message--system">
              <span className="message__title"><Sparkles size={14} /> Proposed change</span>
              Scene 04 will keep its structure. Shot 031 framing changes to reflected silhouette; Mira identity remains locked. Voice performance intensity drops to 0.62.
              <div className="impact-list">
                <span>3 assets affected</span>
                <span>Other scenes untouched</span>
              </div>
              <div className="message-actions">
                <button>Preview change</button>
                <button className="message-actions__approve">Approve</button>
              </div>
            </div>
          </div>

          <div className="director-input">
            <MessageSquareText size={17} />
            <span>Direct the episode in natural language…</span>
            <kbd>⌘ ↵</kbd>
          </div>
        </aside>

        <section className="canvas-panel">
          <div className="canvas-toolbar">
            <div>
              <span className="kicker">LIVE WORKFLOW</span>
              <strong>Scene 04 production graph</strong>
            </div>
            <div className="view-tabs">
              <button className="view-tab view-tab--active">Workflow</button>
              <button className="view-tab">Episode</button>
              <button className="view-tab">Timeline</button>
            </div>
          </div>
          <div className="flow-surface">
            <ReactFlow nodes={nodes} edges={edges} fitView nodesDraggable={false} elementsSelectable>
              <Background gap={28} size={1} />
              <MiniMap pannable zoomable />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>

          <div className="timeline-dock">
            <div className="timeline-dock__header">
              <span><Clapperboard size={14} /> Scene strip</span>
              <span>18:24 estimated</span>
            </div>
            <div className="scene-strip">
              {[
                ['01', 'locked'], ['02', 'ready'], ['03', 'ready'], ['04', 'review'], ['05', 'draft'],
                ['06', 'draft'], ['07', 'locked'], ['08', 'draft'], ['09', 'draft'], ['10', 'draft'],
              ].map(([scene, state]) => (
                <div key={scene} className={`scene-chip scene-chip--${state}`}>
                  <span>{state === 'locked' ? <Lock size={11} /> : null} S{scene}</span>
                  <small>{state}</small>
                </div>
              ))}
            </div>
          </div>
        </section>

        <aside className="inspector-panel">
          <div className="panel-heading">
            <div>
              <span className="kicker">INSPECTOR</span>
              <h2>Shot 031</h2>
            </div>
            <ChevronRight size={16} />
          </div>

          <div className="preview-frame">
            <div className="preview-frame__glow" />
            <div className="preview-frame__content">
              <span>STORYBOARD PREVIEW</span>
              <strong>Reflection reveal</strong>
              <small>Final media not generated</small>
            </div>
          </div>

          <div className="inspector-section">
            <span className="kicker">EXECUTION PLAN</span>
            <div className="metric-row"><span>Representation</span><strong>Image → Video</strong></div>
            <div className="metric-row"><span>Duration</span><strong>3.8 sec</strong></div>
            <div className="metric-row"><span>Identity priority</span><strong>High</strong></div>
            <div className="metric-row"><span>Motion complexity</span><strong>Medium</strong></div>
          </div>

          <div className="inspector-section">
            <span className="kicker">RUNTIME</span>
            <div className="resource-card">
              <div><Activity size={15} /><span>Generation budget</span><strong>4.9 GB</strong></div>
              <div className="resource-bar"><span style={{ width: '61%' }} /></div>
              <small>Plan is inside the current local VRAM budget.</small>
            </div>
          </div>

          <button className="secondary-action"><Lock size={14} /> Lock approved identity</button>
        </aside>
      </section>
    </main>
  );
}
