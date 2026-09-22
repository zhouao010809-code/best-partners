import type Database from 'better-sqlite3';
import type { OperationRecord, OperationQuery } from '../../shared/api/schemas.js';
import { operationRecordSchema } from '../../shared/api/schemas.js';
import type { IntakeArchiveOutcome } from '../archive/intake-archive.js';
import type { TrashEntry } from '../../shared/api/trash.js';
import type { IntakeTrashEntry } from '../../shared/api/intake-trash.js';
import { readMaterialVisibility, readDeletedSourceCutoffs } from './material-visibility.js';
import type { ProjectOperation } from '../../shared/api/projects.js';

interface Sources {
  database?: Database.Database | undefined;
  intakeHistory?: (() => IntakeArchiveOutcome[] | Promise<IntakeArchiveOutcome[]>) | undefined;
  trash?: (() => { items: TrashEntry[] }) | undefined;
  intakeTrash?: (() => { items: IntakeTrashEntry[] }) | undefined;
  projectOperations?: (() => ProjectOperation[] | Promise<ProjectOperation[]>) | undefined;
}
type RunRow = { id: string; material_path: string; title: string; created_at: string; status: string; problem: string | null };
type BatchRow = { id: string; run_id: string; title: string | null; material_path: string | null; created_at: string; status: string; indexed: number; problem: string | null; paths: string };
const titleOf = (path: string) => path.split('/').filter(Boolean).at(-1)?.replace(/\.md$/iu, '') || '归档资料';
const extractionHref = (id: string) => `/extractions/${encodeURIComponent(id)}`;

/** Read-only projection. No review()/ensure(), model call, file write or recovery execution. */
export function createOperationLedger(sources: Sources) {
  return { async list(query: OperationQuery) {
    const records: OperationRecord[] = []; const issues: string[] = [];
    async function collect(label: string, read: (() => OperationRecord[] | Promise<OperationRecord[]>) | undefined) {
      if (!read) { issues.push(`${label}记录暂不可用`); return; }
      try { const values = await read(); records.push(...values.map(value => operationRecordSchema.parse(value))); }
      catch { issues.push(`${label}记录读取未完成，请刷新或检查本地连接`); }
    }
    await collect('资料归档', sources.intakeHistory && (async () => (await sources.intakeHistory!()).map(row => {
      const complete = row.state === 'archived';
      return { id: `archive:${row.id}`, sourceId: row.id, title: titleOf(row.target), kind: 'archive',
        bucket: complete ? 'history' : 'attention', statusLabel: complete ? '已归档' : '待核验',
        summary: complete ? '归档收据已保存，可前往档案库调阅。' : '归档尚未完成核验，需要继续确认文件状态。',
        preserved: '原文件与归档恢复记录已保留。', paths: [row.target],
        nextStep: complete ? '在档案库查看已归档的资料。' : '核验目标文件与归档结果，不重复创建归档。',
        action: complete ? { kind: 'navigate', label: '前往档案库', href: '/library' } : { kind: 'resume-archive', label: '继续核验归档' }
      } satisfies OperationRecord;
    })));
    await collect('AI 提炼', sources.database && (() => {
      const rows = sources.database!.prepare('SELECT id,material_path,title,created_at,status,problem FROM personal_extraction_runs ORDER BY created_at DESC,rowid DESC').all() as RunRow[];
      const visibility = readMaterialVisibility(sources.database); const deleted = readDeletedSourceCutoffs(sources.database);
      const seen = new Set<string>();
      return rows.map(row => {
        const inactive = visibility.trashed.has(row.material_path) || visibility.removed.has(row.material_path) || Date.parse(row.created_at) <= (deleted.get(row.material_path) || 0);
        const latest = !seen.has(row.material_path) && !inactive; seen.add(row.material_path);
        const failed = row.status === 'failed'; const running = row.status === 'generating';
        return { id: `extraction:${row.id}`, sourceId: row.id, title: row.title, kind: 'extraction',
          bucket: running ? 'running' : failed && latest ? 'attention' : 'history',
          statusLabel: running ? '正在提炼' : failed ? latest ? '提炼未完成' : '历史失败' : row.status === 'ready' ? '候选已生成' : '已取消',
          occurredAt: row.created_at, timeLabel: '发起时间', paths: [row.material_path],
          summary: inactive ? '资料已移出处理范围，本次提炼保留在历史中。' : failed && !latest ? '后续已有新的提炼记录，本次保留在历史中。' : row.problem || (failed ? '本次提炼未完成，请查看原因后决定是否重试。' : running ? '正在生成候选，请等待结果。' : row.status === 'ready' ? '候选已保存在本机，是否入库由你决定。' : '本次提炼已取消，没有自动重发。'),
          preserved: '本次提炼记录已保留；提炼本身不会改写原资料。',
          nextStep: running ? '刷新查看进展，不重复发起。' : '打开本次提炼查看结果或原因，再决定下一步。',
          action: running ? { kind: 'refresh', label: '刷新进展' } : { kind: 'navigate', label: failed && latest ? '查看原因与重试' : '查看提炼记录', href: extractionHref(row.id) }
        } satisfies OperationRecord;
      });
    }));
    await collect('知识入库', sources.database && (() => {
      // Project only file paths; source/target bodies and candidate payloads never leave the store.
      const rows = sources.database!.prepare(`SELECT b.id,b.run_id,b.created_at,b.status,b.indexed,b.problem,r.title,r.material_path,
        (SELECT json_group_array(json_extract(f.value,'$.path')) FROM json_each(b.plan_json,'$.files') f) AS paths
        FROM personal_ingestion_batches b LEFT JOIN personal_extraction_runs r ON r.id=b.run_id`).all() as BatchRow[];
      return rows.map(row => {
        const committed = row.status === 'committed'; const done = committed && row.indexed === 1;
        return { id: `ingestion:${row.id}`, sourceId: row.id, title: row.title || '知识入库记录', kind: 'ingestion',
          bucket: done ? 'history' : 'attention', statusLabel: done ? '已入库' : committed ? '待更新检索' : row.status === 'needs-review' ? '待确认变化' : '待继续核验',
          occurredAt: row.created_at, timeLabel: '批次创建时间', paths: JSON.parse(row.paths) as string[],
          summary: done ? '知识文件已写入，检索已更新。' : committed ? '文件已写入，只需更新检索，不重新写入知识。' : row.problem || '这批入库尚未完成，请核验已保存的进度。',
          preserved: committed ? '本批知识文件已经写入。' : '入库计划和候选已保存在本机。',
          nextStep: done ? '查看本批的候选与入库结果。' : committed ? '使用原批次继续更新检索。' : '在原提炼工作台核验本批文件；有冲突时先预览再确认。',
          action: committed && !done ? { kind: 'resume-index', label: '更新检索' } : { kind: 'navigate', label: done ? '查看入库结果' : '前往核验入库', href: `${extractionHref(row.run_id)}?batch=${encodeURIComponent(row.id)}` }
        } satisfies OperationRecord;
      });
    }));
    function recycled(row: TrashEntry | IntakeTrashEntry, intake: boolean): OperationRecord {
      const restored = row.status === 'restored'; const deleted = row.status === 'deleted';
      const done = ['trashed', 'restored', 'deleted'].includes(row.status);
      const missingIndex = 'indexed' in row && !row.indexed && !deleted;
      const at = deleted ? row.deletedAt : restored && 'restoredAt' in row ? row.restoredAt : undefined;
      return { id: `${intake ? 'intake-trash' : 'trash'}:${row.id}`, sourceId: row.id, title: row.title,
        kind: deleted ? 'delete' : restored ? 'restore' : 'trash', bucket: !done || missingIndex ? 'attention' : 'history',
        statusLabel: !done ? '待核验回收' : missingIndex ? '待同步检索' : deleted ? '已彻底删除' : restored ? '已恢复' : '已移入回收站',
        occurredAt: at || row.createdAt, timeLabel: at ? deleted ? '删除时间' : '恢复时间' : '移入记录时间',
        summary: row.problem || (deleted ? '指定资料已彻底删除，无法从 App 恢复。' : restored ? '资料已恢复到原位置。' : done ? '资料暂存在统一回收站，可在那里恢复或彻底删除。' : '回收操作尚需核验，请前往统一回收站。'),
        preserved: deleted ? '仅保留操作记录，不再保留可恢复的文件。' : '本页仅展示操作状态，文件处理统一在回收站完成。',
        paths: ['materialPath' in row ? row.materialPath : `01图书馆/小兆clipper/${row.name}`],
        nextStep: '在统一回收站查看这项记录；本页不执行恢复或删除。',
        action: { kind: 'navigate', label: '前往回收站', href: '/trash' }
      };
    }
    await collect('文档回收', sources.trash && (() => sources.trash!().items.map(row => recycled(row, false))));
    await collect('收件箱回收', sources.intakeTrash && (() => sources.intakeTrash!().items.map(row => recycled(row, true))));
    await collect('项目输出', sources.projectOperations && (async () => {
      const rows = await sources.projectOperations!();
      // Refresh/reconnect receipts intentionally stay in the project service.
      // The global ledger exposes only output receipts, whose target is a
      // public project-relative path (never the private root or sentinel
      // paths used for refresh bookkeeping).
      return rows.filter(row => row.eventType === 'project-write').map(row => {
        const done = row.status === 'completed';
        const stale = row.status === 'stale';
        return { id: `project:${row.id}`, sourceId: row.id, title: `项目输出 · ${row.targetPath}`, kind: 'project-output',
          bucket: done ? 'history' : 'attention', statusLabel: done ? '已保存' : stale ? '计划已失效' : '写入未完成',
          occurredAt: row.createdAt, timeLabel: '操作时间', paths: [row.targetPath],
          summary: done ? '内容已保存到项目 AI 工作区。' : stale ? '项目内容已变化，这次计划没有写入。' : '项目输出没有完成，保留了操作记录。',
          preserved: '项目源文件与全局知识库均未被修改。',
          nextStep: done ? '打开项目工作区查看输出。' : '打开项目工作区检查状态后重新生成。',
          action: { kind: 'navigate', label: '打开项目', href: `/projects/${encodeURIComponent(row.projectId)}` }
        } satisfies OperationRecord;
      });
    }));
    records.sort((a, b) => (b.occurredAt || '').localeCompare(a.occurredAt || '') || a.id.localeCompare(b.id));
    const counts = { all: records.length, attention: records.filter(r => r.bucket === 'attention').length, running: records.filter(r => r.bucket === 'running').length };
    const filtered = records.filter(row => !query.view || query.view === 'all' || row.bucket === query.view);
    const offset = Number(query.cursor || 0); const limit = query.limit || 50;
    return { items: filtered.slice(offset, offset + limit), counts, issues,
      ...(offset + limit < filtered.length ? { nextCursor: String(offset + limit) } : {}) };
  } };
}
