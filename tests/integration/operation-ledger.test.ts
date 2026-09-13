import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createOperationLedger } from '../../src/server/services/operation-ledger.js';

const databases: Database.Database[] = [];
afterEach(() => databases.splice(0).forEach(db => db.close()));
function setup() {
  const database = new Database(':memory:'); databases.push(database); applyMigrations(database);
  const ledger = createOperationLedger({ database, intakeHistory: () => [], trash: () => ({ items: [] }), intakeTrash: () => ({ items: [] }) });
  return { database, ledger };
}
function run(db: Database.Database, id: string, status: string, path = '01图书馆/来自个人/资料.md', date = '2026-09-08T01:00:00.000Z') {
  db.prepare('INSERT INTO personal_extraction_runs (id,preview_token,material_path,title,reading_state,source_raw_sha256,rule_fingerprint,model,created_at,status) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(id, id, path, '资料', '未看', 'a'.repeat(64), 'rules', 'deepseek', date, status);
}
it('keeps older failures as history when a newer run succeeded; ready candidates are not incidents', async () => {
  const { database, ledger } = setup(); run(database, 'old', 'failed'); run(database, 'new', 'ready');
  const page = await ledger.list({ view: 'attention' });
  expect(page.items).toEqual([]); expect(page.counts).toEqual({ all: 2, attention: 0, running: 0 });
  expect((await ledger.list({})).items.find(item => item.sourceId === 'old')?.summary).toContain('后续');
});
it('reads all history and filters before pagination instead of truncating to 50', async () => {
  const { database, ledger } = setup();
  for (let i = 0; i < 61; i++) run(database, `run-${i}`, 'ready');
  const a = await ledger.list({ limit: 50 }); const b = await ledger.list({ limit: 50, cursor: a.nextCursor });
  expect(a.items).toHaveLength(50); expect(b.items).toHaveLength(11);
  expect(new Set([...a.items, ...b.items].map(item => item.id)).size).toBe(61);
  expect(b.nextCursor).toBeUndefined();
});
it('does not invent dates for old archive receipts or silently hide failed sources', async () => {
  const ledger = createOperationLedger({ intakeHistory: () => [{ id: 'receipt', target: '01图书馆/来自个人/我的资料', state: 'pending' }], trash: () => { throw new Error('PRIVATE'); }, intakeTrash: () => ({ items: [] }) });
  const page = await ledger.list({});
  expect(page.items[0]?.occurredAt).toBeUndefined(); expect(page.items[0]?.title).toBe('我的资料');
  expect(page.items[0]?.action.kind).toBe('resume-archive');
  expect(page.issues?.length).toBeGreaterThan(0); expect(JSON.stringify(page)).not.toContain('PRIVATE');
});
it('labels committed but unindexed ingestion as index-only recovery without exposing file content', async () => {
  const { database, ledger } = setup(); run(database, 'ready', 'ready');
  database.prepare('INSERT INTO personal_ingestion_batches VALUES (?,?,?,?,?,?,?)').run('batch', 'ready', '2026-09-08T02:00:00.000Z', 'committed', 0, JSON.stringify({files:[{path:'02知识库/知识.md', after:'PRIVATE CONTENT'}]}), null);
  const page = await ledger.list({view: 'attention'});
  expect(page.items).toHaveLength(1); expect(page.items[0]?.statusLabel).toBe('待更新检索');
  expect(page.items[0]?.action.kind).toBe('resume-index');
  expect(JSON.stringify(page)).not.toContain('PRIVATE CONTENT');
});
it('recycle history only links to trash, including permanently deleted entries', async () => {
  const ledger = createOperationLedger({ intakeHistory: () => [], intakeTrash: () => ({items: []}), trash: () => ({ items: [{id:'trash-id', materialPath:'02知识库/知识.md', title:'知识', origin:'knowledge', createdAt:'2026-09-01T00:00:00.000Z', deletedAt:'2026-09-08T00:00:00.000Z', status:'deleted', indexed:true}] }) });
  const page = await ledger.list({}); const item = page.items[0]!;
  expect(item.kind).toBe('delete'); expect(item.action).toMatchObject({kind:'navigate', href:'/trash'});
  expect(item.occurredAt).toBe('2026-09-08T00:00:00.000Z'); expect(item.bucket).toBe('history');
});
it('does not ask to retry extraction after its source was intentionally trashed', async () => {
  const { database, ledger } = setup(); run(database, 'failed', 'failed');
  database.prepare('INSERT INTO personal_trash_entries (id,material_path,title,created_at,status,manifest_json) VALUES (?,?,?,?,?,?)')
    .run('trash', '01图书馆/来自个人/资料.md', '资料', '2026-09-08T02:00:00.000Z', 'trashed', '{}');
  expect((await ledger.list({view:'attention'})).items).toEqual([]);
});
