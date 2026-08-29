import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
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
const CHAT_OPEN_STORAGE_KEY = 'makewatch.studio.director-chat-open';

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
  if (!status) return 'Preparing…';
  if (status.policy === 'api_required') return status.installed ? 'CLI detected · API provider required' : 'API provider required';
  if (!status.installed) return 'Not detected';
  if (!status.capable) return 'Update required';
  if (status.loginPending) return 'Secure sign-in pending';
  if (status.chatAvailable) return status.planType ? `ChatGPT · ${status.planType}` : 'ChatGPT connected';
  if (status.loginAvailable) return 'Ready for ChatGPT sign-in';
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

function initialOpenState() {
  try {
    return window.localStorage.getItem(CHAT_OPEN_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

export function DirectorProviderDock() {
  const [mountTarget, setMountTarget] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(initialOpenState);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [providers, setProviders] = useState<DirectorProviderStatus[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<DirectorProviderId>('codex');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [composer, setComposer] = useState('');
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([
    makeMessage(
      'system',
      'Your Director is project-aware but not project-authoritative. Talk naturally about the series, episodes, characters, continuity, shots, pacing, and production choices. Any real project mutation still crosses the typed native approval boundary.',
    ),
  ]);
  const [providerBusy, setProviderBusy] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [planBusy, setPlanBusy] = useState(false);
  const [connectingProvider, setConnectingProvider] = useState<DirectorProviderId | null>(null);
  const [pendingAuthUrl, setPendingAuthUrl] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('Preparing Codex Director…');
  const [activityLabel, setActivityLabel] = useState('');
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
      workspace.classList.remove('workspace--director-chat-open', 'workspace--director-chat-closed');
      slot.remove();
    };
  }, []);

  useEffect(() => {
    if (!mountTarget) return;
    const workspace = mountTarget.closest<HTMLElement>('.workspace');
    mountTarget.classList.toggle('director-chat-panel--open', open);
    mountTarget.classList.toggle('director-chat-panel--closed', !open);
    workspace?.classList.toggle('workspace--director-chat-open', open);
    workspace?.classList.toggle('workspace--director-chat-closed', !open);
    try {
      window.localStorage.setItem(CHAT_OPEN_STORAGE_KEY, open ? '1' : '0');
    } catch {
      // Presentation preference persistence is best-effort only.
    }
  }, [mountTarget, open]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }, [messages, pendingText, chatBusy]);

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

  const codexStatus = useMemo(
    () => providers.find((provider) => provider.provider === 'codex') ?? null,
    [providers],
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
    setMessages([makeMessage('system', `Switched to ${providerLabel(providerId)}. Native project state has not changed.`)]);
    setLastContext(null);
    setSelectedProvider(providerId);
    setPendingAuthUrl(null);
    const status = providers.find((provider) => provider.provider === providerId);
    setStatusMessage(status?.detail ?? `Preparing ${providerLabel(providerId)}…`);
  }, [conversationId, providers, selectedProvider]);

  const waitForProviderReady = useCallback(async (provider: DirectorProviderId, generation: number) => {
    for (let attempt = 0; attempt < LOGIN_POLL_ATTEMPTS; attempt += 1) {
      await delay(LOGIN_POLL_INTERVAL_MS);
      if (pollGeneration.current !== generation) throw new Error('Director connection was superseded');
      const result = await refresh();
      const status = result.providers.find((candidate) => candidate.provider === provider);
      if (!status) continue;
      if (status.chatAvailable) return status;
      if (attempt > 4 && !status.loginPending && !status.loginAvailable) {
        throw new Error(status.detail || `${providerLabel(provider)} did not become ready`);
      }
    }
    throw new Error('Director sign-in timed out locally. Retry Send when ready.');
  }, [refresh]);

  const connectAndWait = useCallback(async (
    provider: DirectorProviderId,
    popup: Window | null,
  ): Promise<DirectorProviderStatus> => {
    pollGeneration.current += 1;
    const generation = pollGeneration.current;
    setProviderBusy(true);
    setConnectingProvider(provider);
    setConnectionsOpen(true);
    try {
      const result = await engineClient.connectDirector(provider);
      setStatusMessage(result.message);
      setPendingAuthUrl(result.authUrl);

      if (result.authUrl) {
        if (popup) popup.location.replace(result.authUrl);
        else setStatusMessage(`${result.message} Browser pop-up was blocked; use “Continue secure sign-in” below.`);
      } else {
        popup?.close();
      }

      if (!result.launched) {
        const refreshed = await refresh();
        const status = refreshed.providers.find((candidate) => candidate.provider === provider);
        if (!status?.chatAvailable) throw new Error(status?.detail ?? `${providerLabel(provider)} is not ready for chat`);
        setConnectingProvider(null);
        setPendingAuthUrl(null);
        return status;
      }

      const status = await waitForProviderReady(provider, generation);
      setConnectingProvider(null);
      setPendingAuthUrl(null);
      setStatusMessage(`${providerLabel(provider)} connected${status.planType ? ` · ${status.planType}` : ''}. Director chat is ready.`);
      return status;
    } catch (error) {
      popup?.close();
      setConnectingProvider(null);
      setStatusMessage(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setProviderBusy(false);
    }
  }, [refresh, waitForProviderReady]);

  const connect = useCallback(async (provider: DirectorProviderId) => {
    const popup = provider === 'codex'
      ? window.open('about:blank', 'makewatch-codex-login', 'popup,width=760,height=840')
      : null;
    if (popup) popup.opener = null;
    try {
      await connectAndWait(provider, popup);
    } catch {
      // Connection state and recovery action are rendered in the panel.
    }
  }, [connectAndWait]);

  const sendChat = useCallback(async () => {
    const text = composer.trim();
    if (!text || chatBusy) return;

    if (selectedProvider === 'claude' && selectedStatus?.policy === 'api_required') {
      setConnectionsOpen(true);
      setStatusMessage('Claude chat is waiting for the supported Anthropic API provider path. Select Codex to chat now.');
      return;
    }

    const needsConnection = !selectedStatus?.chatAvailable;
    const popup = needsConnection && selectedProvider === 'codex'
      ? window.open('about:blank', 'makewatch-codex-login', 'popup,width=760,height=840')
      : null;
    if (popup) popup.opener = null;

    setComposer('');
    setPendingText(text);
    setChatBusy(true);
    setActivityLabel(needsConnection ? 'Preparing secure Director connection…' : 'Thinking with the current series context…');
    let submittedToProvider = false;

    try {
      let ready = selectedStatus;
      if (!ready?.chatAvailable) {
        ready = await connectAndWait(selectedProvider, popup);
      } else {
        popup?.close();
      }
      if (!ready.chatAvailable) throw new Error(`${providerLabel(selectedProvider)} is not ready for Director chat`);

      setMessages((current) => [...current, makeMessage('user', text)].slice(-MAX_VISIBLE_MESSAGES));
      setPendingText(null);
      setActivityLabel('Thinking with the current series context…');
      submittedToProvider = true;

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
      setStatusMessage(`Conversation live · turn ${result.turnCount}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPendingText(null);
      if (!submittedToProvider) setComposer((current) => current || text);
      setMessages((current) => [...current, makeMessage('system', message, submittedToProvider ? 'Message may have reached the provider; review before retrying.' : 'Message was not submitted.')].slice(-MAX_VISIBLE_MESSAGES));
      setStatusMessage(message);
    } finally {
      setActivityLabel('');
      setChatBusy(false);
    }
  }, [chatBusy, composer, connectAndWait, conversationId, selectedProvider, selectedStatus]);

  const newConversation = useCallback(async () => {
    if (chatBusy) return;
    if (conversationId) {
      try {
        await engineClient.closeDirectorChat(selectedProvider, conversationId);
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : String(error));
      }
    }
    setConversationId(null);
    setLastContext(null);
    setMessages([makeMessage('system', `New ${providerLabel(selectedProvider)} Director conversation. Native project state has not changed.`)]);
  }, [chatBusy, conversationId, selectedProvider]);

  const createAssistPlan = useCallback(async () => {
    const objective = composer.trim();
    if (!objective || !selectedStatus?.planningAvailable || planBusy) return;
    if (document.querySelector('.studio-shell--autopilot')) {
      setStatusMessage('Return control from the current Autopilot pass before asking for a new plan.');
      return;
    }
    setPlanBusy(true);
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
      setPlanBusy(false);
    }
  }, [composer, planBusy, selectedProvider, selectedStatus]);

  if (!mountTarget) return null;

  if (!open) {
    return createPortal(
      <div className="director-chat-rail" aria-label="Open AI Director chat">
        <button className="director-chat-rail__button" onClick={() => setOpen(true)} title="Open Director Chat">
          <span className={`director-chat-rail__status ${codexStatus?.chatAvailable ? 'director-chat-rail__status--ready' : ''}`} />
          <MessageSquareText size={19} />
        </button>
        <span>DIRECTOR</span>
        <span>CHAT</span>
      </div>,
      mountTarget,
    );
  }

  const content = (
    <section className="director-chat" aria-label="AI Director chat">
      <header className="director-chat__header">
        <div className="director-chat__identity">
          <span className="director-chat__orb"><WandSparkles size={18} /></span>
          <div>
            <span className="director-chat__eyebrow">AI DIRECTOR</span>
            <strong>Director Chat</strong>
            <small>Creative conversation · native authority protected</small>
          </div>
        </div>
        <div className="director-chat__header-actions">
          <button onClick={() => setOpen(false)} title="Collapse Director Chat"><ChevronLeft size={17} /></button>
          <button onClick={() => void refresh()} disabled={providerBusy} title="Refresh provider status"><RefreshCw size={15} className={providerBusy ? 'spin' : ''} /></button>
          <button onClick={() => void newConversation()} disabled={chatBusy} title="New Director conversation"><Plus size={16} /></button>
        </div>
      </header>

      <div className="director-chat__readiness">
        <div className={`director-chat__live-dot ${selectedStatus?.chatAvailable ? 'director-chat__live-dot--ready' : ''}`} />
        <div>
          <strong>{providerLabel(selectedProvider)}</strong>
          <span>{statusLabel(selectedStatus ?? undefined)}</span>
        </div>
        <button onClick={() => setConnectionsOpen((current) => !current)}>
          Connections {connectionsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </div>

      <div className={`director-chat__connection-drawer ${connectionsOpen ? 'director-chat__connection-drawer--open' : ''}`} aria-hidden={!connectionsOpen}>
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
                disabled={chatBusy || providerBusy}
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
            <button className="director-chat__connect" onClick={() => void connect(selectedProvider)} disabled={providerBusy || chatBusy}>
              <ExternalLink size={14} /> {connectingProvider === selectedProvider ? 'Waiting for secure sign-in…' : `Connect ${providerLabel(selectedProvider)}`}
            </button>
          ) : null}
          {pendingAuthUrl && connectingProvider === 'codex' ? (
            <a href={pendingAuthUrl} target="_blank" rel="noreferrer"><ExternalLink size={12} /> Continue secure ChatGPT sign-in</a>
          ) : null}
          {selectedStatus?.policy === 'api_required' ? (
            <div className="director-chat__policy"><ShieldCheck size={14} /><span>Claude CLI may be detected, but product chat waits for a supported Anthropic API/Console provider. Subscription credentials are never routed through Make & Watch.</span></div>
          ) : null}
          {selectedStatus?.capabilityIssues.map((issue) => (
            <div className="director-chat__issue" key={issue}><CircleAlert size={13} /> {issue}</div>
          ))}
          <p>{statusMessage}</p>
        </div>
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

        {pendingText ? (
          <article className="director-chat__message director-chat__message--user director-chat__message--pending">
            <div className="director-chat__message-label"><MessageSquareText size={14} /><span>You · queued</span></div>
            <p>{pendingText}</p>
            <small>Waiting for the secure Director connection. This message has not been submitted yet.</small>
          </article>
        ) : null}

        {chatBusy ? (
          <article className="director-chat__message director-chat__message--assistant director-chat__message--loading">
            <div className="director-chat__message-label"><LoaderCircle size={14} className="spin" /><span>{providerLabel(selectedProvider)}</span></div>
            <p>{activityLabel || 'Preparing…'}</p>
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
        <div className="director-chat__input-shell">
          <textarea
            value={composer}
            onChange={(event) => setComposer(event.target.value.slice(0, 6000))}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void sendChat();
              }
            }}
            placeholder="Talk to your Director about the series…"
            rows={3}
            aria-label="Message the AI Director"
          />
          <button className="director-chat__send-button" onClick={() => void sendChat()} disabled={chatBusy || !composer.trim()} title="Send to Director">
            {chatBusy ? <LoaderCircle size={17} className="spin" /> : <Send size={17} />}
          </button>
        </div>
        <div className="director-chat__composer-actions">
          <span>{selectedStatus?.chatAvailable ? 'Enter to send · Shift+Enter for a new line' : 'Type now · first Send prepares Codex automatically'}</span>
          <button className="director-chat__plan-button" onClick={() => void createAssistPlan()} disabled={planBusy || chatBusy || !composer.trim() || !selectedStatus?.planningAvailable}>
            {planBusy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />} Preview plan
          </button>
        </div>
      </footer>
    </section>
  );

  return createPortal(content, mountTarget);
}
