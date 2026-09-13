import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppRouter } from '../../../src/client/app/router.js';
import { browserReadConsoleApi, type ReadConsoleApi } from '../../../src/client/api/client.js';
import type { TrashEntry } from '../../../src/shared/api/trash.js';
import type { IntakeTrashEntry } from '../../../src/shared/api/intake-trash.js';
import '../../../src/client/styles/tokens.css';
import '../../../src/client/styles/global.css';
import '../../../src/client/styles/shell.css';

const id = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const token = '22222222-2222-4222-8222-222222222222';
const ok = <T,>(value: T) => ({ ok: true as const, value: structuredClone(value) });
const options = new URLSearchParams(location.search);
const origins = ['library', 'queue', 'knowledge'] as const;
const titles = [
  ['访谈原文：建立自己的内容系统', '从阅读到理解：一次完整复盘'],
  ['内容选题与信息判断的边界', '一份尚未处理的学习资料'],
  ['用问题组织知识的方法', '长期积累与短期反馈']
];
let documents: TrashEntry[] = origins.flatMap((origin, i) => titles[i]!.map((title, j) => ({
  id: id(i * 2 + j + 1), title, materialPath: `${origin === 'knowledge' ? '02知识库/方法' : '01图书馆/来自个人'}/${title}.md`, origin,
  status: 'trashed', indexed: true, createdAt: `2026-09-0${7 - j}T0${9 - i}:15:00Z`
})));
let packets: IntakeTrashEntry[] = ['关于创造力的采访剪藏', '产品研究：截图与原始摘录'].map((title, i) => ({
  id: id(7 + i), title, name: title, kind: 'directory', bytes: 2048 + i * 4000, fileCount: 3 + i,
  status: 'trashed', createdAt: `2026-09-0${7 - i}T10:30:00Z`
}));
if (options.has('empty')) { documents = []; packets = []; }
const operations: string[] = [];
declare global { interface Window { __trashFixture: { operations: string[] } } }
window.__trashFixture = { operations };
function documentEntry(value: string) { const entry = documents.find(entry => entry.id === value); if (!entry) throw new Error('Unknown fixture document'); return entry; }
function packetEntry(value: string) { const entry = packets.find(entry => entry.id === value); if (!entry) throw new Error('Unknown fixture packet'); return entry; }
const api: ReadConsoleApi = {
  ...browserReadConsoleApi,
  getHealth: async () => ok({ status: 'ready', vaultSource: { status: 'ready', adapter: 'filesystem', displayName: '示例大脑' }, index: { status: 'ready', version: 1, refreshedAt: '2026-09-07T00:00:00Z' }, model: { status: 'configured', providerHost: 'fixture.invalid', name: 'fixture' }, writeGate: { status: 'blocked', missing: ['WRITE_ENABLED'], fingerprintMatches: true }, schemaIssues: { status: 'available', count: 0 } }),
  trash: {
    list: async () => ok({ items: documents }), get: async value => ok(documentEntry(value)),
    preview: async () => { throw new Error('Fixture only contains recycled documents'); }, commit: async () => { throw new Error('Fixture does not move files'); },
    restore: async value => { operations.push(`document:restore:${value}`); const entry = documentEntry(value); entry.status = 'restored'; entry.restoredAt = new Date().toISOString(); return ok(entry); },
    retry: async value => ok(documentEntry(value)),
    previewDelete: async value => { const entry = documentEntry(value); return ok({ id: value, token, origin: entry.origin, materialPath: entry.materialPath, title: entry.title, bytes: 2300, referencedKnowledge: [], expiresAt: '2099-01-01T00:00:00Z' }); },
    delete: async (value, confirmedToken) => { if (confirmedToken !== token) throw new Error('Wrong token'); operations.push(`document:delete:${value}`); const entry = documentEntry(value); entry.status = 'deleted'; entry.deletedAt = new Date().toISOString(); return ok(entry); }
  },
  intakeTrash: {
    list: async () => options.has('packetError') ? { ok: false, state: { status: 'disconnected', message: '资料包读取中断，请刷新重试。' } } : ok({ items: packets }),
    get: async value => ok(packetEntry(value)), preview: async () => { throw new Error('Fixture only contains recycled packets'); }, commit: async () => { throw new Error('Fixture does not move files'); },
    restore: async value => { operations.push(`packet:restore:${value}`); const entry = packetEntry(value); entry.status = 'restored'; return ok(entry); },
    retry: async value => ok(packetEntry(value)),
    previewDelete: async value => { const entry = packetEntry(value); return ok({ id: value, token, name: entry.name, title: entry.title, kind: entry.kind, bytes: entry.bytes, fileCount: entry.fileCount, expiresAt: '2099-01-01T00:00:00Z' }); },
    delete: async (value, confirmedToken) => { if (confirmedToken !== token) throw new Error('Wrong token'); operations.push(`packet:delete:${value}`); const entry = packetEntry(value); entry.status = 'deleted'; entry.deletedAt = new Date().toISOString(); return ok(entry); }
  }
};
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/trash']}><AppRouter api={api} /></MemoryRouter>);
