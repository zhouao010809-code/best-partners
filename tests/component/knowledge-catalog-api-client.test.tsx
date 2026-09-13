import { expect, it, vi } from 'vitest';
import { createBrowserReadConsoleApi } from '../../src/client/api/client.js';

const page = { path: '01AI/100% & cafe\u0301', breadcrumbs: [{ path: '', label: '知识书柜' }],
  folders: [{ path: '01AI/100% & cafe\u0301/空目录', label: '空目录', count: 0 }], items: [], total: 0, directTotal: 0, indexVersion: 7 };
const ok = (data: unknown) => new Response(JSON.stringify({ data, version: 1 }), { headers: { 'content-type': 'application/json' } });

it('requests the catalog with declared query fields and abort support without altering legacy knowledge requests', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(ok(page)).mockResolvedValueOnce(ok({ items: [] }));
  const api = createBrowserReadConsoleApi(fetcher);
  expect(api.listKnowledgeCatalog).toBeTypeOf('function');
  const signal = new AbortController().signal;
  expect(await api.listKnowledgeCatalog!({ path: page.path, search: '核心 & 场景', includeObsolete: true, usageStatus: '定论',
    knowledgeType: '模型', topic: '工具/知识', limit: 40, ...({ unexpected: 'never-send' } as object) }, signal)).toEqual({ ok: true, value: page });
  const url = new URL(fetcher.mock.calls[0]![0], 'http://127.0.0.1');
  expect(url.pathname).toBe('/api/v1/knowledge/catalog');
  expect(Object.fromEntries(url.searchParams)).toEqual({ path: page.path, search: '核心 & 场景', includeObsolete: 'true',
    usageStatus: '定论', knowledgeType: '模型', topic: '工具/知识', limit: '40' });
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET', credentials: 'same-origin', signal });
  expect(await api.listKnowledge({})).toEqual({ ok: true, value: { items: [] } });
  expect(fetcher.mock.calls[1]![0]).toBe('/api/v1/knowledge');
});

it('validates catalog counts, records and envelope before exposing results', async () => {
  for (const invalid of [{ ...page, total: -1 }, { ...page, folders: [{ path: 'a', label: 'a', count: -1 }] },
    { ...page, items: [{ path: '02知识库/a.md' }] }, { ...page, extra: 'unexpected' }]) {
    const api = createBrowserReadConsoleApi(vi.fn().mockResolvedValue(ok(invalid)));
    expect(api.listKnowledgeCatalog).toBeTypeOf('function');
    expect(await api.listKnowledgeCatalog!({})).toMatchObject({ ok: false, state: { status: 'validation-error' } });
  }
});
