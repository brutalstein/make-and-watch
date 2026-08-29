import { useCallback, useEffect, useMemo, useState } from 'react';
import { Braces, Lock, Save, ShieldCheck, Unlock, X } from 'lucide-react';
import {
  defaultMetadataForKind,
  nodeCapability,
  type NodeMetadataFieldSpec,
  type ProjectGraphSnapshot,
  type ProjectNode,
} from '@makewatch/contracts';

import { engineClient } from './engineClient';
import { EDIT_NODE_PROPERTIES_EVENT, type EditNodePropertiesDetail } from './nodePropertiesEvents';
import { announceProjectChanged, PROJECT_CHANGED_EVENT } from './projectEvents';

type FormState = {
  title: string;
  metadata: Record<string, string>;
};

function formFor(node: ProjectNode): FormState {
  return {
    title: node.title,
    metadata: { ...defaultMetadataForKind(node.kind), ...node.metadata },
  };
}

function FieldControl({
  field,
  value,
  disabled,
  onChange,
}: {
  field: NodeMetadataFieldSpec;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  if (field.type === 'multiline') {
    return (
      <textarea
        value={value}
        disabled={disabled}
        rows={4}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }
  if (field.type === 'enum') {
    return (
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="">—</option>
        {(field.options ?? []).map((option) => <option value={option} key={option}>{option}</option>)}
      </select>
    );
  }
  if (field.type === 'boolean') {
    return (
      <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  return (
    <input
      value={value}
      disabled={disabled}
      type={field.type === 'number' || field.type === 'duration' || field.type === 'seed' ? 'number' : 'text'}
      min={field.type === 'duration' || field.type === 'seed' ? 0 : undefined}
      step={field.type === 'duration' || field.type === 'number' ? 'any' : undefined}
      placeholder={field.placeholder}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

export function NodePropertiesDock() {
  const [snapshot, setSnapshot] = useState<ProjectGraphSnapshot | null>(null);
  const [nodeId, setNodeId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const refresh = useCallback(async () => {
    const live = await engineClient.snapshot();
    setSnapshot(live);
    return live;
  }, []);

  const selected = useMemo(
    () => nodeId ? snapshot?.nodes.find((candidate) => candidate.id === nodeId) ?? null : null,
    [nodeId, snapshot],
  );
  const capability = selected ? nodeCapability(selected.kind) : null;

  useEffect(() => {
    const onEdit = (event: Event) => {
      const custom = event as CustomEvent<EditNodePropertiesDetail>;
      const id = custom.detail?.nodeId;
      if (!id) return;
      setNodeId(id);
      setNotice('');
      void refresh().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
    };
    const onProjectChanged = () => {
      if (nodeId) void refresh().catch(() => undefined);
    };
    window.addEventListener(EDIT_NODE_PROPERTIES_EVENT, onEdit);
    window.addEventListener(PROJECT_CHANGED_EVENT, onProjectChanged);
    return () => {
      window.removeEventListener(EDIT_NODE_PROPERTIES_EVENT, onEdit);
      window.removeEventListener(PROJECT_CHANGED_EVENT, onProjectChanged);
    };
  }, [nodeId, refresh]);

  useEffect(() => {
    if (!selected) {
      setForm(null);
      return;
    }
    setForm(formFor(selected));
  }, [selected?.id, selected?.revision]);

  const patchMetadata = useCallback((key: string, value: string) => {
    setForm((current) => current ? { ...current, metadata: { ...current.metadata, [key]: value } } : current);
  }, []);

  const save = useCallback(async () => {
    if (!selected || !form || selected.locked) return;
    setBusy(true);
    setNotice('');
    try {
      const live = await engineClient.snapshot();
      const current = live.nodes.find((candidate) => candidate.id === selected.id);
      if (!current) throw new Error('Node no longer exists.');
      if (current.locked) throw new Error('Node is locked. Unlock it before editing properties.');
      const allowedKeys = new Set(nodeCapability(current.kind).fields.map((field) => field.key));
      const metadataUpdates = Object.fromEntries(
        Object.entries(form.metadata)
          .filter(([key]) => allowedKeys.has(key))
          .map(([key, value]) => [key, String(value).slice(0, 12_000)]),
      );
      const result = await engineClient.apply([{
        type: 'node.patch',
        id: current.id,
        expectedRevision: current.revision,
        title: form.title.trim().slice(0, 240) || current.title,
        metadataUpdates,
      }], {
        actor: 'user',
        source: 'studio-node-properties',
        reason: `edit ${current.kind} production properties`,
      }, live.projectRevision);
      setSnapshot(result.snapshot);
      announceProjectChanged({ projectRevision: result.projectRevision, source: 'external' });
      setNotice('Properties saved to native project state.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [form, selected]);

  const toggleLock = useCallback(async () => {
    if (!selected) return;
    setBusy(true);
    try {
      const live = await engineClient.snapshot();
      const current = live.nodes.find((candidate) => candidate.id === selected.id);
      if (!current) throw new Error('Node no longer exists.');
      const result = await engineClient.apply([{
        type: 'node.lock',
        id: current.id,
        expectedRevision: current.revision,
        locked: !current.locked,
      }], {
        actor: 'user',
        source: 'studio-node-properties',
        reason: `${current.locked ? 'unlock' : 'lock'} ${current.kind} properties`,
      }, live.projectRevision);
      setSnapshot(result.snapshot);
      announceProjectChanged({ projectRevision: result.projectRevision, source: 'external' });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [selected]);

  if (!selected || !capability || !form) return null;

  return (
    <aside className="node-properties-dock" aria-label={`${capability.label} properties`}>
      <div className="node-properties-dock__header">
        <div>
          <small>{capability.role.toUpperCase()} · {selected.kind.toUpperCase()}</small>
          <strong>{capability.label}</strong>
        </div>
        <button onClick={() => setNodeId(null)} title="Close properties"><X size={14} /></button>
      </div>

      <div className="node-properties-dock__purpose">
        <Braces size={15} />
        <div>
          <strong>Why this node exists</strong>
          <p>{capability.purpose}</p>
          <small>Output · {capability.primaryOutput}</small>
        </div>
      </div>

      <div className="node-properties-dock__io">
        <div><span>Consumes</span><strong>{capability.consumes.length ? capability.consumes.join(' · ') : 'root scope'}</strong></div>
        <div><span>Produces</span><strong>{capability.produces.length ? capability.produces.join(' · ') : 'terminal state'}</strong></div>
      </div>

      <label className="node-property-field node-property-field--title">
        <span>Title</span>
        <input value={form.title} disabled={selected.locked || busy} onChange={(event) => setForm({ ...form, title: event.target.value })} />
      </label>

      <div className="node-properties-dock__fields">
        {capability.fields.map((field) => (
          <label className={`node-property-field node-property-field--${field.scope}`} key={field.key}>
            <span>
              {field.label}
              {field.requiredFor ? <em>{field.requiredFor}</em> : null}
            </span>
            <FieldControl
              field={field}
              value={form.metadata[field.key] ?? ''}
              disabled={selected.locked || busy}
              onChange={(value) => patchMetadata(field.key, value)}
            />
            <small>{field.description}</small>
          </label>
        ))}
      </div>

      <div className="node-properties-dock__invariants">
        <span><ShieldCheck size={13} /> Native invariants</span>
        {capability.invariants.map((invariant) => <small key={invariant}>{invariant}</small>)}
      </div>

      {notice ? <p className="node-properties-dock__notice">{notice}</p> : null}
      <div className="node-properties-dock__actions">
        <button onClick={() => void toggleLock()} disabled={busy}>
          {selected.locked ? <Unlock size={13} /> : <Lock size={13} />}
          {selected.locked ? 'Unlock' : 'Lock'}
        </button>
        <button className="primary" onClick={() => void save()} disabled={busy || selected.locked}>
          <Save size={13} /> Save properties
        </button>
      </div>
    </aside>
  );
}
