import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { PublicApiError } from '../../shared/api/errors.js';
import { ingestionBatchSchema, ingestionPreviewSchema, ingestionReviewSchema, saveCandidateRequestSchema,
  type IngestionBatch, type IngestionMatches, type IngestionPreviewRequest, type IngestionRecoveryPreview, type SaveCandidateRequest, type ReviewCandidate } from '../../shared/api/ingestion.js';
import type { IndexRepository } from '../index/index-repository.js';
import { canonicalJson } from '../index/index-repository.js';
import type { ReadVaultGateway } from '../vault/VaultGateway.js';
import type { PersonalIngestionPort } from './ingestion-native.js';
import { createReviewStore } from './review-store.js';
import { assertKnowledgeTitle, createKnowledgeNote, linkTarget, mergeKnowledgeNote, patchFrontmatter, patchSource, sourceEvidenceSha, validateDraft } from './note-format.js';
import { applyPlan, assertPlanUnchanged, ingestionPlanSchema, persistPlan, verifyApplied, type IngestionPlan } from './ingestion-coordinator.js';
import { sha256Bytes } from '../vault/raw-bytes.js';
import { parseFrontmatter } from '../rules/frontmatter.js';
import { parseLibraryNoteForRead } from '../rules/read-compatible-notes.js';
import { parseKnowledgeNote } from '../rules/knowledge-schema.js';
import { normalizeWikiLinkList } from '../rules/wikilinks.js';
import { loadRuleBundle } from '../rules/rule-bundle.js';
import { validateFilesystemPath } from '../vault/filesystem-path.js';
import { readMaterialVisibility } from '../services/material-visibility.js';
import { isPartialExtraction } from '../services/extraction-coverage.js';

type BatchRow = { id: string; run_id: string; created_at: string; status: IngestionBatch['status']; indexed: number; plan_json: string; problem: string | null };
function fail(code: string, message: string, status = 409): never { throw new PublicApiError(code, message, status); }
const bytesEqual = (value: Buffer | null, expected: string | null) => expected === null ? value === null : value?.equals(Buffer.from(expected)) === true;
const sourceStatus = (bytes: Buffer) => parseLibraryNoteForRead(bytes).record?.knowledgeStatus ?? '未提炼';
const stamp = (items: ReviewCandidate[]) => sha256Bytes(Buffer.from(canonicalJson(items.map(({ batchId: _batch, ...item }) => item))));
const calendar = (date: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

export function createIngestionService(input: {
  database: Database.Database; repository: IndexRepository; gateway: ReadVaultGateway; port: PersonalIngestionPort;
  refreshIndex(): Promise<boolean>; now?: () => Date;
}) {
  const db = input.database; const port = input.port; const store = createReviewStore(db); const now = input.now ?? (() => new Date());
  let busy = false; let closed = false; let running: Promise<unknown> | undefined;
  const recoveryPreviews = new Map<string, { plan: IngestionPlan; basePlanSha: string; expiresAt: string }>();
  function requireIdle() { if (closed) fail('INGESTION_CLOSED', '应用正在关闭，已保存进度，请重新打开。'); if (busy) fail('INGESTION_BUSY', '正在完成入库，请稍后再操作。'); }
  async function exclusive<T>(task: () => Promise<T>): Promise<T> {
    requireIdle(); busy = true; const work = task(); running = work;
    try { return await work; } finally { busy = false; if (running === work) running = undefined; }
  }
  function assertNotInTrash(path: string): void {
    if (path.startsWith('02知识库/')) {
      if (readMaterialVisibility(db).trashed.has(path)) fail('KNOWLEDGE_IN_TRASH', '目标知识已在回收站或正在恢复，请先恢复该笔记，或选择其他新标题。');
      return;
    }
    if (readMaterialVisibility(db).trashed.has(path)) fail('SOURCE_IN_TRASH', '原资料已在回收站或正在恢复，请先恢复原资料再入库；候选仍然保留。');
  }
  function assertPlanNotInTrash(plan: IngestionPlan): void {
    for (const path of new Set([plan.materialPath, ...plan.files.map(file => file.path)])) assertNotInTrash(path);
  }
  function assertPlanCoverage(plan: IngestionPlan): void {
    if (plan.preview.sourceStatus === '已入库' && isPartialExtraction(store.run(plan.runId).sourceRange)) {
      fail('PLAN_STALE', '这次提炼只覆盖部分原文，旧预览的资料完成状态已失效，请重新预览或核对恢复预览。');
    }
  }
  function readSource(path: string): Buffer {
    assertNotInTrash(path);
    let bytes: Buffer | null;
    try { bytes = port.read(path); } catch { return fail('SOURCE_UNAVAILABLE', '原资料暂时无法读取，草稿仍保存在本机。'); }
    if (!bytes || !parseLibraryNoteForRead(bytes, path).record || parseFrontmatter(bytes).data.处理状态 !== '已归档') {
      return fail('SOURCE_UNAVAILABLE', '原资料已移走或格式发生变化，请先在 App 原始资料中检查。');
    }
    return bytes;
  }
  function allCandidates(path: string): ReviewCandidate[] { return store.sourceRuns(path).flatMap((run) => store.list(run.id)); }
  function head(runId: string): { current_raw_sha256: string; evidence_sha256: string } | undefined {
    return db.prepare('SELECT * FROM personal_ingestion_source_heads WHERE run_id=?').get(runId) as { current_raw_sha256: string; evidence_sha256: string } | undefined;
  }
  function sourceChanged(runId: string, bytes: Buffer): boolean {
    const run = store.run(runId); const sha = sha256Bytes(bytes); let saved = head(runId);
    if (!saved && run.sourceRawSha256 === sha) {
      db.prepare('INSERT OR IGNORE INTO personal_ingestion_source_heads VALUES (?,?,?,?)').run(runId, run.materialPath, sha, sourceEvidenceSha(bytes)); saved = head(runId);
    }
    return run.sourceRawSha256 !== sha && saved?.current_raw_sha256 !== sha;
  }
  async function directories(): Promise<string[]> {
    const result: string[] = [];
    async function walk(path: string, depth: number): Promise<void> {
      if (depth > 16 || result.length > 1000) fail('DIRECTORY_UNAVAILABLE', '知识目录数量或深度超出范围。');
      for (const entry of await input.gateway.listDirectory(path)) {
        if (!entry.endsWith('/')) continue;
        const name = entry.slice(0, -1);
        if (!name || name.startsWith('.') || /[/\\\u0000-\u001f]/u.test(name)) continue;
        const child = `${path}/${name}`; result.push(child); await walk(child, depth + 1);
      }
    }
    try { await walk('02知识库', 0); } catch (error) { if (error instanceof PublicApiError) throw error; fail('DIRECTORY_UNAVAILABLE', '知识目录暂时无法读取，请稍后刷新。'); }
    return result.sort();
  }
  function getRow(id: string): BatchRow {
    const row = db.prepare('SELECT * FROM personal_ingestion_batches WHERE id=?').get(id) as BatchRow | undefined;
    if (!row) return fail('BATCH_NOT_FOUND', '本批尚未开始写入，可使用原预览再次确认。', 404);
    return row;
  }
  function batch(id: string): IngestionBatch {
    const row = getRow(id); const plan = ingestionPlanSchema.parse(JSON.parse(row.plan_json));
    return ingestionBatchSchema.parse({ id, runId: row.run_id, createdAt: row.created_at, status: row.status, indexed: row.indexed === 1,
      knowledgePaths: [...new Set(plan.decisions.filter((d) => d.state === 'committed').map((d) => d.path!))],
      pendingCount: plan.preview.pendingCount, sourceStatus: plan.preview.sourceStatus, ...(row.problem ? { problem: row.problem } : {}) });
  }
  function assertNoOverlappingBatch(plan: IngestionPlan): void {
    const other = db.prepare("SELECT id,plan_json FROM personal_ingestion_batches WHERE status!='committed' AND id!=?").all(plan.id) as { id: string; plan_json: string }[];
    const paths = new Set([plan.materialPath, ...plan.files.map((file) => file.path)]);
    if (other.some((row) => { const pending = ingestionPlanSchema.parse(JSON.parse(row.plan_json)); return paths.has(pending.materialPath) || pending.files.some((file) => paths.has(file.path)); })) {
      fail('RECOVERY_REQUIRED', '相关文件已被另一未完成批次占用，请先完成那一批，或使用其他新标题。');
    }
  }
  async function review(runId: string) {
    const run = store.ensure(runId); const candidates = store.list(runId); const related = store.sourceRuns(run.materialPath);
    let bytes: Buffer | undefined;
    try { bytes = readSource(run.materialPath); } catch { /* History remains accessible if the source disappears. */ }
    const rows = db.prepare('SELECT id FROM personal_ingestion_batches WHERE run_id=? ORDER BY created_at DESC,rowid DESC LIMIT 200').all(runId) as { id: string }[];
    return ingestionReviewSchema.parse({ runId, materialPath: run.materialPath, title: run.title, candidates, directories: await directories(),
      sourceStatus: bytes ? sourceStatus(bytes) : '未提炼', ...(bytes ? { sourceCurrentSha: sha256Bytes(bytes) } : {}),
      sourceChanged: bytes ? sourceChanged(runId, bytes) : true, complete: candidates.every((item) => item.state !== 'pending'),
      relatedRuns: related.filter((item) => item.id !== runId).slice(0, 200).map((item) => ({ id: item.id, createdAt: item.createdAt, pendingCount: store.list(item.id).filter((c) => c.state === 'pending').length })),
      batches: rows.map((row) => batch(row.id)) });
  }
  function save(runId: string, request: SaveCandidateRequest) {
    requireIdle(); return store.save(runId, saveCandidateRequestSchema.parse(request));
  }
  async function matches(runId: string, candidateId: string, search?: string): Promise<IngestionMatches> {
    store.ensure(runId); const candidate = store.list(runId).find((c) => c.id === candidateId);
    if (!candidate) return fail('CANDIDATE_NOT_FOUND', '没有找到当前候选。', 404);
    const all = []; let page = 1;
    for (;;) {
      const part = input.repository.listKnowledge({ includeObsolete: true, page, pageSize: 200 }); all.push(...part.items);
      if (page * part.pageSize >= part.total || !part.items.length) break; page++;
    }
    const tokens = [...new Set((search || `${candidate.draft.title} ${candidate.draft.draft.keywords.join(' ')}`).toLocaleLowerCase().match(/[a-z0-9]+|[\u3400-\u9fff]{2}/gu) ?? [])];
    const directory = candidate.draft.suggestedPath; const neighbor = directory.slice(0, directory.lastIndexOf('/'));
    return { items: all.flatMap((record) => {
      const haystack = `${record.title} ${Object.values(record.recallFields).flat().join(' ')}`.toLocaleLowerCase();
      const hits = tokens.filter((token) => haystack.includes(token));
      const inDirectory = record.path.startsWith(`${directory}/`); const near = record.path.startsWith(`${neighbor}/`);
      if (search && !hits.length && !haystack.includes(search.toLocaleLowerCase())) return [];
      if (!search && !hits.length && !inDirectory && !near) return [];
      return [{ path: record.path, title: record.title, usageStatus: record.usageStatus, conclusion: record.recallFields.conclusion,
        reason: hits.length ? `标题或召回字段关联：${hits.slice(0, 5).join('、')}` : inDirectory ? '同一知识目录，建议核对是否补充已有知识' : '相邻知识目录，供核对分类边界',
        score: hits.length * 10 + (inDirectory ? 3 : near ? 1 : 0) }];
    }).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 50).map(({ score: _score, ...item }) => item) };
  }
  async function preview(request: IngestionPreviewRequest) {
    return exclusive(async () => {
      const run = store.ensure(request.runId); const local = store.list(run.id); const all = allCandidates(run.materialPath);
      if (canonicalJson(request.versions) !== canonicalJson(local.map(({ id, version }) => ({ id, version })))) fail('VERSION_CONFLICT', '已显示的草稿版本发生变化，请重新读取后预览。');
      if (all.some((c) => c.batchId && c.state === 'pending')) fail('RECOVERY_REQUIRED', '这份资料还有未完成批次，请先完成恢复。');
      const choices = local.filter((c) => c.state === 'pending' && c.decision !== 'later');
      if (!choices.length && local.length) fail('NOTHING_SELECTED', '请选择本次入库或明确放弃的候选。');
      const before = readSource(run.materialPath); const currentSha = sha256Bytes(before);
      if (sourceChanged(run.id, before) && request.acknowledgedSourceSha !== currentSha) fail('SOURCE_CHANGED', '资料已变化，请查看当前原文，核对后再继续。');
      const dirs = await directories(); const rule = await loadRuleBundle(input.gateway);
      const groups = new Map<string, ReviewCandidate[]>();
      for (const c of choices.filter((item) => item.decision === 'keep')) {
        validateDraft(c.draft); assertKnowledgeTitle(c.draft.title);
        if (!dirs.includes(c.draft.suggestedPath)) fail('DIRECTORY_UNAVAILABLE', '请从当前知识目录中选择分类。');
        for (const topic of c.draft.topics) {
          validateFilesystemPath(`${linkTarget(topic)}.md`);
          if (!topic.startsWith('02知识库/') || !port.read(`${linkTarget(topic)}.md`)) fail('TOPIC_NOT_FOUND', '所属主题必须是已存在的知识节点。');
        }
        const originalBody = Buffer.from(parseFrontmatter(before).bodyBytes).toString('utf8');
        if (c.draft.draft.quotes.some((quote) => !originalBody.includes(quote))) fail('QUOTE_NOT_VERIFIED', '原文引用必须能在当前原资料正文中逐字找到；请修改引用或留空。');
        const path = c.target.mode === 'new' ? `${c.draft.suggestedPath}/${c.draft.title}.md` : c.target.path;
        if (!path || !path.startsWith('02知识库/') || !path.endsWith('.md')) fail('TARGET_INVALID', '请选择有效的知识笔记目标。');
        validateFilesystemPath(path);
        const group = groups.get(path) ?? []; group.push(c); groups.set(path, group);
      }
      const files: IngestionPlan['files'] = []; const decisions: IngestionPlan['decisions'] = [];
      for (const [path, group] of groups) {
        assertNotInTrash(path);
        if (new Set(group.map((c) => c.target.mode)).size !== 1) fail('TARGET_CONFLICT', '同一目标的候选请使用一致的新增或合并方式。');
        const existing = port.read(path); const mode = group[0]!.target.mode;
        if (mode === 'new' && existing) fail('TARGET_EXISTS', '这个标题对应的笔记已存在，请选择合并或修改标题。');
        if (mode !== 'new' && !existing) fail('TARGET_NOT_FOUND', '目标笔记已移走，请重新选择。');
        let after = mode === 'new' ? createKnowledgeNote(group[0]!.draft, run.materialPath, calendar(now()))
          : mergeKnowledgeNote(existing!, group.map((c) => c.draft), run.materialPath, calendar(now()), mode, group.every((c) => c.target.confirmLegacySources === true));
        if (mode === 'new' && group.length > 1) after = mergeKnowledgeNote(after, group.slice(1).map((c) => c.draft), run.materialPath, calendar(now()), 'merge');
        files.push({ path, kind: existing ? 'update' : 'new', before: existing?.toString('utf8') ?? null, after: after.toString('utf8'), stageId: randomUUID() });
        decisions.push(...group.map((c) => ({ id: c.id, version: c.version, state: 'committed' as const, path })));
      }
      decisions.push(...choices.filter((c) => c.decision === 'discard').map((c) => ({ id: c.id, version: c.version, state: 'discarded' as const })));
      const resolved = new Set(decisions.map((d) => d.id));
      const pendingCount = all.filter((c) => c.state === 'pending' && !resolved.has(c.id)).length;
      const sourceRecord = parseLibraryNoteForRead(before, run.materialPath).record!;
      const anyIngested = sourceRecord.generatedKnowledge.length > 0 || decisions.some((d) => d.state === 'committed') || all.some((c) => c.state === 'committed');
      const status = anyIngested ? pendingCount || isPartialExtraction(run.sourceRange) ? '部分入库' : '已入库' : '未提炼';
      const afterSource = anyIngested ? patchSource(before, decisions.flatMap((d) => d.path ? [d.path] : []), status) : before;
      if (!before.equals(afterSource)) files.push({ path: run.materialPath, kind: 'source', before: before.toString('utf8'), after: afterSource.toString('utf8'), stageId: randomUUID() });
      const id = randomUUID(); const expiresAt = new Date(now().getTime() + 600_000).toISOString();
      const publicPreview = ingestionPreviewSchema.parse({ id, runId: run.id, expiresAt, files: files.map(({ stageId: _stage, ...file }) => file),
        selectedCount: choices.filter((c) => c.decision === 'keep').length, discardedCount: choices.filter((c) => c.decision === 'discard').length, pendingCount, sourceStatus: status });
      const plan = ingestionPlanSchema.parse({ version: 1, id, journalId: id, runId: run.id, materialPath: run.materialPath, root: port.rootIdentity,
        ruleFingerprint: rule.fingerprint, reviewStamp: stamp(all), sourceBefore: before.toString('utf8'), sourceAfter: afterSource.toString('utf8'), preview: publicPreview, files, decisions });
      db.prepare('INSERT INTO personal_ingestion_previews VALUES (?,?,?,?)').run(id, run.id, expiresAt, JSON.stringify(plan));
      return publicPreview;
    });
  }
  async function refresh(id: string): Promise<IngestionBatch> {
    let indexed = false; try { indexed = await input.refreshIndex(); } catch { /* Disk receipt remains successful. */ }
    db.prepare('UPDATE personal_ingestion_batches SET indexed=? WHERE id=?').run(indexed ? 1 : 0, id); return batch(id);
  }
  function finalize(plan: IngestionPlan): void {
    verifyApplied(plan, port);
    db.transaction(() => {
      for (const decision of plan.decisions) {
        const result = db.prepare("UPDATE personal_candidate_reviews SET state=?,committed_path=?,version=version+1 WHERE id=? AND batch_id=? AND state='pending' AND version=?")
          .run(decision.state, decision.path ?? null, decision.id, plan.id, decision.version);
        if (!result.changes) {
          const c = store.list(plan.runId).find((item) => item.id === decision.id);
          if (!c || c.state !== decision.state || c.batchId !== plan.id) throw new Error('CANDIDATE_FINALIZE_CONFLICT');
        }
      }
      const beforeSha = sha256Bytes(Buffer.from(plan.sourceBefore)); const afterSha = sha256Bytes(Buffer.from(plan.sourceAfter));
      const evidence = sourceEvidenceSha(Buffer.from(plan.sourceAfter));
      db.prepare('UPDATE personal_ingestion_source_heads SET current_raw_sha256=? WHERE material_path=? AND current_raw_sha256=? AND evidence_sha256=?')
        .run(afterSha, plan.materialPath, beforeSha, evidence);
      db.prepare('INSERT INTO personal_ingestion_source_heads VALUES (?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET current_raw_sha256=excluded.current_raw_sha256,evidence_sha256=excluded.evidence_sha256')
        .run(plan.runId, plan.materialPath, afterSha, evidence);
      db.prepare("UPDATE personal_ingestion_batches SET status='committed',problem=NULL WHERE id=?").run(plan.id);
    }).immediate();
  }
  async function execute(id: string): Promise<IngestionBatch> {
    const row = getRow(id);
    if (row.status === 'committed') return row.indexed ? batch(id) : refresh(id);
    const plan = ingestionPlanSchema.parse(JSON.parse(row.plan_json));
    try {
      if ((await loadRuleBundle(input.gateway)).fingerprint !== plan.ruleFingerprint) throw new Error('RULES_CHANGED');
      if (stamp(allCandidates(plan.materialPath)) !== plan.reviewStamp) throw new Error('CANDIDATES_CHANGED');
      if (db.prepare("SELECT id FROM personal_extraction_runs WHERE material_path=? AND status='generating'").get(plan.materialPath)) throw new Error('CANDIDATES_CHANGED');
      assertPlanCoverage(plan);
      assertPlanNotInTrash(plan);
      applyPlan(plan, port); finalize(plan);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      db.prepare("UPDATE personal_ingestion_batches SET status='needs-review',problem=? WHERE id=?")
        .run(code === 'RULES_CHANGED' ? '规则已变化，请核对恢复预览后继续。' : '本批尚未全部完成。已写内容和恢复版本均已保留；可先尝试继续，存在外部变化时请核对恢复预览。', id);
      return batch(id);
    }
    return refresh(id);
  }
  async function commit(id: string): Promise<IngestionBatch> {
    return exclusive(async () => {
      if (db.prepare('SELECT id FROM personal_ingestion_batches WHERE id=?').get(id)) return execute(id);
      const row = db.prepare('SELECT * FROM personal_ingestion_previews WHERE id=?').get(id) as { expires_at: string; plan_json: string } | undefined;
      if (!row || Date.parse(row.expires_at) <= now().getTime()) return fail('PLAN_STALE', '预览已过期，请重新预览后确认。');
      const plan = ingestionPlanSchema.parse(JSON.parse(row.plan_json));
      assertPlanCoverage(plan);
      if ((await loadRuleBundle(input.gateway)).fingerprint !== plan.ruleFingerprint || stamp(allCandidates(plan.materialPath)) !== plan.reviewStamp) return fail('PLAN_STALE', '规则或候选已变化，请返回更新预览。');
      if (db.prepare("SELECT id FROM personal_extraction_runs WHERE material_path=? AND status='generating'").get(plan.materialPath)) return fail('RUN_ALREADY_ACTIVE', '这份资料仍在提炼，请等待或停止提炼后再确认入库。');
      assertPlanNotInTrash(plan);
      assertPlanUnchanged(plan, port);
      assertNoOverlappingBatch(plan);
      db.transaction(() => {
        db.prepare("INSERT INTO personal_ingestion_batches VALUES (?,?,?,'writing',0,?,NULL)").run(id, plan.runId, now().toISOString(), JSON.stringify(plan));
        for (const decision of plan.decisions) {
          const locked = db.prepare("UPDATE personal_candidate_reviews SET batch_id=? WHERE id=? AND version=? AND state='pending' AND batch_id IS NULL").run(id, decision.id, decision.version);
          if (!locked.changes) throw new Error('CANDIDATE_BIND_CONFLICT');
        }
      }).immediate();
      return execute(id);
    });
  }
  async function resume(id: string) { return exclusive(() => execute(id)); }
  async function recoveryPreview(id: string, requestedChoice?: 'current' | 'preserved', newTargets: Record<string, string> = {}): Promise<IngestionRecoveryPreview> {
    return exclusive(async () => {
      const row = getRow(id); if (row.status === 'committed') return fail('BATCH_COMMITTED', '本批已经完成，不需要恢复文件。');
      const original = ingestionPlanSchema.parse(JSON.parse(row.plan_json));
      assertPlanNotInTrash(original);
      const currentSource = readSource(original.materialPath);
      // A resolved plan gets fresh write stages. Keep the old stages in its read
      // set so a later preview can still find evidence changed through an old FD.
      const observed = (original.recoveryReadSet ?? []).map((read) => {
        const bytes = port.readRecovery(`${read.stageId}.stage.md`);
        const expectedSha256 = bytes === null ? null : sha256Bytes(bytes);
        return { read: { ...read, expectedSha256 }, bytes, changed: expectedSha256 !== read.expectedSha256 };
      });
      for (const file of original.files) {
        const bytes = port.readRecovery(`${file.stageId}.stage.md`);
        observed.push({ read: { path: file.path, stageId: file.stageId, expectedSha256: bytes === null ? null : sha256Bytes(bytes),
          beforeSha256: file.before === null ? null : sha256Bytes(Buffer.from(file.before)), afterSha256: sha256Bytes(Buffer.from(file.after)) }, bytes, changed: false });
      }
      const preserved = (path: string): Buffer | undefined => {
        const versions = observed.filter(({ read, bytes, changed }) => read.path === path && bytes !== null
          && (changed || (read.expectedSha256 !== read.beforeSha256 && read.expectedSha256 !== read.afterSha256)));
        return (versions.filter((version) => version.changed).at(-1) ?? versions.at(-1))?.bytes ?? undefined;
      };
      const preservedSource = preserved(original.materialPath);
      const choice = requestedChoice ?? (preservedSource ? 'preserved' : 'current');
      if (choice === 'preserved' && !preservedSource) return fail('RECOVERY_VERSION_MISSING', '没有找到可用的保留原文，请重新核对当前文件。');
      const evidence = choice === 'preserved' ? preservedSource! : currentSource;
      if (!parseLibraryNoteForRead(evidence, original.materialPath).record) return fail('RECOVERY_SOURCE_INVALID', '保留原文格式无法确认，未修改文件。');
      const knowledgeFiles = original.files.filter((f) => f.kind !== 'source');
      if (Object.keys(newTargets).some((path) => !knowledgeFiles.some((file) => file.path === path))) return fail('TARGET_INVALID', '只能调整本批已有的知识目标。');
      const dirs = await directories();
      const candidates = allCandidates(original.materialPath);
      const decisions = original.decisions.map((decision) => decision.path && Object.hasOwn(newTargets, decision.path) ? { ...decision, path: newTargets[decision.path]! } : decision);
      const restoredWithoutSource: string[] = [];
      const files: IngestionPlan['files'] = knowledgeFiles.flatMap((file) => {
        const current = port.read(file.path); const backup = preserved(file.path);
        const alternative = Object.hasOwn(newTargets, file.path) ? newTargets[file.path] : undefined;
        if (alternative) {
          validateFilesystemPath(alternative);
          const directory = alternative.slice(0, alternative.lastIndexOf('/')); const title = alternative.slice(alternative.lastIndexOf('/') + 1, -3);
          if (!alternative.startsWith('02知识库/') || !alternative.endsWith('.md') || !dirs.includes(directory)) return fail('TARGET_INVALID', '新笔记必须放在当前已存在的知识目录。');
          assertKnowledgeTitle(title);
          assertNotInTrash(alternative);
          if (alternative === file.path || port.read(alternative)) return fail('TARGET_EXISTS', '新标题对应的笔记已存在，请换一个标题。');
          const ids = original.decisions.filter((decision) => decision.path === file.path).map((decision) => decision.id);
          const selected = ids.map((candidateId) => candidates.find((c) => c.id === candidateId));
          if (!selected.length || selected.some((item) => !item)) return fail('CANDIDATE_NOT_FOUND', '本批草稿无法核对，未修改文件。');
          const drafts = selected.map((item) => item!.draft);
          drafts.forEach(validateDraft);
          let after = createKnowledgeNote({ ...drafts[0]!, title, suggestedPath: directory }, original.materialPath, calendar(now()));
          if (drafts.length > 1) after = mergeKnowledgeNote(after, drafts.slice(1), original.materialPath, calendar(now()), 'merge');
          const replacements: IngestionPlan['files'] = [];
          if (backup && current?.equals(Buffer.from(file.after))) {
            const record = parseKnowledgeNote(backup, file.path).record;
            if (!record) return fail('RECOVERY_TARGET_INVALID', '保留的知识版本格式无法核对，未覆盖当前文件。');
            if (!record.sourceMaterials.map(linkTarget).includes(linkTarget(original.materialPath))) restoredWithoutSource.push(linkTarget(file.path));
            replacements.push({ path: file.path, kind: 'update', before: current.toString('utf8'), after: backup.toString('utf8'), preserved: backup.toString('utf8'), stageId: randomUUID() });
          }
          replacements.push({ path: alternative, kind: 'new', before: null, after: after.toString('utf8'), stageId: randomUUID() });
          return replacements;
        }
        // This file is an explicitly approved restoration, not a candidate merge.
        // An ancestor stage may have advanced before that restoration could run.
        const restoringPreserved = original.journalId !== original.id && file.preserved !== undefined && file.after === file.preserved
          && !original.decisions.some((decision) => decision.path === file.path);
        if (restoringPreserved && (bytesEqual(current, file.before) || bytesEqual(current, file.after))) {
          const after = backup ?? Buffer.from(file.after);
          const record = parseKnowledgeNote(after, file.path).record;
          if (!record) return fail('RECOVERY_TARGET_INVALID', '保留的知识版本格式无法核对，未覆盖当前文件。');
          if (!record.sourceMaterials.map(linkTarget).includes(linkTarget(original.materialPath))) restoredWithoutSource.push(linkTarget(file.path));
          return [{ ...file, before: current?.toString('utf8') ?? null, after: after.toString('utf8'), preserved: after.toString('utf8'),
            kind: current ? 'update' as const : 'new' as const, stageId: randomUUID() }];
        }
        // A generic recovery confirmation is not permission to downgrade a note the user has since protected.
        const changed = current && !bytesEqual(current, file.before) && !bytesEqual(current, file.after) ? current : undefined;
        if ([changed, backup].some((bytes) => bytes && ['定论', '已优化', '过时'].includes(String(parseFrontmatter(bytes).data.使用状态)))) {
          return fail('RECOVERY_TARGET_PROTECTED', '目标或保留版本的使用状态已变化，不能覆盖。请展开“冲突笔记改为新建”，填写新标题；旧文件将保持不动。');
        }
        return [{ ...file, before: current?.toString('utf8') ?? null, kind: current ? 'update' as const : 'new' as const,
          ...(backup ? { preserved: backup.toString('utf8') } : {}), stageId: randomUUID() }];
      });
      if (new Set(files.map((file) => file.path)).size !== files.length) return fail('TARGET_CONFLICT', '本批不同笔记的新标题不能指向同一个文件。');
      const resolved = new Set(decisions.map((d) => d.id));
      const pendingCount = candidates.filter((c) => c.state === 'pending' && !resolved.has(c.id)).length;
      const anyIngested = parseLibraryNoteForRead(evidence).record!.generatedKnowledge.length > 0 || decisions.some((d) => d.state === 'committed') || candidates.some((c) => c.state === 'committed');
      const status = anyIngested ? pendingCount || isPartialExtraction(store.run(original.runId).sourceRange) ? '部分入库' : '已入库' : '未提炼';
      let sourceBase = evidence;
      if (restoredWithoutSource.length) {
        const previousLinks = normalizeWikiLinkList(parseFrontmatter(Buffer.from(original.sourceBefore)).data.生成知识 as string[] ?? []).map(linkTarget);
        const currentLinks = parseFrontmatter(evidence).data.生成知识 as string[] ?? [];
        sourceBase = patchFrontmatter(evidence, { 生成知识: currentLinks.filter((link) => {
          const target = linkTarget(normalizeWikiLinkList([link])[0]!);
          return !restoredWithoutSource.includes(target) || previousLinks.includes(target);
        }) });
      }
      const sourceAfter = anyIngested ? patchSource(sourceBase, decisions.flatMap((d) => d.path ? [d.path] : []), status) : sourceBase;
      const sourceFile = { path: original.materialPath, kind: 'source' as const, before: currentSource.toString('utf8'), after: sourceAfter.toString('utf8'),
        ...(preservedSource ? { preserved: preservedSource.toString('utf8') } : {}), stageId: randomUUID() };
      const plan = ingestionPlanSchema.parse({ ...original, journalId: randomUUID(), sourceBefore: currentSource.toString('utf8'), sourceAfter: sourceAfter.toString('utf8'),
        sourceEvidenceBefore: evidence.toString('utf8'), decisions, reviewStamp: stamp(candidates),
        recoveryReadSet: observed.map(({ read }) => read),
        preview: { ...original.preview, pendingCount, sourceStatus: status },
        ruleFingerprint: (await loadRuleBundle(input.gateway)).fingerprint, files: currentSource.equals(sourceAfter) ? files : [...files, sourceFile] });
      assertNoOverlappingBatch(plan);
      assertPlanNotInTrash(plan);
      const token = randomUUID(); const expiresAt = new Date(now().getTime() + 600_000).toISOString();
      for (const [key, value] of recoveryPreviews) if (Date.parse(value.expiresAt) <= now().getTime()) recoveryPreviews.delete(key);
      if (recoveryPreviews.size >= 20) recoveryPreviews.delete(recoveryPreviews.keys().next().value!);
      recoveryPreviews.set(token, { plan, basePlanSha: sha256Bytes(Buffer.from(row.plan_json)), expiresAt });
      return { id: token, batchId: id, expiresAt, files: plan.files.map(({ stageId: _stage, ...file }) => file), sourceChoice: choice, hasPreservedSource: preservedSource !== undefined };
    });
  }
  async function resolve(id: string): Promise<IngestionBatch> {
    return exclusive(async () => {
      const completedResolution = db.prepare('SELECT plan_json FROM personal_ingestion_previews WHERE id=?').get(id) as { plan_json: string } | undefined;
      if (completedResolution) {
        const record = JSON.parse(completedResolution.plan_json) as { kind?: string; batchId?: string };
        if (record.kind === 'resolution' && record.batchId) return batch(record.batchId);
      }
      const saved = recoveryPreviews.get(id);
      if (!saved || Date.parse(saved.expiresAt) <= now().getTime()) return fail('PLAN_STALE', '恢复预览已过期，请重新核对。');
      const row = getRow(saved.plan.id);
      if (row.status === 'committed') return batch(row.id);
      if (sha256Bytes(Buffer.from(row.plan_json)) !== saved.basePlanSha) return fail('PLAN_STALE', '恢复状态已变化，请重新核对。');
      assertPlanUnchanged(saved.plan, port);
      if (stamp(allCandidates(saved.plan.materialPath)) !== saved.plan.reviewStamp) return fail('PLAN_STALE', '候选已变化，请重新核对恢复预览。');
      if ((await loadRuleBundle(input.gateway)).fingerprint !== saved.plan.ruleFingerprint) return fail('PLAN_STALE', '规则已变化，请重新核对恢复预览。');
      assertNoOverlappingBatch(saved.plan);
      assertPlanNotInTrash(saved.plan);
      persistPlan(saved.plan, port);
      db.transaction(() => {
        db.prepare("UPDATE personal_ingestion_batches SET plan_json=?,status='writing',problem=NULL WHERE id=?").run(JSON.stringify(saved.plan), saved.plan.id);
        db.prepare('INSERT INTO personal_ingestion_previews VALUES (?,?,?,?)').run(id, saved.plan.runId, saved.expiresAt, JSON.stringify({ kind: 'resolution', batchId: saved.plan.id }));
      }).immediate();
      recoveryPreviews.delete(id); return execute(saved.plan.id);
    });
  }
  async function recover(): Promise<void> {
    const rows = db.prepare("SELECT id FROM personal_ingestion_batches WHERE status!='committed' ORDER BY created_at,rowid").all() as { id: string }[];
    for (const row of rows) await resume(row.id);
  }
  async function close(): Promise<void> { closed = true; try { await running; } catch { /* Persistent batch is resumed on next launch. */ } }
  return { review, save, matches, preview, commit, batch, resume, recoveryPreview, resolve, recover, close };
}
export type IngestionService = ReturnType<typeof createIngestionService>;
