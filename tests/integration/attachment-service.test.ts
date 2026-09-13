import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAttachmentService } from '../../src/server/attachments/service.js';
import { createTextPdf, createPasswordPdf, createChinesePdf } from '../helpers/pdf-fixture.js';
import { createPersonalIntakeFixture } from '../helpers/personal-intake-fixture.js';
import { openPersonalArchive } from '../../src/server/archive/sandbox-native.js';
import { createIntakeService } from '../../src/server/services/intake-service.js';
import { readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseLibraryNote } from '../../src/server/rules/library-schema.js';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'xiaozhao-attachments-test-')); const directory = join(parent, 'attachments');
  cleanups.push(() => rm(parent, { recursive: true }));
  const service = createAttachmentService({ directory }); await service.ready(); cleanups.push(() => service.close());
  return { service, directory, upload: (name: string, bytes: Buffer, uploadId = randomUUID(), groupId = randomUUID()) => service.upload({ name, bytes, uploadId, groupId }) };
}
it('persists exact TXT original and parsed text across restart, without archiving it', async () => {
  const f = await fixture(); const bytes = Buffer.from('\uFEFF中文\r\n第二行'); const item = await f.upload('笔记.txt', bytes);
  await f.service.waitForParsing(item.id); expect(f.service.get(item.id).status).toBe('ready');
  expect(f.service.readOriginal(item.id).bytes).toEqual(bytes); expect(f.service.readPages({ id: item.id }).pages[0]?.text).toContain('中文\r\n第二行');
  expect(f.service.get(item.id).archive).toBeUndefined(); await f.service.close();
  const reopened = createAttachmentService({ directory: f.directory }); await reopened.ready(); cleanups.push(() => reopened.close());
  expect(reopened.readOriginal(item.id).bytes).toEqual(bytes); expect(reopened.get(item.id).status).toBe('ready');
});
it('extracts real PDF pages locally and reports the exact selected range', async () => {
  const f = await fixture(); const item = await f.upload('paper.pdf', createTextPdf(['FIRST PAGE', 'SECOND PAGE'])); await f.service.waitForParsing(item.id);
  expect(f.service.get(item.id)).toMatchObject({ status: 'ready', pageCount: 2 });
  expect(f.service.readPages({ id: item.id, startPage: 2, endPage: 2 })).toMatchObject({ startPage: 2, endPage: 2, totalPages: 2, truncated: false, pages: [{ page: 2, text: 'SECOND PAGE' }] });
});
it('reads Chinese text that requires the bundled predefined CMaps', async () => {
  const f = await fixture(), item = await f.upload('中文.pdf', createChinesePdf()); await f.service.waitForParsing(item.id);
  expect(f.service.get(item.id).status).toBe('ready'); expect(f.service.readPages({ id: item.id }).pages[0]?.text).toBe('中文');
});
it('distinguishes a PDF with no text from a corrupt PDF', async () => {
  const f = await fixture(); const scan = await f.upload('scan.pdf', createTextPdf([''])); const corrupt = await f.upload('broken.pdf', Buffer.from('%PDF-1.4\nbroken'));
  await Promise.all([f.service.waitForParsing(scan.id), f.service.waitForParsing(corrupt.id)]);
  expect(f.service.get(scan.id).status).toBe('needs-ocr'); expect(f.service.get(corrupt.id).status).toBe('failed');
  expect(f.service.readOriginal(corrupt.id).bytes).toEqual(Buffer.from('%PDF-1.4\nbroken'));
});
it('reuses upload IDs but rejects changed bytes and enforces a batch total', async () => {
  const f = await fixture(); const uploadId = randomUUID(), groupId = randomUUID();
  const first = await f.upload('a.txt', Buffer.from('one'), uploadId, groupId); expect((await f.upload('a.txt', Buffer.from('one'), uploadId, groupId)).id).toBe(first.id);
  await expect(f.upload('a.txt', Buffer.from('two'), uploadId, groupId)).rejects.toThrow();
  await f.upload('large.txt', Buffer.alloc(9 * 1024 * 1024, 65), randomUUID(), groupId);
  await expect(f.upload('other.txt', Buffer.alloc(8 * 1024 * 1024, 65), randomUUID(), groupId)).rejects.toThrow('16 MiB');
  await expect(f.upload('../outside.txt', Buffer.from('x'))).rejects.toThrow();
});
it('cancels a parse without removing the original and can retry explicitly', async () => {
  const f = await fixture(); const item = await f.upload('a.pdf', createTextPdf()); f.service.cancel(item.id); await f.service.waitForParsing(item.id);
  expect(f.service.get(item.id).status).toBe('cancelled'); expect(f.service.readOriginal(item.id).bytes).toEqual(createTextPdf());
  await f.service.retry(item.id); await f.service.waitForParsing(item.id); expect(f.service.get(item.id).status).toBe('ready');
});
it('reports password protection separately and preserves the encrypted PDF', async () => {
  const f = await fixture(), bytes = createPasswordPdf(), item = await f.upload('locked.pdf', bytes); await f.service.waitForParsing(item.id);
  expect(f.service.get(item.id)).toMatchObject({ status: 'encrypted', problem: expect.stringContaining('密码') }); expect(f.service.readOriginal(item.id).bytes).toEqual(bytes);
});
it('resumes a parse interrupted by closing the service and retains its stable upload ID', async () => {
  const f = await fixture(), item = await f.upload('resume.pdf', createTextPdf()); await f.service.close();
  const reopened = createAttachmentService({ directory: f.directory }); cleanups.push(() => reopened.close()); await reopened.ready(); await reopened.waitForParsing(item.id);
  expect(reopened.get(item.id).status).toBe('ready'); expect(reopened.list().map(item => item.id)).toEqual([item.id]);
});
it('archives a real PDF through native intake, preserves pages and reuses the operation after reopening', async () => {
  const f = await fixture(), vault = createPersonalIntakeFixture(); cleanups.push(async () => vault.cleanup());
  const port = openPersonalArchive(vault.root, vault.recovery, resolve('dist/native/personal-archive.node')); cleanups.push(async () => port.close());
  const intakeService = createIntakeService({ port, ruleFingerprint: 'a'.repeat(64), getRuleFingerprint: async () => 'a'.repeat(64), refreshIndex: async () => true });
  await f.service.close();
  const service = createAttachmentService({ directory: f.directory, archive: { port, intakeService } }); await service.ready(); cleanups.push(() => service.close());
  const pdf = createTextPdf(['ARCHIVED FIRST', 'ARCHIVED SECOND']); const uploaded = await service.upload({ name: 'source.pdf', bytes: pdf, uploadId: randomUUID(), groupId: randomUUID() }); await service.waitForParsing(uploaded.id);
  const result = await service.archive({ id: uploaded.id }); expect(result.state).toBe('archived');
  const markdown = readFileSync(join(vault.root, result.materialPath));
  expect(parseLibraryNote(markdown, result.materialPath).record).toMatchObject({ processingStatus: '已归档', knowledgeStatus: '未提炼' });
  expect(markdown.toString()).toContain(`<!-- xiaozhao-page:${uploaded.sha256}:2 -->`);
  expect(readFileSync(join(vault.root, result.target, '附件/原件.pdf'))).toEqual(pdf);
  const journals = port.listRecovery(); expect((await service.archive({ id: uploaded.id })).operationId).toBe(result.operationId);
  await service.close(); const reopened = createAttachmentService({ directory: f.directory, archive: { port, intakeService } }); await reopened.ready(); cleanups.push(() => reopened.close());
  expect((await reopened.archive({ id: uploaded.id })).operationId).toBe(result.operationId); expect(port.listRecovery()).toEqual(journals);
  const duplicate = await reopened.upload({ name: 'a second name.pdf', bytes: pdf, uploadId: randomUUID(), groupId: randomUUID() }); await reopened.waitForParsing(duplicate.id);
  expect(await reopened.archive({ id: duplicate.id })).toMatchObject({ operationId: result.operationId, materialPath: result.materialPath, duplicate: true }); expect(port.listRecovery()).toEqual(journals);
  const revisedPdf = createTextPdf(['DIFFERENT CONTENT']), revised = await reopened.upload({ name: 'source.pdf', bytes: revisedPdf, uploadId: randomUUID(), groupId: randomUUID() }); await reopened.waitForParsing(revised.id);
  const revision = await reopened.archive({ id: revised.id }); expect(revision.state).toBe('archived'); expect(revision.target).not.toBe(result.target); expect(revision.target).toContain(revised.sha256.slice(0, 8));
  expect(readFileSync(join(vault.root, result.target, '附件/原件.pdf'))).toEqual(pdf); expect(readFileSync(join(vault.root, revision.target, '附件/原件.pdf'))).toEqual(revisedPdf);
  const afterVersionJournals = port.listRecovery();
  const explicit = await reopened.upload({ name: 'explicit.pdf', bytes: createTextPdf(['EXPLICIT']), uploadId: randomUUID(), groupId: randomUUID() }); await reopened.waitForParsing(explicit.id);
  await expect(reopened.archive({ id: explicit.id, fields: { title: 'source' } })).rejects.toThrow('修改标题');
  expect(port.stat(`01图书馆/小兆clipper/${explicit.id}`)).toBeNull(); expect(port.listRecovery()).toEqual(afterVersionJournals);
  unlinkSync(join(vault.root, result.target, '附件/原件.pdf'));
  await expect(reopened.archive({ id: uploaded.id })).rejects.toThrow('原件');
  const missingOriginalCopy = await reopened.upload({ name: 'third.pdf', bytes: pdf, uploadId: randomUUID(), groupId: randomUUID() }); await reopened.waitForParsing(missingOriginalCopy.id);
  await expect(reopened.archive({ id: missingOriginalCopy.id })).rejects.toThrow('原件'); expect(port.listRecovery()).toEqual(afterVersionJournals);
});
it('retains uploaded Markdown bytes and its source metadata when creating the derived archive note', async () => {
  const f = await fixture(), vault = createPersonalIntakeFixture(); cleanups.push(async () => vault.cleanup());
  const port = openPersonalArchive(vault.root, vault.recovery, resolve('dist/native/personal-archive.node')); cleanups.push(async () => port.close());
  const intakeService = createIntakeService({ port, ruleFingerprint: 'a'.repeat(64), getRuleFingerprint: async () => 'a'.repeat(64), refreshIndex: async () => true });
  await f.service.close(); const service = createAttachmentService({ directory: f.directory, archive: { port, intakeService } }); cleanups.push(() => service.close());
  const bytes = Buffer.from('\uFEFF---\r\ntitle: 原始标题\r\nauthor: 原始作者\r\nsource: https://example.test/article\r\nclipped: 2026-08-01\r\n---\r\n原始正文\r\n');
  const uploaded = await service.upload({ name: 'document.md', bytes, uploadId: randomUUID(), groupId: randomUUID() }); await service.waitForParsing(uploaded.id);
  const result = await service.archive({ id: uploaded.id }); expect(result.state).toBe('archived');
  expect(readFileSync(join(vault.root, result.target, '附件/原件.md'))).toEqual(bytes);
  const note = readFileSync(join(vault.root, result.materialPath), 'utf8'); expect(note).toContain('原始作者'); expect(note).toContain('https://example.test/article'); expect(note).toContain('原始标题'); expect(note).toContain(`<!-- xiaozhao-page:${uploaded.sha256}:1 -->`);
});
it('recovers the existing intake operation when the archive result is lost before its receipt', async () => {
  const f = await fixture(), vault = createPersonalIntakeFixture(); cleanups.push(async () => vault.cleanup());
  const port = openPersonalArchive(vault.root, vault.recovery, resolve('dist/native/personal-archive.node')); cleanups.push(async () => port.close());
  const intakeService = createIntakeService({ port, ruleFingerprint: 'a'.repeat(64), getRuleFingerprint: async () => 'a'.repeat(64), refreshIndex: async () => true });
  await f.service.close();
  const service = createAttachmentService({ directory: f.directory, archive: { port, intakeService: { ...intakeService, commit: async (token, signal) => { await intakeService.commit(token, signal); throw Error('simulated response loss'); } } } }); cleanups.push(() => service.close());
  const uploaded = await service.upload({ name: 'lost.txt', bytes: Buffer.from('KEPT ORIGINAL'), uploadId: randomUUID(), groupId: randomUUID() }); await service.waitForParsing(uploaded.id);
  await expect(service.archive({ id: uploaded.id })).rejects.toThrow('simulated response loss'); const journals = port.listRecovery(); expect(journals.length).toBeGreaterThan(0); await service.close();
  const reopened = createAttachmentService({ directory: f.directory, archive: { port, intakeService } }); cleanups.push(() => reopened.close()); await reopened.ready();
  const result = await reopened.archive({ id: uploaded.id }); expect(result.state).toBe('archived'); expect(port.listRecovery()).toEqual(journals);
  expect(readFileSync(join(vault.root, result.target, '附件/原件.txt'), 'utf8')).toBe('KEPT ORIGINAL');
});
it('does not begin an intake transaction if stopped while commit awaits the current rules', async () => {
  const f = await fixture(), vault = createPersonalIntakeFixture(); cleanups.push(async () => vault.cleanup());
  const port = openPersonalArchive(vault.root, vault.recovery, resolve('dist/native/personal-archive.node')); cleanups.push(async () => port.close());
  let rulesCalls = 0, release!: () => void, reached!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; }), inCommit = new Promise<void>(resolve => { reached = resolve; });
  const intakeService = createIntakeService({ port, ruleFingerprint: 'a'.repeat(64), getRuleFingerprint: async () => { if (++rulesCalls === 2) { reached(); await blocked; } return 'a'.repeat(64); }, refreshIndex: async () => true });
  await f.service.close(); const service = createAttachmentService({ directory: f.directory, archive: { port, intakeService } }); cleanups.push(() => service.close());
  const uploaded = await service.upload({ name: 'stop.txt', bytes: Buffer.from('KEPT'), uploadId: randomUUID(), groupId: randomUUID() }); await service.waitForParsing(uploaded.id);
  const controller = new AbortController(), pending = service.archive({ id: uploaded.id }, controller.signal); await inCommit; controller.abort(); release(); await expect(pending).rejects.toThrow();
  expect(port.listRecovery()).toEqual([]); expect(port.stat(`01图书馆/小兆clipper/${uploaded.id}`)).not.toBeNull();
  expect((await service.archive({ id: uploaded.id })).state).toBe('archived');
});
