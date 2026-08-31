import type { FormEvent } from 'react';
import { Filter, Search } from 'lucide-react';

export type MaterialFilterDraft = {
  readonly status: '' | '未提炼' | '部分入库';
  readonly sourcePlatform: string;
  readonly collectedFrom: string;
  readonly collectedTo: string;
  readonly title: string;
};

export interface MaterialFiltersProps {
  readonly draft: MaterialFilterDraft;
  readonly onChange: (draft: MaterialFilterDraft) => void;
  readonly onSubmit: () => void;
}

export function MaterialFilters({ draft, onChange, onSubmit }: MaterialFiltersProps) {
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    onSubmit();
  }

  return (
    <form className="filter-panel" aria-label="材料筛选" onSubmit={submit}>
      <label className="filter-field filter-field--search">
        <span>标题</span>
        <span className="filter-input"><Search aria-hidden="true" /><input value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} placeholder="搜索原始标题" /></span>
      </label>
      <label className="filter-field">
        <span>状态</span>
        <select value={draft.status} onChange={(event) => onChange({ ...draft, status: event.target.value as MaterialFilterDraft['status'] })}>
          <option value="">全部待处理</option>
          <option value="未提炼">未提炼</option>
          <option value="部分入库">部分入库</option>
        </select>
      </label>
      <label className="filter-field">
        <span>来源平台</span>
        <input value={draft.sourcePlatform} onChange={(event) => onChange({ ...draft, sourcePlatform: event.target.value })} placeholder="例如：微信" />
      </label>
      <label className="filter-field">
        <span>开始日期</span>
        <input type="date" value={draft.collectedFrom} onChange={(event) => onChange({ ...draft, collectedFrom: event.target.value })} />
      </label>
      <label className="filter-field">
        <span>结束日期</span>
        <input type="date" value={draft.collectedTo} onChange={(event) => onChange({ ...draft, collectedTo: event.target.value })} />
      </label>
      <button className="primary-filter-button" type="submit"><Filter aria-hidden="true" />应用筛选</button>
    </form>
  );
}
