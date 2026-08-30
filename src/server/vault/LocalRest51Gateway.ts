import type { VaultGateway, VersionedBytes, VaultCapabilityProfile } from './VaultGateway.js';
import { sha256Bytes } from './raw-bytes.js';
import { AppError, ErrorCode } from '../../shared/api/errors.js';
import { randomUUID } from 'node:crypto';

export type FetchImplementation = typeof fetch;

const MAX_RAW_RESPONSE_BYTES = 10 * 1024 * 1024;

export class VaultGatewayError extends AppError {
  constructor(
    public readonly upstreamStatus: number,
    public readonly operationId: string
  ) {
    super(
      'VAULT_UPSTREAM_ERROR',
      `Vault request failed (status ${upstreamStatus}, operationId ${operationId})`,
      upstreamStatus
    );
  }
}

export class LocalRest51Gateway implements VaultGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImplementation: FetchImplementation,
    private readonly operationIdFactory: () => string = randomUUID
  ) {}

  async fingerprint(): Promise<Pick<VaultCapabilityProfile, 'pluginId' | 'pluginVersion' | 'obsidianVersion'>> {
    const response = await this.request(new URL('/', this.baseUrl), 'application/json');
    const payload = await response.json() as {
      manifest: { id: string; version: string };
      versions: { obsidian: string };
    };
    return {
      pluginId: payload.manifest.id,
      pluginVersion: payload.manifest.version,
      obsidianVersion: payload.versions.obsidian
    };
  }

  async listDirectory(path: string): Promise<ReadonlyArray<string>> {
    const response = await this.request(this.vaultEndpoint(path, true), 'application/json');
    const entries = await response.json() as string[];
    return Object.freeze([...entries]);
  }

  async readRaw(path: string): Promise<VersionedBytes> {
    const endpoint = this.vaultEndpoint(path);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const first = await this.request(endpoint, 'text/markdown');
      const firstBytes = await this.readRawBytes(first);
      const firstSha256 = sha256Bytes(firstBytes);
      const documentMap = await this.request(endpoint, 'application/vnd.olrapi.document-map+json');
      const upstreamVersion = documentMap.headers.get('etag') ?? undefined;
      await documentMap.body?.cancel();
      const second = await this.request(endpoint, 'text/markdown');
      const secondBytes = await this.readRawBytes(second);
      const secondSha256 = sha256Bytes(secondBytes);

      if (firstSha256 === secondSha256) {
        return {
          path,
          bytes: secondBytes,
          rawSha256: secondSha256,
          ...(upstreamVersion === undefined ? {} : { upstreamVersion })
        };
      }
    }

    throw new AppError(ErrorCode.VersionConflict, 'VERSION_CONFLICT', 409);
  }

  async readOpenApi(): Promise<string> {
    const response = await this.request(new URL('/openapi.yaml', this.baseUrl), 'application/yaml');
    return response.text();
  }

  private async request(endpoint: URL, accept: string): Promise<Response> {
    const response = await this.fetchImplementation(endpoint, {
      method: 'GET',
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.apiKey}`
      }
    });
    if (!response.ok) {
      const operationId = this.publicOperationId(response);
      throw new VaultGatewayError(response.status, operationId);
    }
    return response;
  }

  private publicOperationId(response: Response): string {
    const received = response.headers.get('x-operation-id') ?? response.headers.get('x-request-id');
    if (
      received !== null
      && received.length <= 128
      && /^[a-z0-9._:-]+$/i.test(received)
      && !received.includes(this.apiKey)
    ) {
      return received;
    }
    return this.operationIdFactory();
  }

  private async readRawBytes(response: Response): Promise<Uint8Array> {
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RAW_RESPONSE_BYTES) {
      throw new AppError('VAULT_RESPONSE_TOO_LARGE', 'VAULT_RESPONSE_TOO_LARGE', 413);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RAW_RESPONSE_BYTES) {
      throw new AppError('VAULT_RESPONSE_TOO_LARGE', 'VAULT_RESPONSE_TOO_LARGE', 413);
    }
    return bytes;
  }

  private vaultEndpoint(path: string, directory = false): URL {
    const normalizedPath = directory ? path.replace(/\/+$/, '') : path;
    const encodedPath = normalizedPath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    return new URL(`/vault/${encodedPath}${directory ? '/' : ''}`, this.baseUrl);
  }
}
