import { describe, expect, it } from 'vitest';
import { ContractRestClient } from '../helpers/contract-runtime.js';

describe('ContractRestClient', () => {
  it('sends the v2 root-heading PATCH with both HTTP and body CAS tokens', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new ContractRestClient('https://127.0.0.1:27124', 'test-key', async (input, init) => {
      requests.push({ url: String(input), init: init! });
      return new Response(null, { status: 204 });
    });
    await expect(client.patch('01图书馆/中文 #100%.md', 'version-1', 'winner')).resolves.toBe(204);
    expect(requests[0]!.url).toBe(
      'https://127.0.0.1:27124/vault/01%E5%9B%BE%E4%B9%A6%E9%A6%86/%E4%B8%AD%E6%96%87%20%23100%25.md'
    );
    expect(requests[0]!.init.method).toBe('PATCH');
    expect(requests[0]!.init.headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'If-Match': 'version-1',
      'Content-Type': 'application/json'
    });
    expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
      operation: 'replace',
      targetType: 'heading',
      target: [],
      scope: 'content',
      content: 'winner',
      ifMatch: 'version-1'
    });
  });

  it('sends COPY non-overwrite, PUT probe, and non-permanent DELETE declarations exactly', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new ContractRestClient('https://127.0.0.1:27124', 'test-key', async (input, init) => {
      requests.push({ url: String(input), init: init! });
      return new Response(null, { status: 409 });
    });
    await client.copy('source.md', 'target.md');
    await client.put('put.md', new TextEncoder().encode('bytes'), true);
    await client.trash('trash.md');
    expect(requests.map(({ init }) => init.method)).toEqual(['COPY', 'PUT', 'DELETE']);
    expect(requests[0]!.init.headers).toMatchObject({
      Destination: 'target.md',
      'Allow-Overwrite': 'false'
    });
    expect(requests[1]!.init.headers).toMatchObject({
      'Reject-If-Content-Preexists': 'true'
    });
    expect(requests[2]!.url).toBe('https://127.0.0.1:27124/vault/trash.md?permanent=false');
  });
});
