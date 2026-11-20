import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { handleClipperMessage } from '../../src/electron/clipper-host.js';
import { CLIPPER_EXTENSION_ID } from '../../src/shared/api/clipper.js';
import { CURRENT_VAULT_LAYOUT } from '../../src/shared/domain/vault-layout.js';
import { createCurrentIntakeFixture, createPersonalIntakeFixture } from '../helpers/personal-intake-fixture.js';
import { archiveSource as source } from '../helpers/archive-fixture.js';
import { openPersonalArchive } from '../../src/server/archive/sandbox-native.js';
import { createIntakeService } from '../../src/server/services/intake-service.js';
import { intakeListSchema } from '../../src/shared/api/intake.js';
import { parseFrontmatter } from '../../src/server/rules/frontmatter.js';
const close: (() => void)[] = [];
afterEach(() => { for (const cleanup of close.splice(0).reverse()) cleanup(); });
function fixture() {
  const f = createPersonalIntakeFixture(); close.push(f.cleanup);
  const port = openPersonalArchive(f.root, f.recovery, resolve('dist/native/personal-archive.node')); close.push(() => port.close());
  let now = 0; let rules = 'a'.repeat(64); let indexed = true;
  const service = createIntakeService({ port, now: () => now, ruleFingerprint: rules,
    getRuleFingerprint: async () => rules, refreshIndex: async () => indexed });
  return { ...f, port, service, expire: () => { now = 600_000; }, changeRules: () => { rules = 'b'.repeat(64); }, failIndex: () => { indexed = false; } };
}
const request = { name: '资料包', mainName: '原文.md', fields: { platform: '个人' as const, title: '资料包', collectedAt: '2026-09-05' } };
it.each([['title', 501], ['author', 1001], ['url', 4001]] as const)('isolates overlong inferred %s without breaking the inbox', async (field, count) => {
  const f = fixture(); writeFileSync(join(f.root, source, '原文.md'), `---\n${field}: ${'x'.repeat(count)}\n---\n正文`);
  const list = await f.service.list(); expect(list.available).toBe(true);
  expect(intakeListSchema.safeParse(list).success).toBe(true);
  expect(list.items[0]?.problem).toBeDefined(); expect(list.items[0]?.mainCandidates).toEqual(['原文.md']);
});
it('lists unstructured packages and loose files, and preview never mutates original files', async () => {
  const f = fixture(); writeFileSync(join(f.root, '01图书馆/小兆clipper/独立.md'), '# loose');
  const list = await f.service.list(); expect(list.available).toBe(true);
  expect(list.items).toContainEqual(expect.objectContaining({ name: '独立.md', problem: expect.any(String) }));
  const preview = await f.service.preview(request); expect(preview.markdown).toContain('知识入库状态: 未提炼');
  expect(f.port.listRecovery()).toEqual([]); expect(readFileSync(join(f.root, source, '原文.md'))).toEqual(f.original);
});
it('expires preview tokens before creating any journal or modifying a source', async () => {
  const f = fixture(); const preview = await f.service.preview(request); f.expire();
  await expect(f.service.commit(preview.token)).rejects.toThrow('预览已过期');
  expect(f.port.listRecovery()).toEqual([]);
});
it('rejects changed rules and stale source bytes', async () => {
  const f = fixture(); const preview = await f.service.preview(request);
  writeFileSync(join(f.root, source, '原文.md'), 'new edit');
  await expect(f.service.commit(preview.token)).rejects.toThrow('资料发生了变化');
  f.changeRules(); await expect(f.service.preview(request)).rejects.toThrow('大脑规则已变化');
  expect(readFileSync(join(f.root, source, '原文.md'), 'utf8')).toBe('new edit');
});
it('reports index failure separately from a verified file archive and safely replays the same token', async () => {
  const f = fixture(); const preview = await f.service.preview(request); f.failIndex();
  expect(await f.service.commit(preview.token)).toMatchObject({ state: 'archived', indexed: false });
  expect(await f.service.commit(preview.token)).toMatchObject({ state: 'archived', indexed: false });
  expect((await f.service.list()).items).toEqual([]);
});

it('archives clipped plugin metadata while retaining the original document in recovery', async () => {
  const f = fixture();
  const body = '\r\n原始内容\r\n![图](附件/原图.bin)\r\n';
  const original = Buffer.from(`\uFEFF---\r\ntitle: 资料包\r\nsource: 个人\r\nclipped: 2026-09-05\r\npublished: "2026-09-04T21:44:40.000Z"\r\ndescription: 原始描述\r\n学习状态: 未学习\r\n---\r\n${body}`);
  writeFileSync(join(f.root, source, '原文.md'), original);
  expect((await f.service.list()).items[0]?.fields.collectedAt).toBe('2026-09-05');
  const preview = await f.service.preview(request);
  expect(preview.markdown).toContain('原始资料信息');
  expect(readFileSync(join(f.root, source, '原文.md'))).toEqual(original);
  expect(f.port.listRecovery()).toEqual([]);
  const outcome = await f.service.commit(preview.token);
  expect(outcome).toMatchObject({ state: 'archived', indexed: true });
  const final = readFileSync(join(f.root, outcome.target, '20260905｜个人｜资料包.md'));
  expect(Buffer.from(parseFrontmatter(final).bodyBytes).subarray(-Buffer.byteLength(body))).toEqual(Buffer.from(body));
  expect(f.port.readRecovery(`${outcome.id}.stage.md`)).toEqual(original);
  expect(readFileSync(join(f.root, outcome.target, '附件/原图.bin'))).toEqual(Buffer.from([0,255,1,13,10]));
  expect(await f.service.commit(preview.token)).toMatchObject({ state: 'archived' });
});

it('archives a dated current-layout packet with original bytes and resumes its saved receipt', async () => {
  const f = createCurrentIntakeFixture(); close.push(f.cleanup);
  const port = openPersonalArchive(f.root, f.recovery, resolve('dist/native/personal-archive.node')); close.push(() => port.close());
  const now = Date.parse('2026-11-20T12:31:00Z');
  const service = createIntakeService({ layout: CURRENT_VAULT_LAYOUT, port, now: () => now,
    ruleFingerprint: 'a'.repeat(64), getRuleFingerprint: async () => 'a'.repeat(64), refreshIndex: async () => true });
  const info = await service.list();
  expect(info.items.find(row => row.name === '资料包')?.mainCandidates).toContain('原文.md');
  const preview = await service.preview({ ...request, fields: { platform: '电话录音', collectedAt: '2026-08-27', title: '采访', sourceName: '电话采访' } });
  expect(preview.target).toBe('01图书馆/02个人资料/电话录音/2026/2026-08/20260827｜电话录音｜采访');
  expect(port.listRecovery()).toEqual([]);
  const receipt = await service.commit(preview.token);
  expect(receipt.state).toBe('archived');
  const note = parseFrontmatter(readFileSync(join(f.root, receipt.target, preview.mainName)));
  expect(note.data).toMatchObject({ 标题: '采访', 资料来源: '电话采访', 入馆时间: '2026-11-20-20:31', 发生日期: '2026-08-27', 关联日记: [], 探讨状态: '未探讨' });
  expect(note.data).not.toHaveProperty('生成知识');
  expect(note.bodyBytes).toEqual(parseFrontmatter(f.original).bodyBytes);
  expect(readFileSync(join(f.root, receipt.target, '附件/原图.bin'))).toEqual(Buffer.from([0, 255, 1, 13, 10]));
  expect(await service.resume(receipt.id)).toEqual(receipt);
});
it('prefills a large browser capture and archives the original text and metadata together', async () => {
  const f = createCurrentIntakeFixture(); close.push(f.cleanup);
  const port = openPersonalArchive(f.root, f.recovery, resolve('dist/native/personal-archive.node')); close.push(() => port.close());
  const service = createIntakeService({ layout: CURRENT_VAULT_LAYOUT, port, ruleFingerprint: 'a'.repeat(64),
    getRuleFingerprint: async () => 'a'.repeat(64), refreshIndex: async () => true });
  const payload = { packetId: 'clip-large', title: '网页原文', url: 'https://www.zhihu.com/question/123',
    clippedAt: '2026-11-20T08:00:00.000Z', content: '原文\n'.repeat(50_000) };
  const config = { layout: 'current' as const, version: 1 as const, vaultRoot: f.root, extensionId: CLIPPER_EXTENSION_ID, token: 't'.repeat(32) };
  await handleClipperMessage({ extensionId: CLIPPER_EXTENSION_ID, token: config.token, payload }, config);
  const fields = (await service.list()).items.find(item => item.name === payload.packetId)?.fields;
  expect(fields).toMatchObject({ title: payload.title, url: payload.url });
  expect(fields?.collectedAt).toBeFalsy();
  const plan = await service.preview({ name: payload.packetId, mainName: 'index.md', fields: {
    title: payload.title, platform: '知乎', url: payload.url, collectedAt: '' } });
  expect((await service.commit(plan.token)).state).toBe('archived');
  const note = parseFrontmatter(readFileSync(join(f.root, plan.target, plan.mainName)));
  expect(note.data).toMatchObject({ 标题: payload.title, 原始链接: payload.url, 发布时间: null });
  expect(Buffer.from(note.bodyBytes).toString('utf8')).toContain(payload.content);
  expect(JSON.parse(readFileSync(join(f.root, plan.target, '附件', 'metadata.json'), 'utf8'))).toMatchObject({ packetId: payload.packetId });
});
