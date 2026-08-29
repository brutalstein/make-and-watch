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
  if (status.policy === 'api_required') return 'director-link__provider--policy';
  if (!status.installed) return 'director-link__provider--missing';
  if (!status.capable) return 'director-link__provider--update';
  if (!status.authenticated) return 'director-link__provider--auth';
  return 'director-link__provider--ready';
}

function statusLabel(status: DirectorProviderStatus | undefined) {
  if (!status) return 'checking…';
  if (status.policy === 'api_required') return status.installed ? 'detected · API required' : 'API required for product';
  if (status.policy === 'experimental_local_client') {
    return status.authenticated ? 'developer preview · authenticated' : 'developer preview';
  }
  if (!status.installed) return 'not detected';
  if (!status.capable) return 'detected · update required';
  if (!status.authenticated) return 'detected · sign-in needed';
  return status.authMethod || 'authenticated';
}

function discoveryLabel(status: DirectorProviderStatus) {
  if (!status.executableName) return 'No executable resolved';
  const source = status.discovery === 'known-user-bin'
    ? 'user CLI directory'
    : status.discovery === 'override'
      ? 'explicit override'
      : 'PATH';
  return `${status.executableName} · ${source}${status.version ? ` · ${status.version}` : ''}`;
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
      const current = result.providers.find((provider) => provider.provider === (ready?.provider ?? selectedProvider));
      setMessage(result.activeProviderRun
        ? `${providerLabel(result.activeProviderRun)} is planning…`
        : current?.detail ?? 'Codex uses first-party ChatGPT sign-in. Make & Watch stores no provider OAuth token.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [selectedProvider]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectedStatus = useMemo(
    () => providers.find((provider) => provider.provider === selectedProvider) ?? null,
    [providers, selectedProvider],
  );

  const selectProvider = useCallback((providerId: DirectorProviderId) => {
    setSelectedProvider(providerId);
    setContextStats(null);
    setPlanSummary(null);
    const status = providers.find((provider) => provider.provider === providerId);
    if (status) setMessage(status.detail);
    else setMessage(`Checking ${providerLabel(providerId)}…`);
  }, [providers]);

  useEffect(() => {
    if (selectedStatus) setMessage(selectedStatus.detail);
  }, [selectedStatus]);

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

  const canConnect = Boolean(
    selectedStatus
    && selectedStatus.policy !== 'api_required'
    && selectedStatus.installed
    && selectedStatus.capable
    && !selectedStatus.authenticated,
  );

  return (
    <section className="director-link" aria-label="AI Director provider connection">
      <div className="director-link__head">
        <span className="director-link__orb"><Bot size={14} /></span>
        <div>
          <strong>DIRECTOR LINK</strong>
          <small>first-party detection · bounded project context</small>
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
              onClick={() => selectProvider(providerId)}
              disabled={loading}
              title={status?.detail}
            >
              <span>{ready ? <Check size={12} /> : <KeyRound size={12} />}</span>
              <div>
                <strong>{providerLabel(providerId)}</strong>
                <small>{statusLabel(status)}</small>
              </div>
            </button>
          );
        })}
      </div>

      {selectedStatus ? (
        <div className={`director-link__diagnostic ${selectedStatus.installed ? 'director-link__diagnostic--detected' : ''}`}>
          <div>
            <strong>{providerLabel(selectedStatus.provider)}</strong>
            <span>{selectedStatus.installed ? 'CLI DETECTED' : 'CLI NOT DETECTED'}</span>
          </div>
          <code>{discoveryLabel(selectedStatus)}</code>
          <small>{selectedStatus.detail}</small>
        </div>
      ) : null}

      {canConnect ? (
        <button
          className="director-link__connect"
          onClick={() => void connect(selectedProvider)}
          disabled={loading}
        >
          <ExternalLink size={12} /> Connect {providerLabel(selectedProvider)} officially
        </button>
      ) : null}

      {selectedStatus?.policy === 'api_required' ? (
        <div className="director-link__policy"><ShieldCheck size={11} /> Claude Code can be detected locally, but subscription routing is intentionally disabled in the public product. A supported Anthropic API connector is required.</div>
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
