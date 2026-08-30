import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Archive,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronUp,
  CircleAlert,
  ExternalLink,
  History,
  ImagePlus,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react';

import { engineClient } from '../engineClient';
import { resolveWorkflowPositions, workflowProjectKey } from '../workflowLayout';
import { validateAutopilotPlan } from './autopilotValidation';
import { directorReferenceClient, directorReferenceClientLimits } from './referenceClient';
import type {
  DirectorContextStats,
  DirectorConversationDocument,
  DirectorConversationMessage,
  DirectorConversationSummary,
  DirectorProviderId,
  DirectorProviderStatus,
  DirectorReferenceAttachment,
} from './providerTypes';

const LOGIN_POLL_INTERVAL_MS = 1_000;
const LOGIN_POLL_ATTEMPTS = 120;
const MAX_VISIBLE_MESSAGES = 160;
const CHAT_OPEN_STORAGE_KEY = 'makewatch.studio.director-chat-open';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  meta?: string;
  failed?: boolean;
  attachments?: DirectorReferenceAttachment[];
}

interface ReferenceDraft {
  id: string;
  filename: string;
  previewUrl: string;
  status: 'uploading' | 'ready' | 'error';
  reference?: DirectorReferenceAttachment;
  error?: string;
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

function modelLabel(status: DirectorProviderStatus | null) {
  if (!status?.model) return '';
  const short = status.model
    .replace(/^gpt-/i, 'GPT-')
    .replace(/5\.6-luna/i, '5.6 Luna')
    .replace(/5\.6-terra/i, '5.6 Terra')
    .replace(/5\.6-sol/i, '5.6 Sol');
  return `${short}${status.reasoningEffort ? ` · ${status.reasoningEffort}` : ''}`;
}

function delay(ms: number) {
  return new Promise<void>((resolvePromise) => window.setTimeout(resolvePromise, ms));
}

function makeMessage(
  role: ChatMessage['role'],
  text: string,
  meta?: string,
  attachments: DirectorReferenceAttachment[] = [],
): ChatMessage {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    text,
    meta,
    attachments,
  };
}

function welcomeMessage(provider: DirectorProviderId): ChatMessage {
  return makeMessage(
    'system',
    `New ${providerLabel(provider)} Director Room. Describe a character, paste a visual reference, or start with only a story idea. Your Director can make creative choices when you want it to, while real project changes stay behind typed Make & Watch tools and native revision checks.`,
  );
}

function archivedMessage(message: DirectorConversationMessage): ChatMessage {
  const revision = message.projectRevision === null ? '' : ` · native rev ${message.projectRevision}`;
  return {
    id: message.id,
    role: message.role,
    text: message.text,
    failed: message.delivery === 'failed',
    attachments: message.attachments ?? [],
    meta: `${new Date(message.createdAt).toLocaleString()}${revision}${message.delivery === 'failed' ? ' · failed' : ''}`,
  };
}

function initialOpenState() {
  try {
    return window.localStorage.getItem(CHAT_OPEN_STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function relativeUpdatedAt(value: string) {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 'unknown';
  const minutes = Math.max(0, Math.floor((Date.now() - time) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 14) return `${days}d`;
  return new Date(time).toLocaleDateString();
}

function MessageAttachments({ attachments }: { attachments: DirectorReferenceAttachment[] }) {
  if (!attachments.length) return null;
  return (
    <div className={`director-chat__message-media ${attachments.length === 1 ? 'director-chat__message-media--single' : ''}`}>
      {attachments.map((attachment) => {
        const url = directorReferenceClient.url(attachment.assetNodeId);
        return (
          <button
            type="button"
            key={attachment.assetNodeId}
            className="director-chat__message-image"
            onClick={() => { if (url) window.open(url, '_blank', 'noopener,noreferrer'); }}
            title={`Open ${attachment.filename}`}
          >
            <img src={url} alt={attachment.filename} loading="lazy" />
            <span>{attachment.filename}</span>
          </button>
        );
      })}
    </div>
  );
}

export function DirectorProviderDock() {
  const [mountTarget, setMountTarget] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(initialOpenState);
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(true);
  const [showArchived, setShowArchived] = useState(false);
  const [archiveSearch, setArchiveSearch] = useState('');
  const [conversationArchive, setConversationArchive] = useState<DirectorConversationSummary[]>([]);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [providers, setProviders] = useState<DirectorProviderStatus[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<DirectorProviderId>('codex');
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState('New Director conversation');
  const [composer, setComposer] = useState('');
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [pendingQueuedAttachments, setPendingQueuedAttachments] = useState<DirectorReferenceAttachment[]>([]);
  const [referenceDrafts, setReferenceDrafts] = useState<ReferenceDraft[]>([]);
  const referenceDraftsRef = useRef<ReferenceDraft[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([welcomeMessage('codex')]);
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const initialConversationLoaded = useRef(false);

  const updateReferenceDrafts = useCallback((updater: (current: ReferenceDraft[]) => ReferenceDraft[]) => {
    setReferenceDrafts((current) => {
      const next = updater(current);
      referenceDraftsRef.current = next;
      return next;
    });
  }, []);

  const clearReferenceDrafts = useCallback(() => {
    for (const draft of referenceDraftsRef.current) URL.revokeObjectURL(draft.previewUrl);
    referenceDraftsRef.current = [];
    setReferenceDrafts([]);
    setDragActive(false);
  }, []);

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
      for (const draft of referenceDraftsRef.current) URL.revokeObjectURL(draft.previewUrl);
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
  }, [messages, pendingText, chatBusy, referenceDrafts]);

  const refreshProviders = useCallback(async () => {
    const result = await engineClient.directorProviders();
    setProviders(result.providers);
    return result;
  }, []);

  const refreshArchive = useCallback(async (archived = showArchived) => {
    setArchiveBusy(true);
    try {
      const result = await engineClient.directorConversations(archived, 200);
      setConversationArchive(result.conversations);
      return result.conversations;
    } finally {
      setArchiveBusy(false);
    }
  }, [showArchived]);

  const loadConversation = useCallback(async (summary: DirectorConversationSummary) => {
    if (chatBusy || archiveBusy) return;
    setArchiveBusy(true);
    try {
      if (conversationId && conversationId !== summary.id) {
        await engineClient.closeDirectorChat(selectedProvider, conversationId).catch(() => undefined);
      }
      const result = await engineClient.readDirectorConversation(summary.id);
      const document: DirectorConversationDocument = result.conversation;
      clearReferenceDrafts();
      setConversationId(document.id);
      setConversationTitle(document.title);
      setSelectedProvider(document.provider);
      setMessages(document.messages.slice(-MAX_VISIBLE_MESSAGES).map(archivedMessage));
      setLastContext(null);
      setComposer('');
      setPendingText(null);
      setPendingQueuedAttachments([]);
      setStatusMessage(`${document.archivedAt ? 'Archived' : 'Conversation loaded'} · ${document.turnCount} turns · ${document.runtimeMode}`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setArchiveBusy(false);
    }
  }, [archiveBusy, chatBusy, clearReferenceDrafts, conversationId, selectedProvider]);

  useEffect(() => {
    let active = true;
    void Promise.all([refreshProviders(), engineClient.directorConversations(false, 200)])
      .then(([providerResult, archiveResult]) => {
        if (!active) return;
        setConversationArchive(archiveResult.conversations);
        initialConversationLoaded.current = true;
        const chatReady = providerResult.providers.find((provider) => provider.chatAvailable);
        if (chatReady) setSelectedProvider(chatReady.provider);
        const codex = providerResult.providers.find((provider) => provider.provider === 'codex');
        setStatusMessage(
          providerResult.activeProviderRun
            ? `${providerLabel(providerResult.activeProviderRun)} is working…`
            : chatReady?.detail ?? codex?.detail ?? 'Director provider status loaded.',
        );
        const latest = archiveResult.conversations[0];
        if (latest) {
          void engineClient.readDirectorConversation(latest.id).then((result) => {
            if (!active) return;
            const document = result.conversation;
            setConversationId(document.id);
            setConversationTitle(document.title);
            setSelectedProvider(document.provider);
            setMessages(document.messages.slice(-MAX_VISIBLE_MESSAGES).map(archivedMessage));
          }).catch(() => undefined);
        }
      })
      .catch((error) => {
        initialConversationLoaded.current = true;
        if (active) setStatusMessage(error instanceof Error ? error.message : String(error));
      });
    return () => { active = false; };
  }, [refreshProviders]);

  useEffect(() => {
    if (!initialConversationLoaded.current) return;
    void refreshArchive(showArchived).catch((error) => {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    });
  }, [refreshArchive, showArchived]);

  const selectedStatus = useMemo(
    () => providers.find((provider) => provider.provider === selectedProvider) ?? null,
    [providers, selectedProvider],
  );

  const codexStatus = useMemo(
    () => providers.find((provider) => provider.provider === 'codex') ?? null,
    [providers],
  );

  const readyReferences = useMemo(
    () => referenceDrafts.flatMap((draft) => draft.status === 'ready' && draft.reference ? [draft.reference] : []),
    [referenceDrafts],
  );
  const referenceUploadActive = referenceDrafts.some((draft) => draft.status === 'uploading');
  const referenceUploadErrors = referenceDrafts.some((draft) => draft.status === 'error');
  const canSend = !chatBusy && !archiveBusy && !referenceUploadActive && Boolean(composer.trim() || readyReferences.length);

  const filteredArchive = useMemo(() => {
    const query = archiveSearch.trim().toLowerCase();
    if (!query) return conversationArchive;
    return conversationArchive.filter((item) =>
      item.title.toLowerCase().includes(query)
      || item.preview.toLowerCase().includes(query)
      || providerLabel(item.provider).toLowerCase().includes(query));
  }, [archiveSearch, conversationArchive]);

  const addReferenceFiles = useCallback(async (files: File[]) => {
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (!images.length) {
      setStatusMessage('Director references accept PNG, JPEG, WebP or GIF images.');
      return;
    }
    const available = Math.max(0, directorReferenceClientLimits.maxAttachmentsPerMessage - referenceDraftsRef.current.length);
    if (available === 0) {
      setStatusMessage(`A Director message can carry up to ${directorReferenceClientLimits.maxAttachmentsPerMessage} reference images.`);
      return;
    }
    const selected = images.slice(0, available);
    if (images.length > selected.length) {
      setStatusMessage(`Only the first ${selected.length} image(s) were added; the per-message limit is ${directorReferenceClientLimits.maxAttachmentsPerMessage}.`);
    }

    const pairs = selected.map((file) => ({
      file,
      draft: {
        id: `reference-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        filename: file.name || 'reference-image',
        previewUrl: URL.createObjectURL(file),
        status: 'uploading' as const,
      },
    }));
    updateReferenceDrafts((current) => [...current, ...pairs.map(({ draft }) => draft)]);

    // Import sequentially. A message can carry several large references, and a
    // bounded upload lane avoids 8 simultaneous 24 MiB copies in browser + Node.
    for (const { file, draft } of pairs) {
      try {
        const result = await directorReferenceClient.importImage(file);
        updateReferenceDrafts((current) => current.map((candidate) => candidate.id === draft.id
          ? { ...candidate, status: 'ready', reference: result.reference, error: undefined }
          : candidate));
        setStatusMessage(`Reference archived · ${result.reference.filename}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        updateReferenceDrafts((current) => current.map((candidate) => candidate.id === draft.id
          ? { ...candidate, status: 'error', error: message }
          : candidate));
        setStatusMessage(message);
      }
    }
  }, [updateReferenceDrafts]);

  const removeReferenceDraft = useCallback((id: string) => {
    updateReferenceDrafts((current) => {
      const removed = current.find((draft) => draft.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((draft) => draft.id !== id);
    });
  }, [updateReferenceDrafts]);

  const retryReferenceDraft = useCallback(async (draft: ReferenceDraft) => {
    // Browser File objects are intentionally not persisted after a failed upload.
    // Re-open the picker instead of keeping hidden binary blobs in component state.
    removeReferenceDraft(draft.id);
    fileInputRef.current?.click();
  }, [removeReferenceDraft]);

  const selectProvider = useCallback(async (providerId: DirectorProviderId) => {
    if (providerId === selectedProvider) return;
    if (conversationId) {
      await engineClient.closeDirectorChat(selectedProvider, conversationId).catch(() => undefined);
    }
    clearReferenceDrafts();
    setConversationId(null);
    setConversationTitle('New Director conversation');
    setMessages([welcomeMessage(providerId)]);
    setLastContext(null);
    setSelectedProvider(providerId);
    setPendingAuthUrl(null);
    const status = providers.find((provider) => provider.provider === providerId);
    setStatusMessage(status?.detail ?? `Preparing ${providerLabel(providerId)}…`);
  }, [clearReferenceDrafts, conversationId, providers, selectedProvider]);

  const waitForProviderReady = useCallback(async (provider: DirectorProviderId, generation: number) => {
    for (let attempt = 0; attempt < LOGIN_POLL_ATTEMPTS; attempt += 1) {
      await delay(LOGIN_POLL_INTERVAL_MS);
      if (pollGeneration.current !== generation) throw new Error('Director connection was superseded');
      const result = await refreshProviders();
      const status = result.providers.find((candidate) => candidate.provider === provider);
      if (!status) continue;
      if (status.chatAvailable) return status;
      if (attempt > 4 && !status.loginPending && !status.loginAvailable) {
        throw new Error(status.detail || `${providerLabel(provider)} did not become ready`);
      }
    }
    throw new Error('Director sign-in timed out locally. Retry Send when ready.');
  }, [refreshProviders]);

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
        const refreshed = await refreshProviders();
        const status = refreshed.providers.find((candidate) => candidate.provider === provider);
        if (!status?.chatAvailable) throw new Error(status?.detail ?? `${providerLabel(provider)} is not ready for chat`);
        setConnectingProvider(null);
        setPendingAuthUrl(null);
        return status;
      }

      const status = await waitForProviderReady(provider, generation);
      setConnectingProvider(null);
      setPendingAuthUrl(null);
      setStatusMessage(`${providerLabel(provider)} connected${status.planType ? ` · ${status.planType}` : ''}. Director Room is ready.`);
      return status;
    } catch (error) {
      popup?.close();
      setConnectingProvider(null);
      setStatusMessage(error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      setProviderBusy(false);
    }
  }, [refreshProviders, waitForProviderReady]);

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
    const attachments = readyReferences;
    if ((!text && attachments.length === 0) || chatBusy || archiveBusy || referenceUploadActive) return;

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

    const visibleText = text || 'Reference image';
    setComposer('');
    setPendingText(visibleText);
    setPendingQueuedAttachments(attachments);
    setChatBusy(true);
    setActivityLabel(needsConnection ? 'Preparing secure Director connection…' : 'Thinking with project context, references and tools…');
    let submittedToProvider = false;

    try {
      let ready = selectedStatus;
      if (!ready?.chatAvailable) ready = await connectAndWait(selectedProvider, popup);
      else popup?.close();
      if (!ready.chatAvailable) throw new Error(`${providerLabel(selectedProvider)} is not ready for Director chat`);
      if (attachments.length && !ready.inputModalities.includes('image')) {
        throw new Error(`${providerLabel(selectedProvider)} is connected, but the selected Director model does not advertise image input.`);
      }

      setMessages((current) => [...current, makeMessage('user', visibleText, undefined, attachments)].slice(-MAX_VISIBLE_MESSAGES));
      setPendingText(null);
      setPendingQueuedAttachments([]);
      setActivityLabel('Thinking with project context, references and tools…');
      submittedToProvider = true;
      clearReferenceDrafts();

      const result = await engineClient.directorChat({
        provider: selectedProvider,
        conversationId,
        message: text || '[Reference image attached]',
        selectedId: null,
        attachmentAssetIds: attachments.map((attachment) => attachment.assetNodeId),
      });
      setConversationId(result.conversationId);
      setConversationTitle(result.title);
      setLastContext(result.context);
      setMessages((current) => [
        ...current,
        makeMessage(
          'assistant',
          result.reply,
          `${providerLabel(result.provider)}${result.model ? ` · ${result.model}` : ''}${result.reasoningEffort ? ` · ${result.reasoningEffort}` : ''} · turn ${result.turnCount} · native rev ${result.projectRevision}`,
        ),
      ].slice(-MAX_VISIBLE_MESSAGES));
      setStatusMessage(`Conversation saved · turn ${result.turnCount} · ${result.runtimeMode}${result.model ? ` · ${result.model}` : ''}`);
      void refreshArchive(false).catch(() => undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPendingText(null);
      setPendingQueuedAttachments([]);
      if (!submittedToProvider) setComposer((current) => current || text);
      setMessages((current) => [...current, makeMessage(
        'system',
        message,
        submittedToProvider ? 'Failure recorded in the conversation archive with its reference links; review before retrying.' : 'Message was not submitted.',
      )].slice(-MAX_VISIBLE_MESSAGES));
      setStatusMessage(message);
      if (submittedToProvider) void refreshArchive(false).catch(() => undefined);
    } finally {
      setActivityLabel('');
      setChatBusy(false);
    }
  }, [archiveBusy, chatBusy, clearReferenceDrafts, composer, connectAndWait, conversationId, readyReferences, referenceUploadActive, refreshArchive, selectedProvider, selectedStatus]);

  const newConversation = useCallback(async () => {
    if (chatBusy || archiveBusy) return;
    if (conversationId) {
      await engineClient.closeDirectorChat(selectedProvider, conversationId).catch(() => undefined);
    }
    clearReferenceDrafts();
    setConversationId(null);
    setConversationTitle('New Director conversation');
    setLastContext(null);
    setMessages([welcomeMessage(selectedProvider)]);
    setComposer('');
    setPendingText(null);
    setPendingQueuedAttachments([]);
    setStatusMessage('New Director Room ready. The previous conversation remains saved in Recent.');
  }, [archiveBusy, chatBusy, clearReferenceDrafts, conversationId, selectedProvider]);

  const renameConversation = useCallback(async () => {
    if (!conversationId || chatBusy || archiveBusy) return;
    const next = window.prompt('Conversation title', conversationTitle)?.trim();
    if (!next || next === conversationTitle) return;
    setArchiveBusy(true);
    try {
      const result = await engineClient.renameDirectorConversation(conversationId, next);
      setConversationTitle(result.conversation.title);
      setStatusMessage(result.providerWarning || 'Conversation renamed.');
      await refreshArchive(showArchived);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setArchiveBusy(false);
    }
  }, [archiveBusy, chatBusy, conversationId, conversationTitle, refreshArchive, showArchived]);

  const archiveCurrent = useCallback(async () => {
    if (!conversationId || chatBusy || archiveBusy) return;
    setArchiveBusy(true);
    try {
      const result = await engineClient.archiveDirectorConversation(conversationId);
      clearReferenceDrafts();
      setStatusMessage(result.providerWarning || 'Conversation archived.');
      setConversationId(null);
      setConversationTitle('New Director conversation');
      setMessages([welcomeMessage(selectedProvider)]);
      setLastContext(null);
      await refreshArchive(showArchived);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setArchiveBusy(false);
    }
  }, [archiveBusy, chatBusy, clearReferenceDrafts, conversationId, refreshArchive, selectedProvider, showArchived]);

  const restoreConversation = useCallback(async (summary: DirectorConversationSummary) => {
    if (chatBusy || archiveBusy) return;
    setArchiveBusy(true);
    try {
      const result = await engineClient.unarchiveDirectorConversation(summary.id);
      if (conversationId && conversationId !== summary.id) {
        await engineClient.closeDirectorChat(selectedProvider, conversationId).catch(() => undefined);
      }
      const restoredResult = await engineClient.readDirectorConversation(summary.id);
      const document = restoredResult.conversation;
      const active = await engineClient.directorConversations(false, 200);
      clearReferenceDrafts();
      setConversationArchive(active.conversations);
      setShowArchived(false);
      setConversationId(document.id);
      setConversationTitle(document.title);
      setSelectedProvider(document.provider);
      setMessages(document.messages.slice(-MAX_VISIBLE_MESSAGES).map(archivedMessage));
      setLastContext(null);
      setComposer('');
      setPendingText(null);
      setPendingQueuedAttachments([]);
      setStatusMessage(result.providerWarning || `Conversation restored · ${document.turnCount} turns · ${document.runtimeMode}`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setArchiveBusy(false);
    }
  }, [archiveBusy, chatBusy, clearReferenceDrafts, conversationId, selectedProvider]);

  const deleteConversation = useCallback(async (summary: DirectorConversationSummary) => {
    if (chatBusy || archiveBusy) return;
    if (!window.confirm(`Delete “${summary.title}” permanently? This removes the Make & Watch archive and requests provider-thread deletion. Imported project reference Assets remain safe unless you explicitly remove them from the project.`)) return;
    setArchiveBusy(true);
    try {
      const result = await engineClient.deleteDirectorConversation(summary.id);
      if (conversationId === summary.id) {
        clearReferenceDrafts();
        setConversationId(null);
        setConversationTitle('New Director conversation');
        setMessages([welcomeMessage(selectedProvider)]);
        setLastContext(null);
      }
      setStatusMessage(result.providerWarning || 'Conversation deleted permanently.');
      await refreshArchive(showArchived);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setArchiveBusy(false);
    }
  }, [archiveBusy, chatBusy, clearReferenceDrafts, conversationId, refreshArchive, selectedProvider, showArchived]);

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
      <div className="director-chat-rail" aria-label="Open AI Director Room">
        <button className="director-chat-rail__button" onClick={() => setOpen(true)} title="Open Director Room">
          <span className={`director-chat-rail__status ${codexStatus?.chatAvailable ? 'director-chat-rail__status--ready' : ''}`} />
          <MessageSquareText size={19} />
        </button>
        <span>DIRECTOR</span>
        <span>ROOM</span>
      </div>,
      mountTarget,
    );
  }

  const currentModel = modelLabel(selectedStatus);
  const planDisabledReason = !composer.trim()
    ? 'Write an objective first'
    : !selectedStatus?.planningAvailable
      ? `${providerLabel(selectedProvider)} planning is not ready`
      : planBusy || chatBusy || archiveBusy
        ? 'Director is busy'
        : 'Preview a typed Assist plan without applying it';

  const content = (
    <section className="director-chat" aria-label="AI Director Room">
      <header className="director-chat__header">
        <div className="director-chat__identity">
          <span className="director-chat__orb"><WandSparkles size={18} /></span>
          <div>
            <span className="director-chat__eyebrow">DIRECTOR ROOM</span>
            <strong title={conversationTitle}>{conversationTitle}</strong>
            <small>{conversationId ? 'Persistent conversation · durable references · resumable session' : 'Story, cast and visual development in one room'}</small>
          </div>
        </div>
        <div className="director-chat__header-actions">
          {conversationId ? <button onClick={() => void renameConversation()} disabled={chatBusy || archiveBusy} title={chatBusy || archiveBusy ? 'Director is busy' : 'Rename conversation'}><Pencil size={14} /></button> : null}
          {conversationId ? <button onClick={() => void archiveCurrent()} disabled={chatBusy || archiveBusy} title={chatBusy || archiveBusy ? 'Director is busy' : 'Archive conversation'}><Archive size={14} /></button> : null}
          <button onClick={() => setArchiveOpen((current) => !current)} title="Conversation archive"><History size={15} /></button>
          <button onClick={() => void newConversation()} disabled={chatBusy || archiveBusy} title={chatBusy || archiveBusy ? 'Director is busy' : 'New Director conversation'}><Plus size={16} /></button>
          <button onClick={() => setOpen(false)} title="Collapse Director Room"><ChevronLeft size={17} /></button>
        </div>
      </header>

      <div className={`director-conversations ${archiveOpen ? 'director-conversations--open' : ''}`} aria-hidden={!archiveOpen}>
        <div className="director-conversations__toolbar">
          <div className="director-conversations__tabs">
            <button className={!showArchived ? 'is-active' : ''} onClick={() => setShowArchived(false)} disabled={archiveBusy}>Recent</button>
            <button className={showArchived ? 'is-active' : ''} onClick={() => setShowArchived(true)} disabled={archiveBusy}>Archived</button>
          </div>
          <button className="director-conversations__refresh" onClick={() => void refreshArchive(showArchived)} disabled={archiveBusy} title={archiveBusy ? 'Archive is loading' : 'Refresh conversations'}>
            <RefreshCw size={13} className={archiveBusy ? 'spin' : ''} />
          </button>
        </div>
        <label className="director-conversations__search">
          <Search size={13} />
          <input value={archiveSearch} onChange={(event) => setArchiveSearch(event.target.value.slice(0, 120))} placeholder="Search conversations" />
        </label>
        <div className="director-conversations__list">
          {filteredArchive.length === 0 ? (
            <div className="director-conversations__empty">{archiveBusy ? 'Loading conversations…' : showArchived ? 'No archived conversations' : 'No saved conversations yet'}</div>
          ) : filteredArchive.map((item) => (
            <div key={item.id} className={`director-conversation ${conversationId === item.id ? 'director-conversation--active' : ''}`}>
              <button className="director-conversation__open" onClick={() => void loadConversation(item)} disabled={chatBusy || archiveBusy || Boolean(item.archivedAt)} title={item.archivedAt ? 'Restore this conversation before opening it' : 'Open conversation'}>
                <span className="director-conversation__title">{item.title}</span>
                <span className="director-conversation__preview">{item.preview || 'No completed messages yet'}</span>
                <span className="director-conversation__meta">{providerLabel(item.provider)} · {item.turnCount} turns{item.attachmentCount ? ` · ${item.attachmentCount} refs` : ''} · {relativeUpdatedAt(item.updatedAt)}</span>
              </button>
              <div className="director-conversation__actions">
                {item.archivedAt ? (
                  <button onClick={() => void restoreConversation(item)} disabled={archiveBusy || chatBusy} title="Restore conversation"><RotateCcw size={12} /></button>
                ) : null}
                <button className="danger" onClick={() => void deleteConversation(item)} disabled={archiveBusy || chatBusy} title="Delete conversation permanently"><Trash2 size={12} /></button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="director-chat__readiness">
        <div className={`director-chat__live-dot ${selectedStatus?.chatAvailable ? 'director-chat__live-dot--ready' : ''}`} />
        <div>
          <strong>{providerLabel(selectedProvider)} {currentModel ? <em className="director-chat__model-pill">{currentModel}</em> : null}</strong>
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
                disabled={chatBusy || providerBusy || archiveBusy}
                title={chatBusy || providerBusy || archiveBusy ? 'Director is busy' : `Use ${providerLabel(providerId)}`}
              >
                <span className="director-chat__provider-icon">
                  {connecting ? <LoaderCircle size={15} className="spin" /> : ready ? <Check size={15} /> : <KeyRound size={15} />}
                </span>
                <span>
                  <strong>{providerLabel(providerId)}</strong>
                  <small>{status?.model ? `${modelLabel(status)} · ` : ''}{statusLabel(status)}</small>
                </span>
              </button>
            );
          })}
        </div>

        <div className="director-chat__connection">
          {selectedStatus?.loginAvailable && !selectedStatus.authenticated ? (
            <button className="director-chat__connect" onClick={() => void connect(selectedProvider)} disabled={providerBusy || chatBusy || archiveBusy}>
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
          <article key={message.id} className={`director-chat__message director-chat__message--${message.role} ${message.failed ? 'director-chat__message--failed' : ''}`}>
            <div className="director-chat__message-label">
              {message.role === 'assistant' ? <Bot size={14} /> : message.role === 'user' ? <MessageSquareText size={14} /> : <Sparkles size={14} />}
              <span>{message.role === 'assistant' ? providerLabel(selectedProvider) : message.role === 'user' ? 'You' : 'Studio'}</span>
            </div>
            <MessageAttachments attachments={message.attachments ?? []} />
            <p>{message.text}</p>
            {message.meta ? <small>{message.meta}</small> : null}
          </article>
        ))}

        {pendingText ? (
          <article className="director-chat__message director-chat__message--user director-chat__message--pending">
            <div className="director-chat__message-label"><MessageSquareText size={14} /><span>You · queued</span></div>
            <MessageAttachments attachments={pendingQueuedAttachments} />
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

      <footer
        className={`director-chat__composer ${dragActive ? 'director-chat__composer--dragging' : ''}`}
        onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
        onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setDragActive(true); }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          void addReferenceFiles(Array.from(event.dataTransfer.files));
        }}
      >
        {lastContext ? (
          <div className="director-chat__context-line">
            <span>~{lastContext.estimatedTokens.toLocaleString()} ctx</span>
            <span>{lastContext.nodeCountIncluded} nodes</span>
            <span>{lastContext.dependencyCountIncluded} edges</span>
            {lastContext.attachmentCount ? <span>{lastContext.attachmentCount} refs</span> : null}
          </div>
        ) : null}

        {referenceDrafts.length ? (
          <div className="director-reference-tray" aria-label="Reference images for this message">
            {referenceDrafts.map((draft) => (
              <div key={draft.id} className={`director-reference-card director-reference-card--${draft.status}`} title={draft.error || draft.filename}>
                <img src={draft.previewUrl} alt={draft.filename} />
                <span className="director-reference-card__scrim" />
                <span className="director-reference-card__name">{draft.filename}</span>
                {draft.status === 'uploading' ? <span className="director-reference-card__state"><LoaderCircle size={15} className="spin" /></span> : null}
                {draft.status === 'ready' ? <span className="director-reference-card__state director-reference-card__state--ready"><Check size={14} /></span> : null}
                {draft.status === 'error' ? (
                  <button className="director-reference-card__retry" type="button" onClick={() => void retryReferenceDraft(draft)} title="Choose this reference again"><RefreshCw size={13} /></button>
                ) : null}
                <button className="director-reference-card__remove" type="button" onClick={() => removeReferenceDraft(draft.id)} title="Remove reference"><X size={13} /></button>
              </div>
            ))}
            <button
              className="director-reference-add"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={referenceDrafts.length >= directorReferenceClientLimits.maxAttachmentsPerMessage}
              title={referenceDrafts.length >= directorReferenceClientLimits.maxAttachmentsPerMessage ? 'Reference limit reached' : 'Add another reference'}
            >
              <ImagePlus size={17} />
              <span>Add</span>
            </button>
          </div>
        ) : null}

        <div className="director-chat__input-shell">
          <input
            ref={fileInputRef}
            className="director-chat__file-input"
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = '';
              void addReferenceFiles(files);
            }}
          />
          <button
            className="director-chat__attach-button"
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={chatBusy || archiveBusy || referenceDrafts.length >= directorReferenceClientLimits.maxAttachmentsPerMessage}
            title={referenceDrafts.length >= directorReferenceClientLimits.maxAttachmentsPerMessage ? 'Reference limit reached' : 'Attach character or visual reference'}
          >
            <ImagePlus size={18} />
          </button>
          <textarea
            value={composer}
            onChange={(event) => setComposer(event.target.value.slice(0, 6000))}
            onPaste={(event) => {
              const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith('image/'));
              if (!imageFiles.length) return;
              event.preventDefault();
              void addReferenceFiles(imageFiles);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                if (canSend) void sendChat();
              }
            }}
            placeholder="Describe a character, paste a reference, or talk through your scene…"
            rows={3}
            aria-label="Message the AI Director"
          />
          <button
            className="director-chat__send-button"
            onClick={() => void sendChat()}
            disabled={!canSend}
            title={referenceUploadActive ? 'Wait for reference upload to finish' : !composer.trim() && !readyReferences.length ? 'Write a message or attach a reference' : 'Send to Director'}
          >
            {chatBusy || referenceUploadActive ? <LoaderCircle size={17} className="spin" /> : <Send size={17} />}
          </button>
        </div>
        {dragActive ? <div className="director-chat__drop-hint"><ImagePlus size={18} /> Drop visual references here</div> : null}
        <div className="director-chat__composer-actions">
          <span>
            {referenceUploadActive
              ? 'Archiving reference securely…'
              : referenceUploadErrors
                ? 'A reference failed to archive · remove or retry it'
                : selectedStatus?.chatAvailable
                  ? 'Enter to send · Shift+Enter newline · paste or drop images'
                  : 'Type now · first Send prepares Codex automatically'}
          </span>
          <button
            className="director-chat__plan-button"
            onClick={() => void createAssistPlan()}
            disabled={planBusy || chatBusy || archiveBusy || !composer.trim() || !selectedStatus?.planningAvailable}
            title={planDisabledReason}
          >
            {planBusy ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />} Preview plan
          </button>
        </div>
      </footer>
    </section>
  );

  return createPortal(content, mountTarget);
}
