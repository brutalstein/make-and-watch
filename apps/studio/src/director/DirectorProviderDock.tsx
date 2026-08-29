import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot,
  Check,
  CircleAlert,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  WandSparkles,
} from 'lucide-react';

import { engineClient } from '../engineClient';
import { resolveWorkflowPositions, workflowProjectKey } from '../workflowLayout';
import { validateAutopilotPlan } from './autopilotValidation';
import type { DirectorContextStats, DirectorProviderId, DirectorProviderStatus } from './providerTypes';

const LOGIN_POLL_INTERVAL_MS = 1_000;
const LOGIN_POLL_ATTEMPTS = 120;
const MAX_VISIBLE_MESSAGES = 80;

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  meta?: string;
}

function providerLabel(provider: DirectorProviderId) {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

function statusLabel(status: DirectorProviderStatus | undefined) {
  if (!status) return 'Checking…';
  if (status.policy === 'api_required') return status.installed ? 'CLI detected · API provider required' : 'API provider required';
  if (!status.installed) return 'Not detected';
  if (!status.capable) return 'Update required';
  if (status.loginPending) return 'ChatGPT sign-in pending';
  if (status.chatAvailable) return status.planType ? `ChatGPT · ${status.planType}` : 'ChatGPT connected';
  if (status.loginAvailable) return 'Connect ChatGPT';
  return status.detail;
}

function delay(ms: number) {
  return new Promise<void>((resolvePromise) => window.setTimeout(resolvePromise, ms));
}

function makeMessage(role: ChatMessage['role'], text: string, meta?: string): ChatMessage {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    meta,
  };
}

export function DirectorProviderDock() {
  const [mountTarget, setMountTarget] = useState<HTMLElement | null>(null);
  const [providers, setProviders] = useState<DirectorProviderStatus[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<DirectorProviderId>('codex');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [composer, setComposer] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([
    makeMessage('system', 'Connect a Director, then talk naturally about your series, episodes, characters, shots, continuity, or production choices. Chat can discuss the project but cannot silently mutate native project state.'),
  ]);
  const [loading, setLoading] = useState(false);
  const [connectingProvider, setConnectingProvider] = useState<DirectorProviderId | null>(null);
  const [pendingAuthUrl, setPendingAuthUrl] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('Checking Director providers…');
  const [lastContext, setLastContext] = useState<DirectorContextStats | null>(null);
  const pollGeneration = useRef(0);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const workspace = document.querySelector<HTMLElement>('.workspace');
    const canvas = workspace?.querySelector<HTMLElement>('.canvas-panel');
    if (!workspace || !canvas) return undefined;

    const slot = document.createElement('aside');
    slot.className = 'director-chat-panel';
    slot.dataset.makewatchDirectorChat = 'true';
    workspace.insertBefore(slot, canvas);
    setMountTarget(slot);

    return () => {
      pollGeneration.current += 1;
      slot.remove();
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages, loading]);

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
        const chatReady = result.providers.find((provider) => provider.chatAvailable);
        if (chatReady) setSelectedProvider(chatReady.provider);
        const codex = result.providers.find((provider) => provider.provider === 'codex');
        setStatusMessage(
          result.activeProviderRun
            ? `${providerLabel(result.activeProviderRun)} is working…`
            : chatReady?.detail ?? codex?.detail ?? 'Director provider status loaded.',
        );
      })
      .catch((error) => {
        if (active) setStatusMessage(error instanceof Error ? error.message : String(error));
      });
    return () => { active = false; };
  }, [refresh]);

  const selectedStatus = useMemo(
    () => providers.find((provider) => provider.provider === selectedProvider) ?? null,
    [providers, selectedProvider],
  );

  const selectProvider = useCallback(async (providerId: DirectorProviderId) => {
    if (providerId === selectedProvider) return;
    if (conversationId) {
      try {
        await engineClient.closeDirectorChat(selectedProvider, conversationId);
      } catch {
        // Provider session cleanup is best-effort during a manual provider switch.
      }
    }
    setConversationId(null);
    setMessages([makeMessage('system', `Switched to ${providerLabel(providerId)}. Start a new Director conversation when this provider is ready.`)]);
    setLastContext(null);
    setSelectedProvider(providerId);
    setPendingAuthUrl(null);
    const status = providers.find((provider) => provider.provider === providerId);
    setStatusMessage(status?.detail ?? `Checking ${providerLabel(providerId)}…`);
  }, [conversationId, providers, selectedProvider]);

  const pollLogin = useCallback(async (provider: DirectorProviderId, generation: number) => {
    for (let attempt = 0; attempt < LOGIN_POLL_ATTEMPTS; attempt += 1) {
      await delay(LOGIN_POLL_INTERVAL_MS);
      if (pollGeneration.current !== generation) return;
      try {
        const result = await refresh();
        const status = result.providers.find((candidate) => candidate.provider === provider);
        if (!status) continue;
        if (status.chatAvailable) {
          setConnectingProvider(null);
          setPendingAuthUrl(null);
          setStatusMessage(`${providerLabel(provider)} connected${status.planType ? ` · ${status.planType}` : ''}. Director chat is ready.`);
          setMessages((current) => [...current, makeMessage('system', `${providerLabel(provider)} is connected. You can message the Director now.`)].slice(-MAX_VISIBLE_MESSAGES));
          return;
        }
        if (attempt > 3 && !status.loginPending) {
          setConnectingProvider(null);
          setStatusMessage('Sign-in did not complete. Retry the official connection when ready.');
          return;
        }
      } catch (error) {
        if (attempt === LOGIN_POLL_ATTEMPTS - 1) {
          setConnectingProvider(null);
          setStatusMessage(error instanceof Error ? error.message : String(error));
        }
      }
    }
    if (pollGeneration.current === generation) {
      setConnectingProvider(null);
      setStatusMessage('Sign-in timed out locally. Retry Connect when ready.');
    }
  }, [refresh]);

  const connect = useCallback(async (provider: DirectorProviderId) => {
    pollGeneration.current += 1;
    const generation = pollGeneration.current;
    setLoading(true);
    setConnectingProvider(provider);
    setSelectedProvider(provider);

    const popup = provider === 'codex'
      ? window.open('about:blank', 'makewatch-codex-login', 'popup,width=760,height=840')
      : null;
    if (popup) popup.opener = null;

    try {
      const result = await engineClient.connectDirector(provider);
      setStatusMessage(result.message);
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
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [pollLogin, refresh]);

  const sendChat = useCallback(async () => {
    const text = composer.trim();
    if (!text || !selectedStatus?.chatAvailable || loading) return;
    setComposer('');
    setMessages((current) => [...current, makeMessage('user', text)].slice(-MAX_VISIBLE_MESSAGES));
    setLoading(true);
    try {
      const result = await engineClient.directorChat({
        provider: selectedProvider,
        conversationId,
        message: text,
        selectedId: null,
      });
      setConversationId(result.conversationId);
      setLastContext(result.context);
      setMessages((current) => [
        ...current,
        makeMessage(
          'assistant',
          result.reply,
          `${providerLabel(result.provider)} · turn ${result.turnCount} · native rev ${result.projectRevision}`,
        ),
      ].slice(-MAX_VISIBLE_MESSAGES));
      setStatusMessage(`Conversation active · turn ${result.turnCount}`);
    } catch (error) {
      setMessages((current) => [...current, makeMessage('system', error instanceof Error ? error.message : String(error))].slice(-MAX_VISIBLE_MESSAGES));
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [composer, conversationId, loading, selectedProvider, selectedStatus]);

  const newConversation = useCallback(async () => {
    if (conversationId) {
      try {
        await engineClient.closeDirectorChat(selectedProvider, conversationId);
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    }
    setConversationId(null);
    setComposer('');
    setLastContext(null);
    setMessages([makeMessage('system', `New ${providerLabel(selectedProvider)} Director conversation. Native project state has not changed.`)]);
  }, [conversationId, selectedProvider]);

  const createAssistPlan = useCallback(async () => {
    const objective = composer.trim();
    if (!objective || !selectedStatus?.planningAvailable || loading) return;
    if (document.querySelector('.studio-shell--autopilot')) {
      setStatusMessage('Return control from the current Autopilot pass before asking for a new plan.');
      return;
    }
    setLoading(true);
    try {
      const before = await engineClient.snapshot();
      const workspacePositions = resolveWorkflowPositions(before, workflowProjectKey(before));
      const result = await engineClient.directorPlan({
        provider: selectedProvider,
        objective,
        mode: 'assist',
        selectedId: null,
        workspacePositions,
      });
      const liveSnapshot = await engineClient.snapshot();
      const validation = validateAutopilotPlan(result.plan, liveSnapshot);
      if (!validation.ok) throw new Error(`Provider plan rejected: ${validation.errors.join(' · ')}`);
      if (result.plan.mode !== 'assist') throw new Error('Studio preview plan must remain Assist-only');
      setLastContext(result.context);
      setMessages((current) => [
        ...current,
        makeMessage(
          'system',
          `Validated Assist plan: “${result.plan.title}” · ${result.plan.steps.length} typed steps. No semantic project mutation was applied.`,
          `${providerLabel(selectedProvider)} plan preview`,
        ),
      ].slice(-MAX_VISIBLE_MESSAGES));
      setStatusMessage('Assist plan validated against the live native revision.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [composer, loading, selectedProvider, selectedStatus]);

  if (!mountTarget) return null;

  const content = (
    <section className="director-chat" aria-label="AI Director chat">
      <header className="director-chat__header">
        <div className="director-chat__identity">
          <span className="director-chat__orb"><WandSparkles size={18} /></span>
          <div>
            <span className="director-chat__eyebrow">AI DIRECTOR</span>
            <strong>Director Chat</strong>
            <small>Long-form creative conversation · native state protected</small>
          </div>
        </div>
        <div className="director-chat__header-actions">
          <button onClick={() => void refresh()} disabled={loading} title="Refresh provider status"><RefreshCw size={15} /></button>
          <button onClick={() => void newConversation()} disabled={loading} title="New Director conversation"><Plus size={16} /></button>
        </div>
      </header>

      <div className="director-chat__providers">
        {(['codex', 'claude'] as const).map((providerId) => {
          const status = providers.find((candidate) => candidate.provider === providerId);
          const selected = selectedProvider === providerId;
          const connecting = connectingProvider === providerId || Boolean(status?.loginPending);
          const ready = Boolean(status?.chatAvailable);
          return (
            <button
              key={providerId}
              className={`director-chat__provider ${selected ? 'director-chat__provider--selected' : ''} ${ready ? 'director-chat__provider--ready' : ''}`}
              onClick={() => void selectProvider(providerId)}
              disabled={loading}
            >
              <span className="director-chat__provider-icon">
                {connecting ? <LoaderCircle size={15} className="spin" /> : ready ? <Check size={15} /> : <KeyRound size={15} />}
              </span>
              <span>
                <strong>{providerLabel(providerId)}</strong>
                <small>{statusLabel(status)}</small>
              </span>
            </button>
          );
        })}
      </div>

      <div className="director-chat__connection">
        {selectedStatus?.loginAvailable && !selectedStatus.authenticated ? (
          <button className="director-chat__connect" onClick={() => void connect(selectedProvider)} disabled={loading || connectingProvider !== null}>
            <ExternalLink size={14} /> {connectingProvider === selectedProvider ? 'Waiting for sign-in…' : `Connect ${providerLabel(selectedProvider)}`}
          </button>
        ) : null}
        {pendingAuthUrl && connectingProvider === 'codex' ? (
          <a href={pendingAuthUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Reopen ChatGPT sign-in</a>
        ) : null}
        {selectedStatus?.policy === 'api_required' ? (
          <div className="director-chat__policy"><ShieldCheck size={14} /><span>Claude CLI can be detected, but public-product Claude chat requires a supported Anthropic API/Console provider. Subscription routing is not faked.</span></div>
        ) : null}
        {selectedStatus?.capabilityIssues.map((issue) => (
          <div className="director-chat__issue" key={issue}><CircleAlert size={13} /> {issue}</div>
        ))}
        <p>{statusMessage}</p>
      </div>

      <div className="director-chat__messages" aria-live="polite">
        {messages.map((message) => (
          <article key={message.id} className={`director-chat__message director-chat__message--${message.role}`}>
            <div className="director-chat__message-label">
              {message.role === 'assistant' ? <Bot size={14} /> : message.role === 'user' ? <MessageSquareText size={14} /> : <Sparkles size={14} />}
              <span>{message.role === 'assistant' ? providerLabel(selectedProvider) : message.role === 'user' ? 'You' : 'Studio'}</span>
            </div>
            <p>{message.text}</p>
            {message.meta ? <small>{message.meta}</small> : null}
          </article>
        ))}
        {loading ? (
          <article className="director-chat__message director-chat__message--assistant director-chat__message--loading">
            <div className="director-chat__message-label"><LoaderCircle size={14} className="spin" /><span>{providerLabel(selectedProvider)}</span></div>
            <p>Thinking with the current series context…</p>
          </article>
        ) : null}
        <div ref={bottomRef} />
      </div>

      <footer className="director-chat__composer">
        {lastContext ? (
          <div className="director-chat__context-line">
            <span>~{lastContext.estimatedTokens.toLocaleString()} ctx</span>
            <span>{lastContext.nodeCountIncluded} nodes</span>
            <span>{lastContext.dependencyCountIncluded} edges</span>
          </div>
        ) : null}
        <textarea
          value={composer}
          onChange={(event) => setComposer(event.target.value.slice(0, 6000))}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void sendChat();
            }
          }}
          placeholder={selectedStatus?.chatAvailable ? 'Talk to your Director about the series…' : 'Connect a supported Director to start chatting…'}
          disabled={loading || !selectedStatus?.chatAvailable}
          rows={4}
          aria-label="Message the AI Director"
        />
        <div className="director-chat__composer-actions">
          <span>Enter to send · Shift+Enter for a new line</span>
          <div>
            <button className="director-chat__plan-button" onClick={() => void createAssistPlan()} disabled={loading || !composer.trim() || !selectedStatus?.planningAvailable}>
              <Sparkles size={14} /> Preview plan
            </button>
            <button className="director-chat__send-button" onClick={() => void sendChat()} disabled={loading || !composer.trim() || !selectedStatus?.chatAvailable}>
              <Send size={16} /> Send
            </button>
          </div>
        </div>
      </footer>
    </section>
  );

  return createPortal(content, mountTarget);
}
