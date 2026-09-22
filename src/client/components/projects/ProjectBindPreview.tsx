import { Check, FileCheck2, FolderOpen, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import type { ProjectScanPreview } from '../../../shared/api/projects.js';

export interface ProjectBindPreviewProps {
  readonly preview: ProjectScanPreview;
  readonly displayName: string;
  readonly onDisplayNameChange: (value: string) => void;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly submitting?: boolean;
  readonly reconnecting?: boolean;
}

function countLabel(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

export function ProjectBindPreview({
  preview,
  displayName,
  onDisplayNameChange,
  onConfirm,
  onCancel,
  submitting = false,
  reconnecting = false
}: ProjectBindPreviewProps) {
  const actionLabel = reconnecting ? '重新连接项目' : '确认添加项目';
  return (
    <section className="project-bind-preview instrument-panel" aria-labelledby="project-bind-preview-title">
      <header className="project-bind-preview__header">
        <div>
          <p className="projects-eyebrow">PROJECT FOLDER / SCAN PREVIEW</p>
          <h2 id="project-bind-preview-title">确认项目文件夹</h2>
          <p>只建立本地索引，不复制或改写原文件。项目产出会在确认后写入 AI工作区。</p>
        </div>
        <FolderOpen aria-hidden="true" />
      </header>

      <div className="project-bind-preview__summary" aria-label="扫描结果">
        <div><FileCheck2 aria-hidden="true" /><strong>{countLabel(preview.fileCount)}</strong><span>文件</span></div>
        <div><Check aria-hidden="true" /><strong>{countLabel(preview.readableFileCount)}</strong><span>可读取</span></div>
        <div><TriangleAlert aria-hidden="true" /><strong>{countLabel(preview.unsupportedCount)}</strong><span>暂不支持</span></div>
        <div><FolderOpen aria-hidden="true" /><strong>{countLabel(preview.ignoredCount)}</strong><span>已忽略</span></div>
        <div><TriangleAlert aria-hidden="true" /><strong>{countLabel(preview.issueCount)}</strong><span>需留意</span></div>
      </div>

      <div className="project-bind-preview__form">
        <label htmlFor="project-display-name">项目显示名（可选）</label>
        <input
          id="project-display-name"
          name="project-display-name"
          value={displayName}
          maxLength={255}
          onChange={(event) => onDisplayNameChange(event.target.value)}
          disabled={submitting}
          autoComplete="off"
        />
        <small>默认使用文件夹名称；不需要填写客户背景、阶段或目标。</small>
      </div>

      {preview.guidanceFiles.length > 0 && (
        <div className="project-bind-preview__guidance">
          <strong>可能的说明文件</strong>
          <ul>{preview.guidanceFiles.slice(0, 8).map((path) => <li key={path}><code>{path}</code></li>)}</ul>
        </div>
      )}

      {preview.issues.length > 0 && (
        <details className="project-bind-preview__issues">
          <summary>查看扫描提示（{preview.issues.length}）</summary>
          <ul>{preview.issues.slice(0, 12).map((issue) => <li key={issue}>{issue}</li>)}</ul>
        </details>
      )}

      <footer className="project-bind-preview__actions">
        <button type="button" className="projects-button projects-button--quiet" onClick={onCancel} disabled={submitting}>
          <X size={15} aria-hidden="true" />取消
        </button>
        <button type="button" className="projects-button projects-button--primary" onClick={onConfirm} disabled={submitting}>
          {submitting ? <LoaderCircle size={15} className="projects-spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
          {submitting ? `${actionLabel}…` : actionLabel}
        </button>
      </footer>
    </section>
  );
}
