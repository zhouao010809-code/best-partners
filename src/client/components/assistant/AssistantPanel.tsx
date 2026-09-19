import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowRight, ArrowUp, BookOpen, ChevronDown, ChevronLeft, History, LoaderCircle, Maximize2, Minimize2, Pin, Plus, RefreshCw, Search, Square, X } from 'lucide-react';
import { Link, useLocation } from 'react-router-dom';
import type { ApiClientResult, ReadConsoleApi } from '../../api/client.js';
import type { AssistantConversation, AssistantProvider, AssistantSend, AssistantPlanAction } from '../../../shared/api/assistant.js';
import type { Attachment, AttachmentSelection } from '../../../shared/api/attachments.js';
import type { AssistantDraft } from '../../../shared/api/assistant-drafts.js';
import type { SkillMatchCandidate } from '../../../shared/api/skills.js';
import { AttachmentPicker } from './AttachmentPicker.js';
import { ContextUsage } from './ContextUsage.js';
import { AssistantContinuation } from './AssistantContinuation.js';
import { useAssistantDrafts } from './useAssistantDrafts.js';
import { AssistantMessageView } from './AssistantMessageView.js';
import { SkillRecommendationCard } from './SkillRecommendationCard.js';
import { ASSISTANT_INTENT_EVENT, ASSISTANT_REVIEW_EVENT, type AssistantIntent } from './assistantIntent.js';
import '../../styles/assistant.css';
import '../../styles/ai-glow.css';

type HistoryItem = Omit<AssistantConversation, 'messages'>;
type SkillRecommendation =
  | { status: 'matching'; payload: AssistantSend; epoch: number }
  | { status: 'ready'; payload: AssistantSend; candidates: SkillMatchCandidate[]; selectedIndex: number; epoch: number }
  | { status: 'error' | 'unavailable'; payload: AssistantSend; message: string; epoch: number }
  | { status: 'invalidated'; message: string; epoch: number };
const titleFromPath = (path: string) => path.split('/').at(-1)?.replace(/\.md$/iu, '') ?? path;
const errorMessage = <T,>(result: ApiClientResult<T>, fallback: string): string => !result.ok && 'state' in result ? result.state.message ?? fallback : fallback;
const effortName = (value: string) => ({ low: '轻量', medium: '标准', high: '深入', xhigh: '更深入', max: '最高', ultra: 'Ultra', none: '关闭', minimal: '最低' })[value] ?? value;

export function AssistantEyes({ active = false }: { active?: boolean }) {
  return <span className={`assistant-eyes${active ? ' assistant-eyes--working' : ''}`} aria-hidden="true"><i /><i /></span>;
}

export function AssistantToggle({ open, running, onClick }: { open: boolean; running: boolean; onClick: () => void }) {
  return <button id="assistant-toggle" type="button" className={`assistant-toggle ai-glow-control${open ? ' assistant-toggle--active' : ''}`} data-ai-active={running || undefined} aria-label={open ? '收起问问 AI' : '打开问问 AI'} aria-expanded={open} aria-controls="assistant-panel" title={running ? '问问正在处理，点击查看' : '问问 AI'} onClick={onClick}><AssistantEyes active={running} /><span>问问</span></button>;
}

export interface AssistantPanelProps {
  api: ReadConsoleApi;
  open: boolean;
  onClose: () => void;
  width: number;
  onWidthChange: (width: number) => void;
  onRunningChange: (running: boolean) => void;
  dataRevision?: number;
}

export function AssistantPanel({ api, open, onClose, width, onWidthChange, onRunningChange, dataRevision = 0 }: AssistantPanelProps) {
  const service = api.assistant;
  const location = useLocation();
  const query = new URLSearchParams(location.search);
  const explicitPath = ['/library', '/knowledge'].includes(location.pathname) ? query.get('path') : location.pathname === '/queue' || location.pathname.startsWith('/extractions/') ? query.get('materialPath') : null;
  const [extractionPath, setExtractionPath] = useState<string>();
  const currentPath = explicitPath || extractionPath;
  const [providers, setProviders] = useState<AssistantProvider[]>([]);
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [effort, setEffort] = useState('');
  const draftStore = useAssistantDrafts(api.assistantDrafts);
  const scope = draftStore.current.scope;
  const setScope = (value: 'brain' | 'current') => draftStore.update({ scope: value });
  const pinnedPath = draftStore.current.contextPath;
  const setPinnedPath = (value: string | undefined) => { draftStore.update({ contextPath: value }); setFollowPageContext(!value); };
  const [followPageContext, setFollowPageContext] = useState(!api.assistantDrafts);
  const contextPath = followPageContext ? currentPath : pinnedPath;
  const hasPinnedContext = Boolean(pinnedPath && !followPageContext);
  const [attachmentRecords, setAttachmentRecords] = useState<Attachment[]>([]);
  const [showContinuation, setShowContinuation] = useState(false);
  const [restoringConversation, setRestoringConversation] = useState(false);
  const restoredDraft = useRef(false);
  const [expanded, setExpanded] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [historyQuery, setHistoryQuery] = useState('');
  const [historyTerm, setHistoryTerm] = useState('');
  const [historyResults, setHistoryResults] = useState<HistoryItem[]>([]);
  const [historyNextCursor, setHistoryNextCursor] = useState<string>();
  const [historyMoreError, setHistoryMoreError] = useState('');
  const historyRequest = useRef<AbortController | undefined>(undefined);
  const historySequence = useRef(0);
  const loadedHistoryTerm = useRef('');
  const [hasNewContent, setHasNewContent] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const localStartedAt = useRef(Date.now());
  const savedScroll = useRef(0);
  const [conversation, setConversation] = useState<AssistantConversation>();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [providerLoading, setProviderLoading] = useState(false);
  const [providerError, setProviderError] = useState('');
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState<{ id: string; message: string }>();
  const [pollRevision, setPollRevision] = useState(0);
  const interactionEpoch = useRef(0);
  const [skillRecommendation, setSkillRecommendation] = useState<SkillRecommendation>();
  const skillMatchAbort = useRef<AbortController | undefined>(undefined);
  const draft = draftStore.current.text;
  const setDraft = (value: string | ((current: string) => string)) => {
    const next = typeof value === 'function' ? value(draftStore.currentRef.current.text) : value;
    if (skillRecommendation && skillRecommendation.status !== 'invalidated' && next !== skillRecommendation.payload.message) {
      skillMatchAbort.current?.abort();
      interactionEpoch.current += 1;
      setSkillRecommendation({ status: 'invalidated', message: '推荐已失效，请重新发送问题。', epoch: interactionEpoch.current });
    }
    draftStore.update({ text: next });
  };
  const draftRef = useRef(draft); draftRef.current = draft;
  const [queuedIntent, setQueuedIntent] = useState<AssistantIntent>();
  const [pending, setPending] = useState(false);
  const [sending, setSending] = useState(false);
  const [failedSend, setFailedSend] = useState<AssistantSend>();
  const [login, setLogin] = useState<{ authUrl?: string | undefined; message: string }>();
  const [loginPending, setLoginPending] = useState(false);
  const pendingRef = useRef(false);
  const conversationRef = useRef(conversation); conversationRef.current = conversation;
  const initialHistory = useRef(false);
  const selectionRef = useRef(providerId); selectionRef.current = providerId;
  const providerEpoch = useRef(0);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const timeline = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const isRunning = conversation?.status === 'running';
  const locked = isRunning || pending || !draftStore.ready || restoringConversation;
  const attachmentsReady = draftStore.current.attachments.every(item => attachmentRecords.some(record => record.id === item.id && record.status === 'ready'));
  const missingConversation = Boolean(draftStore.current.conversationId && draftStore.current.conversationId !== conversation?.id);
  const provider = providers.find(item => item.id === providerId);
  const model = provider?.models.find(item => item.id === modelId);

  function chooseProvider(item: AssistantProvider) {
    selectionRef.current = item.id;
    setProviderId(item.id);
    const nextModelId = item.defaultModel ?? item.models.find(candidate => candidate.recommended)?.id ?? item.models[0]?.id ?? '';
    const nextModel = item.models.find(candidate => candidate.id === nextModelId);
    setModelId(nextModelId);
    setEffort(nextModel?.reasoningEfforts.includes(item.defaultEffort ?? '') ? item.defaultEffort! : nextModel?.reasoningEfforts.at(-1) ?? '');
    setLogin(undefined);
  }

  const receive = useCallback((value: AssistantConversation) => {
    conversationRef.current = value; setConversation(value);
    if (value.status !== 'running') setPollError(undefined);
    setHistory(items => [value, ...items.filter(item => item.id !== value.id)]);
  }, []);

  const loadProviders = useCallback(async () => {
    if (!service) return;
    const epoch = ++providerEpoch.current;
    setProviderLoading(true); setProviderError('');
    try {
      const result = await service.providers();
      if (epoch !== providerEpoch.current) return;
      if (!result.ok) { setProviderError(errorMessage(result, '未能读取 AI 服务，请重试。')); return; }
      setProviders(result.value.providers);
      if (!selectionRef.current) {
        const first = result.value.providers.find(item => item.status === 'ready') ?? result.value.providers[0];
        if (first) chooseProvider(first);
      }
    } catch { if (epoch === providerEpoch.current) setProviderError('无法读取 AI 服务，请检查本地连接后重试。'); }
    finally { if (epoch === providerEpoch.current) setProviderLoading(false); }
  }, [service]);

  const loadHistory = useCallback(async (cursor?: string) => {
    if (!service) return;
    const epoch = interactionEpoch.current; const sequence = ++historySequence.current;
    historyRequest.current?.abort(); const controller = new AbortController(); historyRequest.current = controller;
    const current = () => !controller.signal.aborted && sequence === historySequence.current;
    setHistoryLoading(true); setHistoryError(''); setHistoryMoreError('');
    if (!cursor && loadedHistoryTerm.current !== historyTerm) { setHistoryResults([]); setHistoryNextCursor(undefined); }
    try {
      const result = await service.history(controller.signal, { search: historyTerm, limit: 50, ...(cursor ? { cursor } : {}) });
      if (!current()) return;
      if (!result.ok) { (cursor ? setHistoryMoreError : setHistoryError)(errorMessage(result, '未能读取对话记录。')); return; }
      if (cursor && result.value.nextCursor === cursor) { setHistoryMoreError('对话列表位置未更新，请重新读取。'); return; }
      loadedHistoryTerm.current = historyTerm;
      setHistoryResults(items => cursor ? [...new Map([...items, ...result.value.conversations].map(item => [item.id, item])).values()] : result.value.conversations);
      setHistoryNextCursor(result.value.nextCursor);
      if (!historyTerm && !cursor) setHistory(result.value.conversations);
      if (!api.assistantDrafts && !initialHistory.current && !historyTerm && !cursor) {
        initialHistory.current = true;
        const active = result.value.conversations.find(item => item.status === 'running');
        if (active && epoch === interactionEpoch.current && !conversationRef.current && !pendingRef.current && !draftRef.current.trim()) {
          const resumed = await service.get(active.id, controller.signal);
          if (!current() || epoch !== interactionEpoch.current || conversationRef.current || pendingRef.current || draftRef.current.trim()) return;
          if (resumed.ok) { selectionRef.current = resumed.value.providerId; receive(resumed.value); setPinnedPath(resumed.value.contextPath); setScope(resumed.value.scope); setProviderId(resumed.value.providerId); setModelId(resumed.value.model); setEffort(resumed.value.effort ?? ''); }
          else setHistoryError(errorMessage(resumed, '未能恢复进行中的对话。'));
        }
      }
    } catch { if (current()) (cursor ? setHistoryMoreError : setHistoryError)('无法读取对话记录，请重试。'); }
    finally { if (current()) setHistoryLoading(false); }
  }, [historyTerm, receive, service, api.assistantDrafts]);

  async function restoreConversation(id: string) {
    if (!service) return;
    const epoch = interactionEpoch.current; setRestoringConversation(true); setError('');
    try {
      const result = await service.get(id);
      if (epoch !== interactionEpoch.current || draftStore.currentRef.current.conversationId !== id) return;
      if (result.ok) { selectionRef.current = result.value.providerId; receive(result.value); setProviderId(result.value.providerId); setModelId(result.value.model); setEffort(result.value.effort ?? ''); }
      else setError(errorMessage(result, '未能恢复草稿所属的对话，请重试。'));
    } catch { if (epoch === interactionEpoch.current) setError('未能恢复草稿所属的对话，请重试。'); }
    finally { setRestoringConversation(false); }
  }
  useEffect(() => {
    if (!draftStore.ready || restoredDraft.current) return;
    restoredDraft.current = true;
    const id = draftStore.currentRef.current.conversationId;
    if (id) void restoreConversation(id);
  }, [draftStore.ready]);

  useEffect(() => { const timer = setTimeout(() => setHistoryTerm(historyQuery.trim()), 250); return () => clearTimeout(timer); }, [historyQuery]);
  useEffect(() => { if (open) void loadProviders(); }, [open, loadProviders]);
  useEffect(() => { if (open) void loadHistory(); return () => historyRequest.current?.abort(); }, [open, loadHistory]);
  useEffect(() => { onRunningChange(Boolean(isRunning || sending)); }, [isRunning, sending, onRunningChange]);
  useEffect(() => {
    if (!open || !service) return;
    const controller = new AbortController();
    let requestSequence = 0;
    const refresh = async () => {
      const current = conversationRef.current;
      if (!current || current.status === 'running' || pendingRef.current) return;
      const id = current.id; const epoch = interactionEpoch.current; const request = ++requestSequence;
      try { const result = await service.get(id, controller.signal); if (!controller.signal.aborted && request === requestSequence && epoch === interactionEpoch.current && !pendingRef.current && conversationRef.current?.status !== 'running' && conversationRef.current?.id === id && result.ok) receive(result.value); } catch { /* Keep the last confirmed conversation; active task errors use the polling notice. */ }
    };
    // Returning from review refreshes task cards from the real run and receipt.
    void refresh(); window.addEventListener('focus', refresh); window.addEventListener(ASSISTANT_REVIEW_EVENT, refresh);
    return () => { controller.abort(); window.removeEventListener('focus', refresh); window.removeEventListener(ASSISTANT_REVIEW_EVENT, refresh); };
  }, [open, service, location.pathname, dataRevision, receive]);

  useEffect(() => {
    if (!open) return;
    textArea.current?.focus();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.isComposing && !document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) { event.preventDefault(); event.stopPropagation(); if (expanded) { setExpanded(false); return; } clearSkillRecommendation(); onClose(); document.getElementById('assistant-toggle')?.focus(); } };
    window.addEventListener('keydown', escape, true);
    return () => window.removeEventListener('keydown', escape, true);
  }, [open, onClose, expanded]);
  useEffect(() => { if (!open) clearSkillRecommendation(); }, [open]);
  useEffect(() => {
    setExtractionPath(undefined);
    if (!open || explicitPath || !api.extraction || !/^\/extractions\/[^/]+$/u.test(location.pathname)) return;
    const id = location.pathname.split('/').at(-1)!;
    if (id === 'new') return;
    const controller = new AbortController();
    void api.extraction.get(id, controller.signal).then(result => { if (!controller.signal.aborted && result.ok) setExtractionPath(result.value.materialPath); }).catch(() => undefined);
    return () => controller.abort();
  }, [api.extraction, explicitPath, location.pathname, open]);
  useEffect(() => { if (draftStore.ready && !contextPath && !draftStore.current.attachments.length) setScope('brain'); }, [contextPath, draftStore.ready, draftStore.current.attachments.length]);
  useEffect(() => {
    if (!service || !conversation?.id || !isRunning) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setPollError(undefined);
    const id = conversation.id;
    const current = () => !controller.signal.aborted && conversationRef.current?.id === id && conversationRef.current.status === 'running';
    const refresh = async () => {
      try {
        const result = await service.get(conversation.id, controller.signal);
        if (!current()) return;
        if (!result.ok) { setPollError({ id, message: errorMessage(result, '进度暂时无法读取，任务可能仍在运行。') }); return; }
        receive(result.value);
        if (result.value.status === 'running') timer = setTimeout(() => void refresh(), 500);
      } catch { if (current()) setPollError({ id, message: '进度连接中断，任务可能仍在运行。' }); }
    };
    timer = setTimeout(() => void refresh(), 500);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [conversation?.id, isRunning, pollRevision, receive, service]);
  useEffect(() => {
    if (!open || !timeline.current) return;
    if (followOutput.current) { timeline.current.scrollTo?.({ top: timeline.current.scrollHeight }); setHasNewContent(false); }
    else { timeline.current.scrollTop = savedScroll.current; if (isRunning) setHasNewContent(true); }
  }, [conversation, open, isRunning]);
  useEffect(() => {
    if (!open || !textArea.current) return;
    textArea.current.style.height = 'auto';
    textArea.current.style.height = `${Math.min(200, Math.max(64, textArea.current.scrollHeight))}px`;
  }, [draft, open, expanded]);
  useEffect(() => {
    if (!isRunning) return;
    const started = conversation?.messages.filter(item => item.role === 'assistant').at(-1)?.startedAt;
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - (started ? Date.parse(started) : localStartedAt.current)) / 1000)));
    tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, [isRunning, conversation?.id]);
  async function loadIntent(intent: AssistantIntent) {
    if (intent.attachments?.length && !await startNewConversation(intent.prompt.slice(0, 16000), intent.attachments)) return;
    interactionEpoch.current += 1;
    clearSkillRecommendation();
    setDraft(intent.prompt.slice(0, 16000)); setShowHistory(false); setQueuedIntent(undefined);
    if (intent.scope === 'brain') { draftStore.update({ scope: 'brain', contextPath: undefined }); setFollowPageContext(false); }
    if (intent.contextPath) { setPinnedPath(intent.contextPath); setScope('current'); }
    textArea.current?.focus();
  }
  const loadIntentRef = useRef(loadIntent); loadIntentRef.current = loadIntent;
  const draftReadyRef = useRef(draftStore.ready); draftReadyRef.current = draftStore.ready;
  const restoringRef = useRef(restoringConversation); restoringRef.current = restoringConversation;
  useEffect(() => {
    const applyIntent = (event: Event) => {
      const intent = (event as CustomEvent<AssistantIntent>).detail;
      if (!intent?.prompt) return;
      setShowHistory(false);
      if (!draftReadyRef.current || restoringRef.current || conversationRef.current?.status === 'running' || pendingRef.current || draftRef.current.trim() || draftStore.currentRef.current.attachments.length || Boolean(intent.attachments?.length && conversationRef.current?.messages.length)) setQueuedIntent(intent);
      else void loadIntentRef.current(intent);
    };
    window.addEventListener(ASSISTANT_INTENT_EVENT, applyIntent);
    return () => window.removeEventListener(ASSISTANT_INTENT_EVENT, applyIntent);
  }, []);

  function clearSkillRecommendation(): void {
    skillMatchAbort.current?.abort();
    skillMatchAbort.current = undefined;
    setSkillRecommendation(undefined);
  }

  function buildSendPayload(): AssistantSend | undefined {
    if (!service || pendingRef.current || isRunning || !draftStore.ready || restoringConversation || missingConversation || !attachmentsReady) return undefined;
    if (!draft.trim() || !provider || provider.status !== 'ready' || !model) return undefined;
    return {
      ...(conversation ? { conversationId: conversation.id } : {}), clientRequestId: crypto.randomUUID(), message: draft.trim(), providerId, model: modelId,
      ...(effort ? { effort } : {}), scope, ...(contextPath ? { contextPath } : {}), ...(draftStore.current.attachments.length ? { attachments: draftStore.current.attachments } : {})
    };
  }

  async function dispatchSend(payload: AssistantSend): Promise<void> {
    if (!service || pendingRef.current || isRunning || !draftStore.ready || restoringConversation || missingConversation || !attachmentsReady) return;
    clearSkillRecommendation();
    interactionEpoch.current += 1; localStartedAt.current = Date.now(); setElapsed(0);
    pendingRef.current = true; setPending(true); setSending(true); setError(''); setFailedSend(undefined); followOutput.current = true;
    try {
      draftStore.update({ contextPath });
      if (!await draftStore.flush()) return;
      const result = await service.send(payload);
      if (result.ok) { receive(result.value); draftStore.update({ conversationId: result.value.id, text: draftStore.currentRef.current.text.trim() === payload.message ? '' : draftStore.currentRef.current.text }); await draftStore.flush(); }
      else { setError(errorMessage(result, '未能确认消息已发送，请重试。')); setFailedSend(payload); }
    } catch { setError('连接中断，尚未确认发送结果。可重试确认这条消息。'); setFailedSend(payload); }
    finally { pendingRef.current = false; setPending(false); setSending(false); }
  }

  async function matchSkill(payload: AssistantSend): Promise<void> {
    const matcher = api.skills?.match;
    if (!matcher) {
      setSkillRecommendation({ status: 'unavailable', payload, message: '本地 Skill 匹配服务暂不可用。', epoch: interactionEpoch.current });
      return;
    }
    skillMatchAbort.current?.abort();
    const controller = new AbortController();
    skillMatchAbort.current = controller;
    const epoch = ++interactionEpoch.current;
    setSkillRecommendation({ status: 'matching', payload, epoch });
    setError('');
    try {
      const result = await matcher(payload.message, controller.signal);
      if (controller.signal.aborted || epoch !== interactionEpoch.current) return;
      if (!result.ok) {
        setSkillRecommendation({ status: 'error', payload, message: errorMessage(result, '匹配服务暂不可用，请选择重试或继续普通问问。'), epoch });
        return;
      }
      if (result.value.candidates.length === 0) {
        clearSkillRecommendation();
        await dispatchSend(payload);
        return;
      }
      setSkillRecommendation({ status: 'ready', payload, candidates: result.value.candidates, selectedIndex: 0, epoch });
    } catch {
      if (!controller.signal.aborted && epoch === interactionEpoch.current) {
        setSkillRecommendation({ status: 'error', payload, message: '匹配服务暂不可用，请选择重试或继续普通问问。', epoch });
      }
    } finally {
      if (skillMatchAbort.current === controller) skillMatchAbort.current = undefined;
    }
  }

  async function send(input?: AssistantSend): Promise<void> {
    if (input) {
      await dispatchSend(input);
      return;
    }
    if (skillRecommendation && skillRecommendation.status !== 'invalidated') return;
    if (skillRecommendation?.status === 'invalidated') clearSkillRecommendation();
    const payload = buildSendPayload();
    if (!payload) return;
    await matchSkill(payload);
  }

  async function useRecommendedSkill(): Promise<void> {
    if (!skillRecommendation || skillRecommendation.status !== 'ready') return;
    const selected = skillRecommendation.candidates[skillRecommendation.selectedIndex];
    if (!selected) return;
    await dispatchSend({ ...skillRecommendation.payload, skillId: selected.id, skillRevision: selected.revision });
  }

  async function skipRecommendedSkill(): Promise<void> {
    if (!skillRecommendation || (skillRecommendation.status !== 'ready' && skillRecommendation.status !== 'error' && skillRecommendation.status !== 'unavailable')) return;
    await dispatchSend(skillRecommendation.payload);
  }

  async function retrySkillMatch(): Promise<void> {
    if (!skillRecommendation) return;
    if (skillRecommendation.status === 'invalidated') {
      const payload = buildSendPayload();
      if (payload) await matchSkill(payload);
      return;
    }
    if (skillRecommendation.status === 'matching' || skillRecommendation.status === 'ready') return;
    await matchSkill(skillRecommendation.payload);
  }

  function selectSkillCandidate(index: number): void {
    setSkillRecommendation(current => current?.status === 'ready' ? { ...current, selectedIndex: index } : current);
  }

  async function stop() {
    if (!service || !conversation || pendingRef.current) return;
    pendingRef.current = true; setPending(true); setError('');
    try { const result = await service.stop(conversation.id); if (result.ok) receive(result.value); else setError(errorMessage(result, '停止请求未完成，请重试。')); }
    catch { setError('停止请求未送达，请重试。'); }
    finally { pendingRef.current = false; setPending(false); }
  }

  async function confirmAction(action: AssistantPlanAction): Promise<void> {
    if (!service) throw new Error('当前本地服务尚未启用问问。');
    const result = await service.confirmAction(action.id, crypto.randomUUID());
    if (result.ok) { receive(result.value); return; }
    throw new Error(errorMessage(result, '确认归档未完成，请重试。'));
  }

  async function cancelAction(action: AssistantPlanAction): Promise<void> {
    if (!service) throw new Error('当前本地服务尚未启用问问。');
    const result = await service.cancelAction(action.id, crypto.randomUUID());
    if (result.ok) { receive(result.value); return; }
    throw new Error(errorMessage(result, '取消归档未完成，请重试。'));
  }

  function regenerateAction(action: AssistantPlanAction): void {
    void startNewConversation('请重新生成这个附件的归档计划。', [{ id: action.attachmentId }]);
  }

  async function openConversation(item: HistoryItem) {
    if (!service || locked) return;
    interactionEpoch.current += 1;
    clearSkillRecommendation();
    pendingRef.current = true; setPending(true); setError('');
    try {
      const result = await service.get(item.id);
      if (!result.ok) { setHistoryError(errorMessage(result, '未能打开这段对话。')); return; }
      if (!await draftStore.forConversation(result.value)) return;
      selectionRef.current = result.value.providerId; receive(result.value); setProviderId(result.value.providerId); setModelId(result.value.model); setEffort(result.value.effort ?? '');
      setFollowPageContext(false); setShowHistory(false); setFailedSend(undefined); followOutput.current = true;
    } catch { setHistoryError('未能打开这段对话，请重试。'); }
    finally { pendingRef.current = false; setPending(false); }
  }

  async function startNewConversation(text = '', attachments: AttachmentSelection[] = []): Promise<boolean> {
    if (pendingRef.current || isRunning || !draftStore.ready) return false;
    pendingRef.current = true; setPending(true); interactionEpoch.current += 1; clearSkillRecommendation();
    try {
      if (!await draftStore.newDraft(text, attachments)) return false;
      conversationRef.current = undefined; setConversation(undefined); setPollError(undefined); setFollowPageContext(false);
      setError(''); setFailedSend(undefined); setShowHistory(false); setShowContinuation(false); setAttachmentRecords([]); textArea.current?.focus(); return true;
    } finally { pendingRef.current = false; setPending(false); }
  }
  async function openDraft(item: AssistantDraft) {
    if (locked) return;
    interactionEpoch.current += 1; clearSkillRecommendation(); pendingRef.current = true; setPending(true);
    try {
      if (!await draftStore.select(item)) return;
      conversationRef.current = undefined; setConversation(undefined); setPollError(undefined); setFollowPageContext(false); setShowHistory(false); setFailedSend(undefined); setError('');
      if (item.conversationId) await restoreConversation(item.conversationId);
    } finally { pendingRef.current = false; setPending(false); }
  }

  async function startLogin() {
    if (!service || loginPending) return;
    setLoginPending(true); setError('');
    try {
      const result = await service.login(providerId);
      if (result.ok) {
        setLogin(result.value);
        if (result.value.authUrl && window.xiaozhaoDesktop?.openAssistantLogin) await window.xiaozhaoDesktop.openAssistantLogin(result.value.authUrl);
      } else setError(errorMessage(result, '未能开始登录，请重试。'));
    }
    catch { setError('无法开始登录，请重试。'); }
    finally { setLoginPending(false); }
  }

  function resize(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  if (!open) return null;
  const lastAssistant = conversation?.messages.filter(item => item.role === 'assistant').at(-1);
  const selectedAttachmentIds = new Set(draftStore.current.attachments.map(item => item.id));
  // Refresh durable file metadata at task/receipt transitions, never for text chunks.
  const attachmentRefreshKey = JSON.stringify([conversation?.id, conversation?.status,
    conversation?.messages.flatMap(message => message.actions.flatMap(action => action.type === 'archive' && selectedAttachmentIds.has(action.attachmentId)
      ? [[action.attachmentId, action.operationId, action.status, action.indexed]] : []))]);
  const safeAuthUrl = login?.authUrl && /^https:\/\//iu.test(login.authUrl) ? login.authUrl : undefined;
  return <aside id="assistant-panel" className={`assistant-panel assistant-panel--width-${width}${expanded ? ' assistant-panel--expanded' : ''}`} data-ai-active={isRunning || sending || undefined} aria-label="问问 AI">
    <div className="assistant-panel__resize" role="separator" aria-label="调整问问面板宽度" aria-orientation="vertical" aria-valuemin={360} aria-valuemax={600} aria-valuenow={width} tabIndex={0} onPointerDown={resize} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) onWidthChange(Math.min(600, Math.max(360, window.innerWidth - event.clientX))); }} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onWidthChange(Math.min(600, Math.max(360, width + (event.key === 'ArrowLeft' ? 80 : -80)))); } }} />
    <header className="assistant-panel__header"><div><AssistantEyes active={Boolean(isRunning)} /><h2>问问</h2><span className="assistant-panel__caption">你的大脑助手</span></div><div className="assistant-panel__tools">
      <button type="button" className="assistant-icon-button" aria-label="历史对话" title="历史对话" aria-pressed={showHistory} onClick={() => { setShowHistory(value => !value); void loadHistory(); }}><History /></button>
      <button type="button" className="assistant-icon-button assistant-new-conversation" aria-label="新对话" title={locked ? '当前回答结束后可新建对话' : '新对话'} disabled={locked} onClick={() => void startNewConversation()}><Plus /><span>新对话</span></button>
      <button type="button" className="assistant-icon-button" aria-label={expanded ? '收起阅读' : '展开阅读'} title={expanded ? '收起阅读' : '展开阅读'} onClick={() => setExpanded(value => !value)}>{expanded ? <Minimize2 /> : <Maximize2 />}</button>
      <button type="button" className="assistant-icon-button" aria-label="关闭问问" title="关闭 · Esc" onClick={() => { clearSkillRecommendation(); onClose(); }}><X /></button>
    </div></header>

    {showHistory && <div className="assistant-history"><div className="assistant-history__heading"><button className="assistant-text-button" onClick={() => setShowHistory(false)}><ChevronLeft />返回对话</button><span>历史对话</span></div>
      <label className="assistant-history__search"><Search size={15} /><input aria-label="搜索历史对话" placeholder="搜索全部话题或关联资料…" maxLength={200} value={historyQuery} onChange={event => setHistoryQuery(event.target.value)} /></label>
      {historyLoading && <p className="assistant-muted" role="status">正在读取对话…</p>}
      {historyError && <div className="assistant-notice" role="alert"><p>{historyError}</p><button onClick={() => void loadHistory()}>重新读取</button></div>}
      {!historyLoading && !historyError && historyResults.length === 0 && <p className="assistant-history__empty">{historyTerm ? '没有找到相关对话，试试其他关键词。' : '这里会留下你和大脑的对话。'}</p>}
      {locked && <p className="assistant-muted">当前回答完成后可切换对话。</p>}
      {draftStore.drafts.some(item => item.text.trim() || item.attachments.length) && <section className="assistant-draft-history" aria-label="未发送的草稿"><strong>未发送的草稿</strong>{draftStore.drafts.filter(item => item.text.trim() || item.attachments.length).map(item => <button type="button" key={item.id} disabled={locked} onClick={() => void openDraft(item)}>{item.text.trim().slice(0, 60) || '附有文件的草稿'}{item.attachments.length ? ` · ${item.attachments.length} 份文件` : ''}{item.id === draftStore.current.id ? ' · 当前' : ''}</button>)}</section>}
      <div className="assistant-history__list">{historyResults.map(item => <button key={item.id} className={item.id === conversation?.id ? 'is-current' : ''} disabled={locked} onClick={() => void openConversation(item)}><strong>{item.title}</strong><span>{new Date(item.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}<i />{item.status === 'running' ? '正在回答' : item.model}</span></button>)}</div>
      {historyMoreError && <div className="assistant-notice" role="alert"><p>{historyMoreError}</p><button disabled={historyLoading} onClick={() => void loadHistory(historyNextCursor)}>重试加载更多</button></div>}
      {historyNextCursor && !historyMoreError && <button type="button" className="assistant-history-more" disabled={historyLoading} onClick={() => void loadHistory(historyNextCursor)}>{historyLoading ? '正在读取…' : '加载更多对话'}</button>}
    </div>}<div className="assistant-chat" hidden={showHistory}>
      <div className="assistant-model-bar"><button type="button" className="assistant-model-summary" aria-label="模型设置" aria-expanded={showModels} onClick={() => setShowModels(value => !value)}>{model?.name || modelId || '连接 AI'}<ChevronDown size={14} /></button><span className={`assistant-provider-status${provider?.status === 'ready' ? ' is-ready' : ''}`}>{providerLoading ? '读取中' : provider?.status === 'ready' ? '已连接' : '待连接'}</span></div>
      <div className="assistant-models" hidden={!showModels}><div className="assistant-models__row">
        <label><span className="visually-hidden">AI 服务</span><select aria-label="AI 服务" value={providerId} disabled={locked || providerLoading} onChange={event => { const next = providers.find(item => item.id === event.target.value); if (next) chooseProvider(next); }}><option value="" disabled>选择 AI 服务</option>{providers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <span className={`assistant-provider-status${provider?.status === 'ready' ? ' is-ready' : ''}`}>{providerLoading ? '读取中' : provider?.status === 'ready' ? '已连接' : provider?.status === 'unconfigured' ? '待连接' : '不可用'}</span>
        <button className="assistant-icon-button" aria-label="刷新 AI 服务" title="刷新 AI 服务" disabled={providerLoading || locked} onClick={() => void loadProviders()}><RefreshCw className={providerLoading ? 'assistant-spin' : ''} /></button>
      </div><div className="assistant-models__selection"><label><span className="visually-hidden">模型</span><select aria-label="模型" value={modelId} disabled={locked || !provider?.models.length} onChange={event => { const next = provider?.models.find(item => item.id === event.target.value); setModelId(event.target.value); setEffort(next?.reasoningEfforts.includes(provider?.defaultEffort ?? '') ? provider!.defaultEffort! : next?.reasoningEfforts.at(-1) ?? ''); }}><option value="" disabled>暂无可用模型</option>{provider?.models.map(item => <option key={item.id} value={item.id}>{item.name}{item.recommended ? ' · 推荐' : ''}</option>)}{modelId && !model && <option value={modelId}>{modelId} · 当前不可用</option>}</select></label>
        {Boolean(model?.reasoningEfforts.length) && <label><span className="visually-hidden">思考强度</span><select aria-label="思考强度" value={effort} disabled={locked} onChange={event => setEffort(event.target.value)}>{model?.reasoningEfforts.map(item => <option key={item} value={item}>{effortName(item)}</option>)}</select></label>}
      </div></div>

      {!service && <div className="assistant-notice" role="alert"><p>当前本地服务尚未启用问问。</p></div>}
      {providerError && <div className="assistant-notice" role="alert"><p>{providerError}</p><button onClick={() => void loadProviders()}>重新读取 AI 服务</button></div>}
      {provider?.status === 'ready' && provider.problem && <div className="assistant-notice" role="status"><p>{provider.problem}</p><button disabled={providerLoading || locked} onClick={() => void loadProviders()}>刷新模型列表</button></div>}
      {provider && provider.status !== 'ready' && <div className="assistant-notice"><p>{provider.problem || '连接模型后，开始和你的大脑对话。'}</p>{provider.id === 'deepseek' ? <Link to="/settings">配置 DeepSeek <ArrowRight /></Link> : <Link to="/settings">打开设置 <ArrowRight /></Link>}</div>}
      {login && <div className="assistant-notice" role="status"><p>{login.message}</p>{safeAuthUrl && (window.xiaozhaoDesktop?.openAssistantLogin ? <button onClick={() => { void window.xiaozhaoDesktop!.openAssistantLogin!(safeAuthUrl).catch(() => setError('未能打开登录页，请重试。')); }}>继续登录 <ArrowRight /></button> : <a href={safeAuthUrl} target="_blank" rel="noopener noreferrer">继续登录 <ArrowRight /></a>)}<button onClick={() => void loadProviders()} disabled={providerLoading}>我已完成登录，刷新状态</button></div>}

      <div ref={timeline} className="assistant-timeline" onScroll={event => { const el = event.currentTarget; savedScroll.current = el.scrollTop; followOutput.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100; if (followOutput.current) setHasNewContent(false); }}>
        {!conversation?.messages.length ? <div className="assistant-welcome"><div className="assistant-welcome__mark"><AssistantEyes /></div><h3>{contextPath ? '这份资料，一起读懂。' : '让收藏，变成你的答案。'}</h3><p>从一个问题开始，把有用的想法留下来。</p>{history.length > 0 && <button type="button" className="assistant-resume" disabled={locked} onClick={() => void openConversation(history[0]!)}>继续上次对话：{history[0]!.title}<ArrowRight size={14} /></button>}<div className="assistant-suggestions">{(contextPath ? ['解释这份资料的核心观点', contextPath.startsWith('02知识库/') ? '用这篇知识拟一个文章提纲' : '把这份资料提炼成知识候选', '举一个具体的应用例子'] : ['找出大脑里关于创作的方法', '搜索关于学习方法的知识', '整理资料时，你能帮我做什么？']).map(text => <button key={text} type="button" onClick={() => { setDraft(text); if (contextPath) setScope('current'); textArea.current?.focus(); }}><span>{text}</span><ArrowRight /></button>)}</div></div> : <div className="assistant-messages">{conversation.messages.map(message => <AssistantMessageView key={message.id} message={message} onFollowUp={text => { setDraft(text); textArea.current?.focus(); }} onConfirmAction={confirmAction} onCancelAction={cancelAction} onRegenerateAction={regenerateAction} />)}</div>}
        {isRunning && <div className="assistant-activity" role="status"><LoaderCircle className="assistant-spin" /><span>{lastAssistant?.activity || '正在思考…'}<small>已用时 {elapsed < 60 ? `${elapsed} 秒` : `${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`}</small></span></div>}
        {Boolean(lastAssistant?.steps?.length) && <details className="assistant-steps"><summary>处理过程 · {lastAssistant!.steps!.filter(step => step.status === 'completed').length} 步已完成</summary><ol>{lastAssistant!.steps!.map(step => <li key={step.id}>{step.label}<span>{step.status === 'completed' ? '已完成' : step.status === 'running' ? '进行中' : step.status === 'stopped' ? '已停止' : '未完成'}</span></li>)}</ol></details>}
        {conversation?.status === 'stopped' && <p className="assistant-run-note" role="status">已停止。你可以继续补充问题。</p>}
        {conversation?.status === 'failed' && <div className="assistant-notice" role="alert"><p>{conversation.problem || '这次回答未完成。'}</p><button disabled={pending} onClick={() => { const last = conversation.messages.filter(item => item.role === 'user').at(-1); if (last) { setDraft(last.text); setError(''); textArea.current?.focus(); } }}>编辑问题后重试</button></div>}
      </div>

      {hasNewContent && <button type="button" className="assistant-new-content" onClick={() => { followOutput.current = true; setHasNewContent(false); timeline.current?.scrollTo?.({ top: timeline.current.scrollHeight, behavior: 'smooth' }); }}>有新内容 · 回到最新回答</button>}
      <div className="assistant-compose-area">
        {queuedIntent && <div className="assistant-queued-intent" role="status"><span>{locked ? '已准备新的提问，当前任务结束后可载入。' : draft.trim() ? '已保留正在编辑的问题，另有一条新提问待载入。' : '有一条新的提问待载入。'}</span><div><button type="button" disabled={locked} onClick={() => loadIntent(queuedIntent)}>载入新提问</button><button type="button" onClick={() => setQueuedIntent(undefined)}>暂不使用</button></div></div>}

        {skillRecommendation?.status === 'matching' && <SkillRecommendationCard state="matching" />}
        {skillRecommendation?.status === 'ready' && <SkillRecommendationCard
          state="ready"
          candidates={skillRecommendation.candidates}
          selectedIndex={skillRecommendation.selectedIndex}
          onSelect={selectSkillCandidate}
          onUse={() => void useRecommendedSkill()}
          onSkip={() => void skipRecommendedSkill()}
        />}
        {(skillRecommendation?.status === 'error' || skillRecommendation?.status === 'unavailable') && <SkillRecommendationCard
          state={skillRecommendation.status}
          message={skillRecommendation.message}
          onRetry={() => void retrySkillMatch()}
          onContinue={() => void skipRecommendedSkill()}
        />}
        {skillRecommendation?.status === 'invalidated' && <SkillRecommendationCard
          state="invalidated"
          message={skillRecommendation.message}
          onRetry={() => void retrySkillMatch()}
        />}
        {isRunning && pollError?.id === conversation?.id && <div className="assistant-notice" role="alert"><p>{pollError.message}</p><button onClick={() => setPollRevision(value => value + 1)}>重新读取进度</button></div>}
        {draftStore.error && <div className="assistant-notice" role="alert"><p>{draftStore.error}</p><button type="button" disabled={draftStore.saving} onClick={() => { void (draftStore.ready ? draftStore.flush() : draftStore.load()); }}>重试草稿保存或恢复</button>{draftStore.conflict && <button type="button" onClick={() => void draftStore.saveAsCopy()}>另存当前草稿</button>}</div>}
        {error && <div className="assistant-notice" role="alert"><p>{error}</p>{missingConversation && <button type="button" disabled={restoringConversation} onClick={() => void restoreConversation(draftStore.current.conversationId!)}>重新打开原对话</button>}{failedSend && <button disabled={pending} onClick={() => void send(failedSend)}>重试这条消息</button>}</div>}
        {!contextPath && currentPath && <p className="assistant-context-note">当前页面：《{titleFromPath(currentPath)}》 <button type="button" disabled={locked} onClick={() => { setPinnedPath(currentPath); setScope('current'); }}>带入这份资料</button></p>}
        <div className="assistant-scope"><BookOpen /><select aria-label="资料范围" value={scope} disabled={locked} onChange={event => setScope(event.target.value as 'brain' | 'current')}><option value="brain">整个大脑</option><option value="current" disabled={!contextPath && !draftStore.current.attachments.length}>{!contextPath && draftStore.current.attachments.length ? '仅本轮附件' : `当前资料${!contextPath ? ' · 请先打开一篇' : ''}`}</option></select>{contextPath && <span title={contextPath}>{hasPinnedContext ? '固定：' : '当前：'}{titleFromPath(contextPath)}</span>}{contextPath && <button type="button" className="assistant-icon-button" aria-label={hasPinnedContext ? '跟随当前页面资料' : '固定这份资料'} title={hasPinnedContext ? '跟随当前页面资料' : '固定这份资料'} disabled={locked} aria-pressed={hasPinnedContext} onClick={() => setPinnedPath(hasPinnedContext ? undefined : contextPath)}><Pin size={13} /></button>}</div>
        {hasPinnedContext && pinnedPath && currentPath && pinnedPath !== currentPath && <p className="assistant-context-change">已切换页面，本轮仍使用《{titleFromPath(pinnedPath)}》。<button type="button" disabled={locked} onClick={() => setPinnedPath(currentPath)}>改用当前页</button></p>}
        {scope === 'current' && conversation?.messages.length ? <p className="assistant-context-note">{contextPath ? `本轮仅检索这份资料${draftStore.current.attachments.length ? '及已选文件' : ''}` : '本轮仅检索已选文件'}；对话仍保留之前的消息。</p> : null}
        <AttachmentPicker key={draftStore.current.id} api={api} value={draftStore.current.attachments} groupId={draftStore.current.groupId} refreshKey={attachmentRefreshKey} disabled={locked} onAttachmentsChange={setAttachmentRecords} onChange={async attachments => { draftStore.update({ attachments }); if (!await draftStore.flush()) throw new Error('draft not saved'); }}>
        {!attachmentsReady && draftStore.current.attachments.length > 0 && <p className="assistant-context-note">附件可阅读后再发送；无法读取的文件可移除或在收件箱归档原件。</p>}
        <form className="assistant-composer" onSubmit={event => { event.preventDefault(); void send(); }}><textarea ref={textArea} aria-label="发送给问问的消息" placeholder={provider?.status === 'ready' ? '问问你的大脑…' : '连接 AI 后，问问你的大脑…'} value={draft} disabled={pending || !draftStore.ready || restoringConversation} maxLength={16000} rows={2} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } }} /><div className="assistant-composer__footer"><span>{isRunning ? '关闭面板后仍会继续' : 'Enter 发送 · Shift Enter 换行'}</span><ContextUsage conversation={conversation} model={model} draftChanged={Boolean(draft.trim())} attachmentCount={draftStore.current.attachments.length} disabled={locked} onContinue={() => setShowContinuation(true)} />{isRunning ? <button type="button" className="assistant-send" aria-label="停止回答" title="停止回答" disabled={pending} onClick={() => void stop()}><Square /></button> : <button type="submit" className="assistant-send ai-glow-control" aria-label={pending ? '正在发送' : '发送消息'} title="发送消息" disabled={pending || !draftStore.ready || restoringConversation || missingConversation || !attachmentsReady || !draft.trim() || provider?.status !== 'ready' || !model || Boolean(providerError) || Boolean(skillRecommendation && skillRecommendation.status !== 'invalidated')}>{pending ? <LoaderCircle className="assistant-spin" /> : <ArrowUp />}</button>}</div></form></AttachmentPicker>
        {api.assistantDrafts && <p className="assistant-draft-status" role="status">{draftStore.notice || (!draftStore.ready ? '正在恢复本机草稿…' : draftStore.saving || draftStore.dirty && !draftStore.error ? '正在保存到本机…' : draftStore.error ? '当前草稿尚未保存' : '草稿已保留在本机 · 新对话会保留旧记录')}</p>}
        <p className="assistant-disclosure">仅按问题读取所需资料，整理结果由你确认保存。</p>
      </div>
    </div>
    {showContinuation && conversation && <AssistantContinuation conversation={conversation} attachments={draftStore.current.attachments} records={attachmentRecords} onCancel={() => setShowContinuation(false)} onContinue={async (text, attachments) => { await startNewConversation(text, attachments); }} />}
  </aside>;
}
