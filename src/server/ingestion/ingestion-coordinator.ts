import { z } from 'zod';
import type { PersonalIngestionPort } from './ingestion-native.js';
import { ingestionFileSchema, ingestionPreviewSchema } from '../../shared/api/ingestion.js';
import { sha256Bytes } from '../vault/raw-bytes.js';
import { parseFrontmatter } from '../rules/frontmatter.js';
import { parseKnowledgeNote } from '../rules/knowledge-schema.js';
import { sourceEvidenceSha, linkTarget } from './note-format.js';
import { normalizeWikiLinkList } from '../rules/wikilinks.js';
import { PublicApiError } from '../../shared/api/errors.js';
import { validateFilesystemPath } from '../vault/filesystem-path.js';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const ingestionPlanSchema = z.strictObject({
  version: z.literal(1), id: z.uuid(), journalId: z.uuid(), runId: z.uuid(), materialPath: z.string().max(1024),
  root: z.strictObject({ dev: z.string(), ino: z.string() }), ruleFingerprint: z.string(), reviewStamp: z.string(),
  sourceBefore: z.string().max(500_000), sourceAfter: z.string().max(500_000),
  sourceEvidenceBefore: z.string().max(500_000).optional(),
  recoveryReadSet: z.array(z.strictObject({
    path: z.string().max(1024), stageId: z.uuid(), expectedSha256: sha256Schema.nullable(),
    beforeSha256: sha256Schema.nullable(), afterSha256: sha256Schema
  })).max(10_000).optional(),
  preview: ingestionPreviewSchema,
  files: z.array(ingestionFileSchema.extend({ stageId: z.uuid() })).max(25),
  decisions: z.array(z.strictObject({ id: z.string(), version: z.number().int().positive(), state: z.enum(['committed', 'discarded']), path: z.string().optional() })).max(12)
});
export type IngestionPlan = z.infer<typeof ingestionPlanSchema>;
const same = (current: Buffer | null, expected: string | null) => expected === null ? current === null : current?.equals(Buffer.from(expected)) === true;

export function validatePlan(plan: IngestionPlan, port: PersonalIngestionPort): void {
  ingestionPlanSchema.parse(plan);
  if (plan.root.dev !== port.rootIdentity.dev || plan.root.ino !== port.rootIdentity.ino
    || plan.id !== plan.preview.id || plan.runId !== plan.preview.runId) throw new Error('PLAN_IDENTITY_CHANGED');
  validateFilesystemPath(plan.materialPath);
  if (!/^01图书馆\/来自[^/]+\/.+\.md$/u.test(plan.materialPath)) throw new Error('SOURCE_PATH_INVALID');
  if (plan.sourceEvidenceBefore !== undefined && plan.journalId === plan.id) throw new Error('RECOVERY_APPROVAL_REQUIRED');
  if (plan.recoveryReadSet?.length && plan.journalId === plan.id) throw new Error('RECOVERY_APPROVAL_REQUIRED');
  const stageIds = new Set(plan.files.map((file) => file.stageId));
  for (const read of plan.recoveryReadSet ?? []) {
    validateFilesystemPath(read.path);
    if (stageIds.has(read.stageId) || (read.path !== plan.materialPath && (!read.path.startsWith('02知识库/') || !read.path.endsWith('.md')))) throw new Error('RECOVERY_READ_SET_INVALID');
    stageIds.add(read.stageId);
  }
  if (sourceEvidenceSha(Buffer.from(plan.sourceEvidenceBefore ?? plan.sourceBefore)) !== sourceEvidenceSha(Buffer.from(plan.sourceAfter))) throw new Error('SOURCE_BODY_CHANGED');
  const paths = new Set<string>(); let sourceSeen = false;
  for (const file of plan.files) {
    validateFilesystemPath(file.path);
    if (paths.has(file.path) || sourceSeen) throw new Error('PLAN_ORDER_INVALID'); paths.add(file.path);
    if (file.kind === 'source') {
      if (file.path !== plan.materialPath || file.before !== plan.sourceBefore || file.after !== plan.sourceAfter) throw new Error('SOURCE_PLAN_INVALID');
      sourceSeen = true;
    } else {
      if (!file.path.startsWith('02知识库/') || !file.path.endsWith('.md') || (file.kind === 'new') !== (file.before === null)) throw new Error('KNOWLEDGE_PATH_INVALID');
      const record = parseKnowledgeNote(Buffer.from(file.after), file.path).record;
      const restoringPreserved = plan.journalId !== plan.id && file.preserved !== undefined && file.after === file.preserved
        && !plan.decisions.some((decision) => decision.path === file.path);
      if (!record || (!restoringPreserved && !record.sourceMaterials.map(linkTarget).includes(linkTarget(plan.materialPath)))) throw new Error('KNOWLEDGE_LINK_INVALID');
    }
  }
  const source = parseFrontmatter(Buffer.from(plan.sourceAfter)).data;
  const links = normalizeWikiLinkList(source.生成知识 as string[] ?? []).map(linkTarget);
  for (const decision of plan.decisions) if (decision.state === 'committed' && (!decision.path || !links.includes(linkTarget(decision.path)))) throw new Error('SOURCE_LINK_INVALID');
  if (source.知识入库状态 !== plan.preview.sourceStatus) throw new Error('SOURCE_STATUS_INVALID');
}

function putOnce(port: PersonalIngestionPort, name: string, bytes: Buffer): void {
  const prior = port.readRecovery(name);
  if (prior) { if (!prior.equals(bytes)) throw new Error('RECOVERY_RECORD_CHANGED'); return; }
  port.writeRecovery(name, bytes);
  if (!port.readRecovery(name)?.equals(bytes)) throw new Error('RECOVERY_RECORD_INVALID');
}
export function persistPlan(plan: IngestionPlan, port: PersonalIngestionPort): void {
  validatePlan(plan, port);
  const json = JSON.stringify(plan);
  // The immutable manifest contains every before/after image before any vault mutation.
  putOnce(port, `${plan.journalId}.intent.json`, Buffer.from(JSON.stringify({ plan, sha256: sha256Bytes(Buffer.from(json)) })));
}

export function assertPlanUnchanged(plan: IngestionPlan, port: PersonalIngestionPort): void {
  if (!same(port.read(plan.materialPath), plan.sourceBefore)) throw new PublicApiError('PLAN_STALE', '原资料已变化，请返回更新预览。', 409);
  for (const file of plan.files) if (!same(port.read(file.path), file.before)) throw new PublicApiError('PLAN_STALE', '目标笔记已变化，请返回比较后更新预览。', 409);
  try { verifyRecoveryReadSet(plan, port); }
  catch { throw new PublicApiError('PLAN_STALE', '恢复预览中的保留版本已变化，请重新核对恢复预览。', 409); }
}

function verifyRecoveryReadSet(plan: IngestionPlan, port: PersonalIngestionPort): void {
  for (const read of plan.recoveryReadSet ?? []) {
    const bytes = port.readRecovery(`${read.stageId}.stage.md`);
    if ((bytes === null ? null : sha256Bytes(bytes)) !== read.expectedSha256) throw new Error('RECOVERY_EVIDENCE_CHANGED');
  }
}

function verifyPreservedVersion(file: IngestionPlan['files'][number], port: PersonalIngestionPort): void {
  // Recovery previews allocate fresh stage IDs even for files already equal to
  // the approved after image. Such no-op files never create or exchange a stage.
  if (file.before === file.after) return;
  const preserved = port.readRecovery(`${file.stageId}.stage.md`);
  // Exclusive creation consumes its stage; an update keeps the displaced before
  // image. Missing, changed or unexpectedly recreated evidence is never success.
  if (file.before === null ? preserved !== null : !preserved?.equals(Buffer.from(file.before))) throw new Error('PRESERVED_VERSION_CHANGED');
}

export function applyPlan(plan: IngestionPlan, port: PersonalIngestionPort): void {
  validatePlan(plan, port); verifyRecoveryReadSet(plan, port); persistPlan(plan, port);
  // Detect all currently unknown files before advancing the next step.
  for (const file of plan.files) {
    const current = port.read(file.path);
    if (!same(current, file.before) && !same(current, file.after)) throw new Error('EXTERNAL_CHANGE');
  }
  if (!plan.files.some((file) => file.kind === 'source') && !same(port.read(plan.materialPath), plan.sourceBefore)) throw new Error('EXTERNAL_SOURCE_CHANGE');
  for (const file of plan.files) {
    verifyRecoveryReadSet(plan, port);
    const current = port.read(file.path);
    if (same(current, file.after)) {
      // A post-swap conflict may leave the expected bytes at the destination but
      // an unexpected, externally edited version in recovery. Do not silently
      // call that success on restart merely because the destination matches.
      verifyPreservedVersion(file, port);
      continue;
    }
    if (!same(current, file.before)) throw new Error('EXTERNAL_CHANGE');
    const stage = `${file.stageId}.stage.md`;
    putOnce(port, stage, Buffer.from(file.after));
    port.apply(file.path, stage, file.before === null ? null : Buffer.from(file.before), Buffer.from(file.after));
  }
  verifyApplied(plan, port);
  putOnce(port, `${plan.journalId}.result.json`, Buffer.from(JSON.stringify({ version: 1, id: plan.id, journalId: plan.journalId, planSha256: sha256Bytes(Buffer.from(JSON.stringify(plan))) })));
}
export function verifyApplied(plan: IngestionPlan, port: PersonalIngestionPort): void {
  for (const file of plan.files) {
    if (!same(port.read(file.path), file.after)) throw new Error('WRITE_VERIFY_FAILED');
    // Recheck every retained version after all writes, including versions from
    // early steps that could change while a later file was being applied.
    verifyPreservedVersion(file, port);
  }
  if (!same(port.read(plan.materialPath), plan.sourceAfter)) throw new Error('SOURCE_VERIFY_FAILED');
  verifyRecoveryReadSet(plan, port);
  validatePlan(plan, port);
}
