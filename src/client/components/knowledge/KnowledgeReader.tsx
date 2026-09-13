import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { liveKnowledgeDetailSchema } from '../../../shared/api/schemas.js';
import type { KnowledgeRecord } from '../../../shared/domain/records.js';
import type { LiveKnowledgeDetail } from '../../api/client.js';
import { useConsoleRuntime } from '../../app/ConsoleRuntime.js';
import { isCancelled, stableFailure, type PageResource } from '../../pages/pageSupport.js';
import { KnowledgeDetail } from '../KnowledgeDetail.js';

export interface KnowledgeReaderProps {
  readonly path: string;
  readonly record?: KnowledgeRecord;
  readonly revision?: string;
  readonly onClose: () => void;
  readonly onLoaded?: (record: KnowledgeRecord) => void;
  readonly onUse?: (record: Pick<KnowledgeRecord, 'path'>) => void;
}

function detailMatches(
  record: Pick<NonNullable<LiveKnowledgeDetail['record']>, 'path' | 'title' | 'rawSha256' | 'upstreamVersion'>,
  detail: LiveKnowledgeDetail
): boolean {
  return detail.path === record.path
    && detail.title === record.title
    && detail.versionMarker.rawSha256 === record.rawSha256
    && detail.versionMarker.upstreamVersion === record.upstreamVersion;
}

export function KnowledgeReader({ path, record, revision, onClose, onLoaded, onUse }: KnowledgeReaderProps) {
  const { api, dataRevision } = useConsoleRuntime();
  const key = JSON.stringify([path, record?.path, record?.title, record?.rawSha256, record?.upstreamVersion, dataRevision, revision]);
  const [attempt, setAttempt] = useState(0);
  const [trashState, setTrashState] = useState<{ key: string; deleted: boolean }>();
  const [view, setView] = useState<{ key: string; resource: PageResource<LiveKnowledgeDetail> }>();
  const [opening, setOpening] = useState<{ key: string; status: 'idle' | 'opening' | 'opened' | 'failed' }>();
  const currentKeyRef = useRef(key);
  const generationRef = useRef(0);
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const closedRef = useRef(false);
  const onLoadedRef = useRef(onLoaded);
  currentKeyRef.current = key;
  onLoadedRef.current = onLoaded;

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    const generation = ++generationRef.current;
    closedRef.current = false;
    const isCurrent = () => !controller.signal.aborted && !closedRef.current
      && currentKeyRef.current === key && generationRef.current === generation;
    setView(previous => {
      const data = previous && 'data' in previous.resource ? previous.resource.data : undefined;
      return { key, resource: data?.path === path ? { status: 'refreshing', data } : { status: 'loading' } };
    });
    setOpening({ key, status: 'idle' });
    setTrashState(undefined);

    void (async () => {
      try {
        const result = await api.getKnowledgeDetail(path, controller.signal);
        if (!isCurrent()) return;
        if (isCancelled(result)) {
          setView({ key, resource: { status: 'failed', state: stableFailure('operation-error', '读取知识') } });
          return;
        }
        if (!result.ok) {
          const inTrash = 'code' in result && (result.code === 'KNOWLEDGE_IN_TRASH' || result.code === 'KNOWLEDGE_DELETED');
          if (inTrash) setTrashState({ key, deleted: result.code === 'KNOWLEDGE_DELETED' });
          setView({ key, resource: { status: 'failed', state: inTrash
            ? { status: result.state.status, message: result.code === 'KNOWLEDGE_DELETED' ? '这篇知识已彻底删除，无法从 App 恢复。' : '这篇知识已移入回收站，可在回收站恢复。' }
            : stableFailure(result.state.status, '读取知识') } });
          return;
        }
        const parsed = liveKnowledgeDetailSchema.safeParse(result.value);
        if (!parsed.success || (record === undefined && parsed.data.record === undefined)) {
          setView({ key, resource: { status: 'failed', state: stableFailure('validation-error', '读取知识') } });
          return;
        }
        const detail = parsed.data;
        const expected = record ?? detail.record!;
        if (expected.path !== path || !detailMatches(expected, detail)
          || (detail.record !== undefined && !detailMatches(detail.record, detail))) {
          setView({ key, resource: { status: 'failed', state: stableFailure('conflict', '读取知识') } });
          return;
        }
        // Older adapters omit record; their indexed record has passed the same version check.
        const { upstreamVersion, createdAt, updatedAt, ...core } = detail.record ?? expected;
        const loaded: KnowledgeRecord = {
          ...core,
          ...(upstreamVersion === undefined ? {} : { upstreamVersion }),
          ...(createdAt === undefined ? {} : { createdAt }),
          ...(updatedAt === undefined ? {} : { updatedAt })
        };
        setView({ key, resource: { status: 'ready', data: { ...detail, record: loaded } } });
        onLoadedRef.current?.(loaded);
      } catch {
        if (isCurrent()) setView({ key, resource: { status: 'failed', state: stableFailure('operation-error', '读取知识') } });
      }
    })();
    return () => controller.abort();
    // The key tracks record identity/version; callback or record-object churn must not reread.
  }, [api, key, attempt]);

  const close = useCallback(() => {
    if (closedRef.current) return;
    closedRef.current = true;
    controllerRef.current?.abort();
    generationRef.current += 1;
    onClose();
  }, [onClose]);

  async function open(): Promise<void> {
    if (closedRef.current) return;
    const generation = generationRef.current;
    const controller = controllerRef.current;
    const isCurrent = () => !closedRef.current && !controller?.signal.aborted
      && currentKeyRef.current === key && generationRef.current === generation;
    setOpening({ key, status: 'opening' });
    try {
      const result = await api.openKnowledge(path);
      if (!isCurrent()) return;
      setOpening({ key, status: result.ok && result.value.opened && result.value.path === path ? 'opened' : 'failed' });
    } catch {
      if (isCurrent()) setOpening({ key, status: 'failed' });
    }
  }

  const previousData = view && 'data' in view.resource ? view.resource.data : undefined;
  const resource: PageResource<LiveKnowledgeDetail> = view?.key === key ? view.resource
    : previousData?.path === path ? { status: 'refreshing', data: previousData } : { status: 'loading' };
  const loadedRecord = resource.status === 'ready' || resource.status === 'refreshing' ? resource.data?.record : undefined;

  return <><KnowledgeDetail
    presentation="inline"
    record={loadedRecord ?? record ?? { path, title: path.split('/').at(-1)?.replace(/\.md$/u, '') || '知识正文' }}
    resource={resource}
    openState={opening?.key === key ? opening.status : 'idle'}
    onClose={close}
    onOpen={() => { void open(); }}
    onRetry={() => setAttempt((value) => value + 1)}
    {...(resource.status === 'ready' && loadedRecord && onUse ? { onUse: () => onUse(loadedRecord) } : {})}
  />{trashState?.key === key && !trashState.deleted && <Link className="quiet-button" to="/trash?origin=knowledge">前往知识回收站</Link>}</>;
}
