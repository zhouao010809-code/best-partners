// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createBrowserCompanyApi } from '../../src/client/components/company/company-api.js';

const CSRF = 'c'.repeat(43);
const SHA = 'a'.repeat(64);

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function uploadResult() {
  return {
    id: 'import-1', workspaceId: 'company', projectId: 'project-1', platform: 'douyin',
    sourceRelativePath: 'platform-data/douyin/project-1/hash-export.csv',
    rawRelativePath: 'platform-data/raw/douyin/project-1/hash-export.csv', sourceSha256: SHA,
    sourceType: 'official-export', state: 'imported', rowCount: 1, importedCount: 1, rejectedCount: 0,
    issues: [], createdAt: '2026-09-19T12:00:00.000Z', updatedAt: '2026-09-19T12:00:00.000Z', importedAt: '2026-09-19T12:00:00.000Z'
  };
}

describe('company API metrics upload client', () => {
  it('posts the File bytes with encoded metadata and the company CSRF token', async () => {
    const file = new File(['作品ID,数据日期,播放量\nitem-1,2026-09-19,1300\n'], '官方导出 2026.csv', { type: 'text/csv' });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(response({ data: { user: { id: 'operator', displayName: '运营', role: 'operator' }, csrfToken: CSRF }, version: 1 }))
      .mockResolvedValueOnce(response({ data: uploadResult(), version: 1 }));
    const api = createBrowserCompanyApi(fetcher);

    const result = await api.metrics!.upload('project/1', 'douyin', file);

    expect(result).toEqual({ ok: true, value: uploadResult() });
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/company/v1/auth/session', expect.objectContaining({ method: 'GET', credentials: 'same-origin' }));
    const [path, init] = fetcher.mock.calls[1]!;
    const url = new URL(String(path), 'http://localhost');
    expect(url.pathname).toBe('/api/company/v1/projects/project%2F1/metrics/upload');
    expect(Object.fromEntries(url.searchParams)).toEqual({ platform: 'douyin', fileName: '官方导出 2026.csv' });
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      body: file,
      headers: { 'content-type': 'application/octet-stream', 'x-csrf-token': CSRF }
    });
  });

  it('rejects unsupported filenames before making a network request', async () => {
    const fetcher = vi.fn();
    const api = createBrowserCompanyApi(fetcher);
    const result = await api.metrics!.upload('project-1', 'douyin', new File(['x'], 'metrics.json', { type: 'application/json' }));
    expect(result).toMatchObject({ ok: false, state: { status: 'validation-error' } });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
