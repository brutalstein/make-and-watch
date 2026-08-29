import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, Check, ExternalLink, KeyRound, RefreshCw, Send, ShieldCheck, Sparkles } from 'lucide-react';

import { engineClient } from '../engineClient';
import { resolveWorkflowPositions, workflowProjectKey } from '../workflowLayout';
import { validateAutopilotPlan } from './autopilotValidation';
import type { DirectorContextStats, DirectorProviderId, DirectorProviderStatus } from './providerTypes';

function providerLabel(provider: DirectorProviderId) {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

function statusClass(status: DirectorProviderStatus) {
  if (!status.installed) return 'director-link__provider--missing';
  if (!status.capable) return 'director-link__provider--update';
  if (!status.authenticated) return 'director-link__provider--auth';
  return 'director-link__provider--ready';
}

export function DirectorProviderDock() {
  const [providers, setProviders] = useState<DirectorProviderStatus[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<DirectorProviderId>('codex');
  const [objective, setObjective] = useState('Review the current workflow and propose the smallest useful visual organization pass.');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('Checking first-party Director clients…');
  const [contextStats, setContextStats] = useState<DirectorContextStats | null>(null);
  const [planSummary, setPlanSummary] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await engineClient.directorProviders();
      setProviders(result.providers);
      const ready = result.providers.find((provider) => provider.authenticated && provider.capable);
      if (ready) setSelectedProvider(ready.provider);
      setMessage(result.activeProviderRun
        ? `${providerLabel(result.activeProviderRun)} is planning…`
        : 'Official clients own authentication · Make & Watch stores no OAuth token.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedStatus = useMemo(
    () => providers.find((provider) => provider.provider === selectedProvider) ?? null,
    [providers, selectedProvider],
  );

  const connect = useCallback(async (provider: DirectorProviderId) => {
    setLoading(true);
    setSelectedProvider(provider);
    try {
      const result = await engineClient.connectDirector(provider);
      setMessage(result.message);
      window.setTimeout(() => { void refresh(); }, 1800);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [refresh]);

  const plan = useCallback(async () => {
    if (!selectedStatus?.authenticated || !selectedStatus.capable || !objective.trim()) return;
    if (document.querySelector('.studio-shell--autopilot')) {
      setMessage('Return control from the current Autopilot pass before asking a provider for a new plan.');
      return;
    }

    setLoading(true);
    setContextStats(null);
    setPlanSummary(null);
    try {
      const before = await engineClient.snapshot();
      const workspacePositions = resolveWorkflowPositions(before, workflowProjectKey(before));
      const result = await engineClient.directorPlan({
        provider: selectedProvider,
        objective: objective.trim(),
        mode: 'assist',
        selectedId: null,
        workspacePositions,
      });
      const liveSnapshot = await engineClient.snapshot();
      const validation = validateAutopilotPlan(result.plan, liveSnapshot);
      if (!validation.ok) throw new Error(`Provider plan rejected: ${validation.errors.join(' · ')}`);
      if (result.plan.mode !== 'assist') throw new Error('Connection-phase Director plan must remain Assist-only');

      setContextStats(result.context);
      setPlanSummary(`${providerLabel(selectedProvider)} produced ${result.plan.steps.length} validated steps · “${result.plan.title}”`);
      setMessage('Plan validated against the live native revision. Semantic project state was not changed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [objective, selectedProvider, selectedStatus]);

  return (
    <section className="director-link" aria-label="AI Director provider connection">
      <div className="director-link__head">
        <span className="director-link__orb"><Bot size={14} /></span>
        <div>
          <strong>DIRECTOR LINK</strong>
          <small>First-party auth · project-scoped context</small>
        </div>
        <button className="director-link__refresh" onClick={() => void refresh()} disabled={loading} title="Refresh provider status">
          <RefreshCw size={12} className={loading ? 'spin' : ''} />
        </button>
      </div>

      <div className="director-link__providers">
        {(['codex', 'claude'] as const).map((providerId) => {
          const status = providers.find((candidate) => candidate.provider === providerId);
          const ready = Boolean(status?.installed && status.capable && status.authenticated);
          return (
            <button
              key={providerId}
              className={`director-link__provider ${status ? statusClass(status) : ''} ${selectedProvider === providerId ? 'director-link__provider--selected' : ''}`}
              onClick={() => setSelectedProvider(providerId)}
              disabled={loading}
            >
              <span>{ready ? <Check size={12} /> : <KeyRound size={12} />}</span>
              <div>
                <strong>{providerLabel(providerId)}</strong>
                <small>{status?.authenticated ? status.authMethod || 'authenticated' : status?.installed ? 'sign-in needed' : 'not installed'}</small>
              </div>
            </button>
          );
        })}
      </div>

      {selectedStatus && !selectedStatus.authenticated ? (
        <button
          className="director-link__connect"
          onClick={() => void connect(selectedProvider)}
          disabled={loading || !selectedStatus.installed || !selectedStatus.capable}
        >
          <ExternalLink size={12} /> Connect {providerLabel(selectedProvider)} officially
        </button>
      ) : null}

      <div className="director-link__objective">
        <textarea
          value={objective}
          onChange={(event) => setObjective(event.target.value.slice(0, 4000))}
          rows={3}
          disabled={loading}
          aria-label="AI Director objective"
        />
        <button
          onClick={() => void plan()}
          disabled={loading || !selectedStatus?.authenticated || !selectedStatus.capable || !objective.trim()}
          title="Generate a validated Assist-mode plan"
        >
          {loading ? <RefreshCw size={13} className="spin" /> : <Send size={13} />}
        </button>
      </div>

      {contextStats ? (
        <div className="director-link__stats">
          <span><Sparkles size={10} /> ~{contextStats.estimatedTokens.toLocaleString()} ctx tokens</span>
          <span>{contextStats.nodeCountIncluded} nodes</span>
          <span>{contextStats.dependencyCountIncluded} edges</span>
        </div>
      ) : null}

      {planSummary ? <div className="director-link__plan"><ShieldCheck size={11} /> {planSummary}</div> : null}
      <p>{message}</p>
    </section>
  );
}
