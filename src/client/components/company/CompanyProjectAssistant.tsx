import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { CompanyProject } from './company-api.js';
import type { CompanyProjectMetrics } from '../../../shared/api/company-metrics.js';

export interface CompanyProjectAssistantProps {
  readonly project: CompanyProject;
  readonly metrics?: CompanyProjectMetrics;
}

type AssistantTask = 'analysis' | 'anomalies' | 'plan';
type CopyState = 'idle' | 'copying' | 'copied' | 'failed';

const TASKS: ReadonlyArray<{ readonly id: AssistantTask; readonly label: string; readonly promptLabel: string }> = [
  { id: 'analysis', label: '分析项目现状', promptLabel: '分析项目现状' },
  { id: 'anomalies', label: '找平台异常', promptLabel: '找平台异常' },
  { id: 'plan', label: '生成下周计划', promptLabel: '生成下周计划' }
];

const STATUS_LABELS: Record<CompanyProject['status'], string> = {
  draft: '草稿', active: '服务中', acceptance: '验收中', completed: '已完成', paused: '已暂停', archived: '已封存'
};

const PLATFORM_LABELS: Record<CompanyProjectMetrics['platforms'][number]['platform'], string> = {
  douyin: '抖音',
  'wechat-channels': '视频号',
  xiaohongshu: '小红书'
};

function formatDate(date: string | null | undefined): string {
  if (date === null || date === undefined) return '暂无可用日期';
  return date;
}

function dataGap(metrics?: CompanyProjectMetrics): string {
  if (metrics === undefined) return '平台数据尚未建立基线';
  const gaps = metrics.platforms
    .filter(platform => platform.coverage !== 'connected')
    .map(platform => {
      const label = PLATFORM_LABELS[platform.platform];
      if (platform.coverage === 'import_required') return `${label}待导出`;
      if (platform.coverage === 'stale') return `${label}数据可能过期`;
      if (platform.coverage === 'error') return `${label}同步失败`;
      if (platform.coverage === 'attention') return `${label}需要处理`;
      return `${label}尚未接入`;
    });
  return gaps.length > 0 ? gaps.join('、') : '暂无已知数据缺口';
}

function promptFor(task: string, project: CompanyProject, metrics: CompanyProjectMetrics | undefined, date: string, gap: string): string {
  const client = project.clientName === undefined ? '未提供' : project.clientName;
  const selectedSkills = project.selectedSkillIds.length > 0 ? project.selectedSkillIds.join('、') : '无';
  const coverage = metrics === undefined ? '尚未建立平台数据基线' : `数据截至 ${date}；数据缺口：${gap}`;
  return [
    `请${task}。`,
    '你是一个只读项目助理，只能基于下方已提供的项目上下文提出分析、异常线索或计划建议。',
    `项目名称：${project.name}`,
    `项目 ID：${project.id}`,
    `客户名称：${client}`,
    `项目状态：${STATUS_LABELS[project.status]}`,
    `已选 Skill：${selectedSkills}`,
    `平台数据：${coverage}`,
    '不会直接修改项目文件，也不会要求或处理平台登录凭据。请把无法从当前上下文确认的内容标为待核实。'
  ].join('\n');
}

export function CompanyProjectAssistant({ project, metrics }: CompanyProjectAssistantProps): ReactElement {
  const [selectedTask, setSelectedTask] = useState<AssistantTask>();
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [copyError, setCopyError] = useState<string>();
  const selectedTaskInfo = TASKS.find(task => task.id === selectedTask);
  const latestDate = formatDate(metrics?.latestMetricDate);
  const gap = dataGap(metrics);
  const prompt = useMemo(
    () => selectedTaskInfo === undefined ? '' : promptFor(selectedTaskInfo.promptLabel, project, metrics, latestDate, gap),
    [gap, latestDate, metrics, project, selectedTaskInfo]
  );

  function chooseTask(task: AssistantTask): void {
    setSelectedTask(task);
    setCopyState('idle');
    setCopyError(undefined);
  }

  async function copyPrompt(): Promise<void> {
    if (prompt.length === 0 || copyState === 'copying') return;
    setCopyState('copying');
    setCopyError(undefined);
    try {
      if (navigator.clipboard === undefined || typeof navigator.clipboard.writeText !== 'function') throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(prompt);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
      setCopyError('复制失败，请检查剪贴板权限后重试。');
    }
  }

  return (
    <section className="company-record-panel company-project-assistant" aria-labelledby="company-project-assistant-title">
      <header className="company-project-assistant__header">
        <div>
          <p className="company-eyebrow">READ-ONLY PROJECT SUPPORT</p>
          <h2 id="company-project-assistant-title">项目助理</h2>
          <p className="company-muted">只读读取当前项目上下文，生成可交给 Codex 或 WorkBuddy 的任务提示。</p>
        </div>
        <span className="company-status company-status--readonly">只读</span>
      </header>

      <section className="company-project-assistant__context" aria-labelledby="company-project-assistant-context-title">
        <h3 id="company-project-assistant-context-title">只读项目上下文</h3>
        <dl>
          <div><dt>项目</dt><dd>{project.name}</dd></div>
          <div><dt>项目状态</dt><dd>{STATUS_LABELS[project.status]}</dd></div>
          <div><dt>已选 Skill</dt><dd>{project.selectedSkillIds.length > 0 ? `${project.selectedSkillIds.length} 个` : '无'}</dd></div>
          <div><dt>数据日期</dt><dd>{latestDate}</dd></div>
          <div><dt>数据缺口</dt><dd>{gap}</dd></div>
        </dl>
      </section>

      <div className="company-project-assistant__actions" aria-label="项目助理操作">
        {TASKS.map(task => <button key={task.id} type="button" className={selectedTask === task.id ? 'company-primary-button' : 'company-secondary-button'} onClick={() => chooseTask(task.id)}>{task.label}</button>)}
      </div>

      {selectedTaskInfo !== undefined && <section className="company-project-assistant__task" aria-label="项目助理任务">
        <h3>项目助理任务</h3>
        <p className="company-muted">这是受控提示词，只包含项目名称、状态和数据覆盖信息；不会直接修改项目文件。</p>
        <pre>{prompt}</pre>
        <div className="company-project-assistant__copy-actions">
          <button type="button" className="company-primary-button" onClick={() => void copyPrompt()} disabled={copyState === 'copying'}>{copyState === 'copying' ? '正在复制…' : copyState === 'failed' ? '重试复制' : '复制给 Codex'}</button>
          {copyState === 'copied' && <p role="status">已复制任务提示，可粘贴到 Codex 或 WorkBuddy</p>}
          {copyState === 'failed' && copyError !== undefined && <p role="alert">{copyError}</p>}
        </div>
      </section>}
    </section>
  );
}
