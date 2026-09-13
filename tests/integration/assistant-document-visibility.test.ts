import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createIndexRepository } from '../../src/server/index/index-repository.js';
import { FakeVaultGateway } from '../../src/server/vault/FakeVaultGateway.js';
import { parseLibraryNoteForRead } from '../../src/server/rules/read-compatible-notes.js';
import { createReadService } from '../../src/server/services/read-service.js';

const path = '01图书馆/个人/原始资料.md';
const note = '---\n类型: 原始资料\n处理状态: 已归档\n来源平台: 个人\n原始标题: 原始资料\n所属主题: []\n关键词: []\n知识入库状态: 未提炼\n生成知识: []\n---\n真实证据。';
const databases: Database.Database[] = [];
afterEach(() => { databases.splice(0).forEach((db) => db.close()); });
function fixture() {
  const db = new Database(':memory:'); databases.push(db); applyMigrations(db);
  const gateway = new FakeVaultGateway({ [path]: note });
  const repository = createIndexRepository(db);
  repository.replaceFile({ kind: 'material', record: parseLibraryNoteForRead(Buffer.from(note), path).record! });
  const read = createReadService({ database: db, repository, gateway, currentIndexVersion: () => 1, cursorSecret: Buffer.alloc(32, 1) });
  const trash = (status: string) => db.prepare('INSERT INTO personal_trash_entries(id,material_path,title,created_at,status,manifest_json) VALUES (?,?,?,?,?,?)')
    .run('trash', path, '资料', '2026-09-09T00:00:00.000Z', status, '{}');
  return { db, gateway, read, trash };
}

it.each(['moving', 'trashed', 'restoring'])('does not expose raw library material while trash status is %s', async (status) => {
  const f = fixture(); f.trash(status);
  await expect(f.read.getDocumentDetail(path)).rejects.toMatchObject({ code: 'SOURCE_IN_TRASH' });
  expect(f.gateway.rawReadPaths).toEqual([]);
});

it('rechecks visibility after a read before returning any original text', async () => {
  const f = fixture(); const readRaw = f.gateway.readRaw.bind(f.gateway);
  vi.spyOn(f.gateway, 'readRaw').mockImplementation(async (requestedPath) => { const raw = await readRaw(requestedPath); f.trash('moving'); return raw; });
  await expect(f.read.getDocumentDetail(path)).rejects.toMatchObject({ code: 'SOURCE_IN_TRASH' });
});

it('allows a restored library material to be read normally', async () => {
  const f = fixture(); f.trash('restored');
  expect(await f.read.getDocumentDetail(path)).toMatchObject({ path, markdown: note });
});
