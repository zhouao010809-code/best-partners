import { CircleCheck, FolderSync, LoaderCircle, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react';
import type { ProjectSummary } from '../../../shared/api/projects.js';

export interface ProjectStatusCardProps {
  readonly project: ProjectSummary;
  readonly onRefresh: () => void;
  readonly onReconnect: () => void;
  readonly refreshing?: boolean;
  readonly reconnecting?: boolean;
  readonly message?: string;
}

const STATUS_COPY: Record<ProjectSummary['availability'], { label: string; detail: string; icon: typeof CircleCheck }> = {
  ready: { label: '已连接', detail: '项目文件夹可读取，下一轮问问可以使用最新索引。', icon: CircleCheck },
  scanning: { label: '正在扫描', detail: '正在核对项目文件变化，当前页面仍可查看已有资料。', icon: FolderSync },
  unavailable: { label: '暂时不可用', detail: '项目文件夹当前无法读取，请刷新或重新连接。', icon: WifiOff },
  'reconnect-required': { label: '需要重新连接', detail: '原项目文件夹已移动、替换或失去权限；不会自动切换到其他目录。', icon: TriangleAlert }
};

export function ProjectStatusCard({ project, onRefresh, onReconnect, refreshing = false, reconnecting = false, message }: ProjectStatusCardProps) {
  const copy = STATUS_COPY[project.availability];
  const Icon = copy.icon;
  const reconnectRequired = project.availability === 'reconnect-required' || project.availability === 'unavailable';
  return (
    <section className={`project-status-card project-status-card--${project.availability}`} aria-labelledby="project-status-title">
      <div className="project-status-card__icon"><Icon aria-hidden="true" /></div>
      <div className="project-status-card__copy">
        <p className="projects-eyebrow">PROJECT SYNC</p>
        <h2 id="project-status-title">项目语料：{copy.label}</h2>
        <p>{copy.detail}</p>
        {message !== undefined && <p className="projects-inline-message" role="status">{message}</p>}
      </div>
      <div className="project-status-card__actions">
        <button type="button" className="projects-button projects-button--quiet" onClick={onRefresh} disabled={refreshing || reconnecting}>
          {refreshing ? <LoaderCircle size={15} className="projects-spin" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
          {refreshing ? '刷新中…' : '刷新索引'}
        </button>
        {reconnectRequired && <button type="button" className="projects-button projects-button--primary" onClick={onReconnect} disabled={refreshing || reconnecting}>
          {reconnecting ? <LoaderCircle size={15} className="projects-spin" aria-hidden="true" /> : <FolderSync size={15} aria-hidden="true" />}
          {reconnecting ? '等待选择…' : '重新连接'}
        </button>}
      </div>
    </section>
  );
}
