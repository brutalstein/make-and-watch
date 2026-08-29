import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot,
  Check,
  CircleAlert,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import { engineClient } from '../engineClient';
import { resolveWorkflowPositions, workflowProjectKey } from '../workflowLayout';
import { validateAutopilotPlan } from './autopilotValidation';
import type { DirectorContextStats, DirectorProviderId, DirectorProviderStatus } from './providerTypes';

const LOGIN_POLL_INTERVAL_MS = 1_000;
const LOGIN_POLL_ATTEMPTS = 120;

function providerLabel(provider: DirectorProviderId) {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

function statusClass(status: DirectorProviderStatus) {
  if (status.policy === 'api_required') return 'director-link__provider--policy';
  if (!status.installed) return 'director-link__provider--missing';
  if (!status.capable) return 'director-link__provider--update';
  if (status.loginPending) return 'director-link__provider--connecting';
  if (!status.authenticated) return 'director-link__provider--auth';
  return 'director-link__provider--ready';
}

function statusLabel(status: DirectorProviderStatus | undefined) {
  if (!status) return 'checking…';
  if (status.policy === 'api_required') return status.installed ? 'CLI detected · API required' : 'API required';
  if (!status.installed) return 'not detected';
  if (!status.capable) return 'detected · update required';
  if (status.loginPending) return 'ChatGPT sign-in pending';
  if (status.planningAvailable) return status.planType ? `ChatGPT · ${status.planType}` : 'ChatGPT connected';
  if (status.loginAvailable) return 'connect ChatGPT';
  return status.authMethod || 'not ready';
}

function discoveryLabel(status: DirectorProviderStatus) {
  if (!status.executableName) return 'No local executable resolved';
  const source = status.discovery === 'known-user-bin'
    ? 'user CLI directory'
    : status.discovery === 'override'
      ? 'explicit override'
      : 'PATH';
  return `${status.executableName} · ${source}${status.version ? ` · ${status.version}` : ''}`;
}

function Stage({ label, active }: { label: string; active: boolean }) {
  return <span className={`director-link__stage ${active ? 'director-link__stage--active' : ''}`}>{label}</span>;
}

function delay(ms: number) {
  return new Promise<void>((resolvePromise) => window.setTimeout(resolvePromise, ms));
}

export function DirectorProviderDock() {
  const [mountTarget, setMountTarget] = useState<HTMLElement | null>(null);
  const [providers, setProviders] = useState<DirectorProviderStatus[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<DirectorProviderId>('codex');
  const [objective, setObjective] = useState('Review the current workflow and propose the smallest useful visual organization pass.');
  const [loading, setLoading] = useState(false);
  const [connectingProvider, setConnectingProvider] = useState<DirectorProviderId | null>(null);
  const [pendingAuthUrl, setPendingAuthUrl] = useState<string | null>(null);
  const [message, setMessage] = useState('Checking Director providers…');
  const [contextStats, setContextStats] = useState<DirectorContextStats | null>(null);
  const [planSummary, setPlanSummary] = useState<string | null>(null);
  const pollGeneration = useRef(0);

  useLayoutEffect(() => {
    const history = document.querySelector<HTMLElement>('.director-panel .chat-history');
    if (!history) return undefined;

    const slot = document.createElement('div');
    slot.className = 'director-provider-slot';
    slot.dataset.makewatchDirectorProvider = 'true';
    const autopilotCard = history.querySelector<HTMLElement>('.autopilot-card');
    if (autopilotCard?.nextSibling) history.insertBefore(slot, autopilotCard.nextSibling);
    else if (autopilotCard) autopilotCard.after(slot);
    else history.prepend(slot);
    setMountTarget(slot);

    return () => {
      pollGeneration.current += 1;
      slot.remove();
    };
  }, []);

  const refresh = useCallback(async () => {
    const result = await engineClient.directorProviders();
    setProviders(result.providers);
    return result;
  }, []);

  useEffect(() => {
    let active = true;
    void refresh()
      .then((result) => {
        if (!active) return;
        const ready = result.providers.find((provider) => provider.planningAvailable);
        if (ready) setSelectedProvider(ready.provider);
        const codex = result.providers.find((provider) => provider.provider === 'codex');
        setMessage(result.activeProviderRun
          ? `${providerLabel(result.activeProviderRun)} is planning…`
          : ready?.detail ?? codex?.detail ?? 'Director provider status loaded.');
      })
      .catch((error) => {
        if (active) setMessage(error instanceof Error ? error.message : String(error));
      });
    return () => { active = false; };
  }, [refresh]);

  const selectedStatus = useMemo(
    () => providers.find((provider) => provider.provider === selectedProvider) ?? null,
    [providers, selectedProvider],
  );

  const selectProvider = useCallback((providerId: DirectorProviderId) => {
    setSelectedProvider(providerId);
    setContextStats(null);
    setPlanSummary(null);
    setPendingAuthUrl(null);
    const status = providers.find((provider) => provider.provider === providerId);
    setMessage(status?.detail ?? `Checking ${providerLabel(providerId)}…`);
  }, [providers]);

  const pollLogin = useCallback(async (provider: DirectorProviderId, generation: number) => {
    for (let attempt = 0; attempt < LOGIN_POLL_ATTEMPTS; attempt += 1) {
      await delay(LOGIN_POLL_INTERVAL_MS);
      if (pollGeneration.current !== generation) return;

      try {
        const result = await refresh();
        const status = result.providers.find((candidate) => candidate.provider === provider);
        if (!status) continue;
        if (status.planningAvailable) {
          setConnectingProvider(null);
          setPendingAuthUrl(null);
          setMessage(`${providerLabel(provider)} connected${status.planType ? ` · ${status.planType}` : ''}. Director planning is ready.`);
          return;
        }
        if (attempt > 3 && !status.loginPending) {
          setConnectingProvider(null);
          setMessage('Sign-in did not complete. You can retry the official connection without reinstalling the CLI.');
          return;
        }
      } catch (error) {
        if (attempt === LOGIN_POLL_ATTEMPTS - 1) {
          setConnectingProvider(null);
          setMessage(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (pollGeneration.current === generation) {
      setConnectingProvider(null);
      setMessage('Sign-in timed out locally. The Codex CLI remains installed; retry Connect when ready.');
    }
  }, [refresh]);

  const connect = useCallback(async (provider: DirectorProviderId) => {
    pollGeneration.current += 1;
    const generation = pollGeneration.current;
    setLoading(true);
    setConnectingProvider(provider);
    setSelectedProvider(provider);
    setPlanSummary(null);
    setContextStats(null);

    const popup = provider === 'codex'
      ? window.open('about:blank', 'makewatch-codex-login', 'popup,width=760,height=840')
      : null;
    if (popup) popup.opener = null;

    try {
      const result = await engineClient.connectDirector(provider);
      setMessage(result.message);
      setPendingAuthUrl(result.authUrl);

      if (result.authUrl) {
        if (popup) popup.location.replace(result.authUrl);
        else window.open(result.authUrl, '_blank', 'noopener,noreferrer');
      } else {
        popup?.close();
      }

      if (!result.launched) {
        setConnectingProvider(null);
        await refresh();
        return;
      }

      void pollLogin(provider, generation);
    } catch (error) {
      popup?.close();
      setConnectingProvider(null);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [pollLogin, refresh]);

  const plan = useCallback(async () => {
    if (!selectedStatus?.planningAvailable || !objective.trim()) return;
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
      setPlanSummary(`${providerLabel(selectedProvider)} · ${result.plan.steps.length} validated steps · “${result.plan.title}”`);
      setMessage('Plan validated against the live native revision. Semantic project state was not changed.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [objective, selectedProvider, selectedStatus]);

  if (!mountTarget) return null;

  const content = (
    <section className="director-link" aria-label="AI Director provider connection">
      <div className="director-link__head">
        <span className="director-link__orb"><Bot size={14} /></span>
        <div>
          <strong>DIRECTOR LINK</strong>
          <small>provider session · bounded project context</small>
        </div>
        <button className="director-link__refresh" onClick={() => void refresh()} disabled={loading} title="Refresh provider status">
          <RefreshCw size={12} className={loading ? 'spin' : ''} />
        </button>
      </div>

      <div className="director-link__providers">
        {(['codex', 'claude'] as const).map((providerId) => {
          const status = providers.find((candidate) => candidate.provider === providerId);
          const ready = Boolean(status?.planningAvailable);
          const connecting = connectingProvider === providerId || Boolean(status?.loginPending);
          return (
            <button
              key={providerId}
              className={`director-link__provider ${status ? statusClass(status) : ''} ${selectedProvider === providerId ? 'director-link__provider--selected' : ''}`}
              onClick={() => selectProvider(providerId)}
              disabled={loading}
              title={status?.detail}
            >
              <span>{connecting ? <LoaderCircle size={12} className="spin" /> : ready ? <Check size={12} /> : <KeyRound size={12} />}</span>
              <div>
                <strong>{providerLabel(providerId)}</strong>
                <small>{statusLabel(status)}</small>
              </div>
            </button>
          );
        })}
      </div>

      {selectedStatus ? (
        <div className="director-link__status">
          <div className="director-link__stages" aria-label={`${providerLabel(selectedStatus.provider)} readiness`}>
            <Stage label="CLI" active={selectedStatus.installed} />
            <Stage label={selectedStatus.provider === 'codex' ? 'APP SERVER' : 'POLICY'} active={selectedStatus.capable || selectedStatus.policy === 'api_required'} />
            <Stage label="ACCOUNT" active={selectedStatus.authenticated} />
            <Stage label="PLAN" active={selectedStatus.planningAvailable} />
          </div>
          <div className="director-link__diagnostic">
            <code>{discoveryLabel(selectedStatus)}</code>
            <small>{selectedStatus.detail}</small>
          </div>
          {selectedStatus.capabilityIssues.map((issue) => (
            <div className="director-link__issue" key={issue}><CircleAlert size={10} /> {issue}</div>
          ))}
        </div>
      ) : null}

      {selectedStatus?.loginAvailable && !selectedStatus.authenticated ? (
        <button
          className="director-link__connect"
          onClick={() => void connect(selectedProvider)}
          disabled={loading || connectingProvider !== null}
        >
          <ExternalLink size={12} />
          {connectingProvider === selectedProvider ? 'Waiting for ChatGPT…' : `Connect ${providerLabel(selectedProvider)} officially`}
        </button>
      ) : null}

      {pendingAuthUrl && connectingProvider === 'codex' ? (
        <a className="director-link__auth-link" href={pendingAuthUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={10} /> Reopen ChatGPT sign-in
        </a>
      ) : null}

      {selectedStatus?.policy === 'api_required' ? (
        <div className="director-link__policy">
          <ShieldCheck size={11} />
          <span>Claude Code is detected, but its subscription login is not routed through the public product. Claude production support will use a supported Anthropic API/Console provider.</span>
        </div>
      ) : null}

      {selectedStatus?.planningAvailable ? (
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
            disabled={loading || !objective.trim()}
            title="Generate and validate an Assist-mode plan"
          >
            {loading ? <RefreshCw size={13} className="spin" /> : <Send size={13} />}
          </button>
        </div>
      ) : null}

      {contextStats ? (
        <div className="director-link__stats">
          <span><Sparkles size={10} /> ~{contextStats.estimatedTokens.toLocaleString()} ctx</span>
          <span>{contextStats.nodeCountIncluded} nodes</span>
          <span>{contextStats.dependencyCountIncluded} edges</span>
        </div>
      ) : null}

      {planSummary ? <div className="director-link__plan"><ShieldCheck size={11} /> {planSummary}</div> : null}
      <p className="director-link__message">{message}</p>
    </section>
  );

  return createPortal(content, mountTarget);
}
