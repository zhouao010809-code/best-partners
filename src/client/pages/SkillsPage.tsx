import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, FileText, RefreshCw, Sparkles } from 'lucide-react';
import type {
  ApiClientResult,
  ClientFailureState,
  SkillDetail,
  SkillsPage as SkillsPageData
} from '../api/client.js';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { PageState } from '../components/PageState.js';
import { SafeMarkdown } from '../components/SafeMarkdown.js';
import { isCancelled, type PageResource } from './pageSupport.js';
import '../styles/skills.css';

type SkillSummary = SkillsPageData['items'][number];
type DetailResource = PageResource<SkillDetail>;

function unavailableState(): ClientFailureState {
  return {
    status: 'operation-error',
    message: '当前连接不提供 Skill 库。'
  };
}

function failureState<T>(result: ApiClientResult<T>, fallback: string): ClientFailureState {
  if (!result.ok && !isCancelled(result)) {
    if (result.code === 'SKILL_CATALOG_UNAVAILABLE') return unavailableState();
    return {
      status: result.state.status,
      message: result.state.message || fallback
    };
  }
  return { status: 'operation-error', message: fallback };
}

function resourceData<T>(resource: PageResource<T>): T | undefined {
  return 'data' in resource ? resource.data : undefined;
}

function pageStateForResource<T>(resource: PageResource<T>): Extract<PageResource<T>, { status: 'loading' | 'refreshing' | 'failed' }> | undefined {
  if (resource.status === 'loading' || resource.status === 'refreshing' || resource.status === 'failed') return resource;
  return undefined;
}

export function SkillsPage() {
  const { api } = useConsoleRuntime();
  const skillsApi = api.skills;
  const [listResource, setListResource] = useState<PageResource<SkillsPageData>>({ status: 'loading' });
  const [selected, setSelected] = useState<SkillSummary>();
  const [detailResource, setDetailResource] = useState<DetailResource>();
  const [detailRetryToken, setDetailRetryToken] = useState(0);
  const [refreshToken, setRefreshToken] = useState(0);
  const listControllerRef = useRef<AbortController | null>(null);
  const detailControllerRef = useRef<AbortController | null>(null);
  const selectedButtonRef = useRef<HTMLButtonElement | null>(null);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);

  const refresh = useCallback(() => {
    setRefreshToken((value) => value + 1);
  }, []);

  useEffect(() => {
    listControllerRef.current?.abort();
    const controller = new AbortController();
    listControllerRef.current = controller;
    const previous = resourceData(listResource);
    setListResource(previous === undefined ? { status: 'loading' } : { status: 'refreshing', data: previous });

    if (skillsApi === undefined) {
      setListResource({ status: 'failed', state: unavailableState() });
      return () => controller.abort();
    }

    void skillsApi.list(controller.signal)
      .then((result) => {
        if (controller.signal.aborted || isCancelled(result)) return;
        if (!result.ok) {
          setListResource({ status: 'failed', state: failureState(result, 'Skill 目录暂时无法读取，请重试。'), ...(previous === undefined ? {} : { data: previous }) });
          return;
        }
        setListResource({ status: 'ready', data: result.value });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setListResource({ status: 'failed', state: { status: 'disconnected', message: 'Skill 目录暂时无法读取，请重试。' }, ...(previous === undefined ? {} : { data: previous }) });
        }
      });

    return () => controller.abort();
  }, [refreshToken, skillsApi]);

  useEffect(() => () => {
    listControllerRef.current?.abort();
    detailControllerRef.current?.abort();
  }, []);

  useEffect(() => {
    detailControllerRef.current?.abort();
    if (selected === undefined) {
      setDetailResource(undefined);
      return;
    }
    if (skillsApi === undefined) {
      setDetailResource({ status: 'failed', state: unavailableState() });
      return;
    }
    const controller = new AbortController();
    detailControllerRef.current = controller;
    setDetailResource({ status: 'loading' });
    void skillsApi.get(selected.id, controller.signal)
      .then((result) => {
        if (controller.signal.aborted || isCancelled(result)) return;
        if (!result.ok) {
          setDetailResource({ status: 'failed', state: failureState(result, 'Skill 方法暂时无法读取，请重试。') });
          return;
        }
        setDetailResource({ status: 'ready', data: result.value });
        queueMicrotask(() => detailHeadingRef.current?.focus({ preventScroll: true }));
      })
      .catch(() => {
        if (!controller.signal.aborted) setDetailResource({ status: 'failed', state: { status: 'disconnected', message: 'Skill 方法暂时无法读取，请重试。' } });
      });
    return () => controller.abort();
  }, [detailRetryToken, selected, skillsApi]);

  const listData = resourceData(listResource);
  const showListState = pageStateForResource(listResource);
  const detailData = detailResource?.status === 'ready' ? detailResource.data : undefined;
  const displayedSkill = detailData ?? selected;

  function openDetail(skill: SkillSummary, trigger: HTMLButtonElement): void {
    selectedButtonRef.current = trigger;
    setSelected(skill);
  }

  function closeDetail(): void {
    setSelected(undefined);
    setDetailResource(undefined);
    queueMicrotask(() => selectedButtonRef.current?.focus({ preventScroll: true }));
  }

  function retryDetail(): void {
    if (selected !== undefined) setDetailRetryToken((value) => value + 1);
  }

  return (
    <section className="skills-page" aria-label="Skill 库">
      <header className="skills-page__toolbar">
        <div className="skills-page__intro">
          <span className="skills-page__mark" aria-hidden="true"><Sparkles size={18} /></span>
          <div>
            <p className="skills-page__eyebrow">LOCAL METHODS / READ ONLY</p>
            <h2>可复用的方法</h2>
            <p>从本地 <code>.claude/skills</code> 读取 Skill 说明，先浏览，后续再接入智能匹配。</p>
          </div>
        </div>
        <div className="skills-page__actions">
          <span className="skills-page__seal">只读目录</span>
          {!selected && <button
            type="button"
            className="skills-page__refresh"
            aria-label="刷新 Skill 库"
            title="刷新 Skill 库"
            disabled={listResource.status === 'loading' || listResource.status === 'refreshing'}
            onClick={refresh}
          ><RefreshCw size={16} className={listResource.status === 'refreshing' ? 'skills-spin' : undefined} />刷新</button>}
        </div>
      </header>

      {selected ? (
        <article className="skills-detail" aria-labelledby="skill-detail-title">
          <button type="button" className="skills-back" onClick={closeDetail}>
            <ArrowLeft size={16} aria-hidden="true" />返回 Skill 库
          </button>
          <div className="skills-detail__heading">
            <div>
              <p className="skills-page__eyebrow">SKILL / METHOD NOTE</p>
              <h2 id="skill-detail-title" ref={detailHeadingRef} tabIndex={-1}>{displayedSkill?.name ?? selected.name}</h2>
              <p>{displayedSkill?.description ?? selected.description}</p>
            </div>
            <code>版本 {(displayedSkill?.revision ?? selected.revision).slice(0, 8)}</code>
          </div>
          {detailResource?.status === 'loading' && <PageState state={{ status: 'loading', message: '正在读取 Skill 方法。' }} />}
          {detailResource?.status === 'failed' && <div className="skills-detail__error"><PageState state={detailResource.state} /><button type="button" onClick={retryDetail}>重新读取 Skill 方法</button></div>}
          {detailResource?.status === 'ready' && <>
            <div className="skills-detail__readonly"><FileText size={15} />以下内容来自本地 <code>SKILL.md</code>，当前仅供阅读。</div>
            <section className="skills-detail__body" aria-label="Skill 方法正文"><SafeMarkdown>{detailResource.data.markdown}</SafeMarkdown></section>
            <section className="skills-references" aria-labelledby="skill-references-title">
              <h3 id="skill-references-title">同目录参考文件</h3>
              {detailResource.data.references.length > 0 ? <ul>{detailResource.data.references.map((reference) => <li key={reference}><code>{reference}</code></li>)}</ul> : <p>这个 Skill 没有额外参考文件。</p>}
            </section>
          </>}
        </article>
      ) : (
        <>
          {showListState?.status === 'loading' && <PageState state={{ status: 'loading', message: '正在读取本地 Skill 目录。' }} />}
          {showListState?.status === 'refreshing' && <PageState state={{ status: 'refreshing', message: '正在刷新本地 Skill 目录。' }} />}
          {showListState?.status === 'failed' && <div className="skills-list__error"><PageState state={showListState.state} /><button type="button" onClick={refresh}>重新读取 Skill 库</button>{showListState.state.message === '当前连接不提供 Skill 库。' && <p>请使用支持本地文件 Skill 的桌面连接。</p>}</div>}
          {listResource.status === 'ready' && listData !== undefined && listData.items.length === 0 && <div className="skills-empty"><PageState state={{ status: 'empty', message: '在 .claude/skills 下添加 Skill 文件夹' }} /><h3>当前还没有可浏览的 Skill。</h3><p>每个 Skill 文件夹需要包含一个 <code>SKILL.md</code>。</p></div>}
          {listData !== undefined && listData.items.length > 0 && <section className="skills-grid" aria-label="Skill 列表">{listData.items.map((skill) => <article className="skills-card" key={skill.id}>
            <div className="skills-card__topline"><span className="skills-card__dot" aria-hidden="true" /><code>LOCAL SKILL</code></div>
            <h3>{skill.name}</h3>
            <p>{skill.description}</p>
            <div className="skills-card__footer"><code>版本 {skill.revision.slice(0, 8)}</code><button type="button" onClick={(event) => openDetail(skill, event.currentTarget)} aria-label={`查看方法：${skill.name}`}>查看方法<ArrowLeft size={14} aria-hidden="true" /></button></div>
          </article>)}</section>}
        </>
      )}
    </section>
  );
}
