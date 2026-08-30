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

  it('percent-encodes every COPY Destination segment before constructing HTTP headers', async () => {
    let destination: string | null = null;
    const client = new ContractRestClient('https://127.0.0.1:27124', 'test-key', async (input, init) => {
      const request = new Request(input, init);
      destination = request.headers.get('Destination');
      return new Response(null, { status: 201 });
    });

    await expect(client.copy(
      'source.md',
      '02知识库/99其他/目标 #100%.md'
    )).resolves.toBe(201);
    expect(destination).toBe(
      '02%E7%9F%A5%E8%AF%86%E5%BA%93/99%E5%85%B6%E4%BB%96/%E7%9B%AE%E6%A0%87%20%23100%25.md'
    );
    expect(destination).toMatch(/^[\x00-\x7f]+$/);
  });

  it('can send a previously verified conditional non-permanent cleanup token', async () => {
    const requests: RequestInit[] = [];
    const client = new ContractRestClient('https://127.0.0.1:27124', 'test-key', async (_input, init) => {
      requests.push(init!);
      return new Response(null, { status: 204 });
    });
    await client.trash('trash.md', 'current-version');
    expect(requests[0]!.headers).toMatchObject({ 'If-Match': 'current-version' });
  });

  it('does not await a response-body cancellation promise', async () => {
    const never = new Promise<void>(() => {});
    const client = new ContractRestClient(
      'https://127.0.0.1:27124',
      'test-key',
      async () => ({ status: 204, body: { cancel: () => never } }) as unknown as Response
    );
    await expect(Promise.race([
      client.copy('source.md', 'target.md'),
      new Promise<number>((resolve) => setTimeout(() => resolve(599), 25))
    ])).resolves.toBe(204);
  });
});
