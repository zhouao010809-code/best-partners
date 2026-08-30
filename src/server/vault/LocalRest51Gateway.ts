import type { VaultGateway, VersionedBytes, VaultCapabilityProfile } from './VaultGateway.js';
import { sha256Bytes } from './raw-bytes.js';
import { AppError, ErrorCode } from '../../shared/api/errors.js';
import { randomUUID } from 'node:crypto';

export type FetchImplementation = typeof fetch;

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

class ResponseBodyTooLargeError extends Error {}

type FingerprintPayload = {
  manifest: { id: string; version: string };
  versions: { obsidian: string };
};

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFingerprintPayload(value: unknown): value is FingerprintPayload {
  const payload = asObject(value);
  const manifest = asObject(payload?.manifest);
  const versions = asObject(payload?.versions);
  return isNonEmptyString(manifest?.id)
    && isNonEmptyString(manifest?.version)
    && isNonEmptyString(versions?.obsidian);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

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

export class VaultResponseJsonError extends AppError {
  constructor(public readonly operationId: string) {
    super(
      'VAULT_RESPONSE_INVALID_JSON',
      `Vault response JSON invalid (operationId ${operationId})`,
      502
    );
  }
}

export class VaultResponseShapeError extends AppError {
  constructor(public readonly operationId: string) {
    super(
      'VAULT_RESPONSE_INVALID_SHAPE',
      `Vault response shape invalid (operationId ${operationId})`,
      502
    );
  }
}

export class VaultResponseReadError extends AppError {
  constructor(public readonly operationId: string) {
    super(
      'VAULT_RESPONSE_READ_FAILED',
      `Vault response read failed (operationId ${operationId})`,
      502
    );
  }
}

export class VaultGatewayTransportError extends AppError {
  constructor(public readonly operationId: string) {
    super(
      'VAULT_TRANSPORT_ERROR',
      `Vault transport failed (operationId ${operationId})`,
      502
    );
  }
}

export class VaultGatewayConfigError extends AppError {
  constructor(public readonly operationId: string) {
    super(
      'VAULT_GATEWAY_CONFIG_INVALID',
      `Vault gateway configuration invalid (operationId ${operationId})`,
      500
    );
  }
}

export class LocalRest51Gateway implements VaultGateway {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    baseUrl: string,
    apiKey: string,
    private readonly fetchImplementation: FetchImplementation,
    private readonly operationIdFactory: () => string = randomUUID
  ) {
    let parsedBaseUrl: URL;
    try {
      parsedBaseUrl = new URL(baseUrl);
    } catch {
      throw new VaultGatewayConfigError(randomUUID());
    }
    if (
      parsedBaseUrl.protocol !== 'https:'
      || parsedBaseUrl.username.length > 0
      || parsedBaseUrl.password.length > 0
      || typeof apiKey !== 'string'
      || !/^[\u0021-\u007e]+$/.test(apiKey)
    ) {
      throw new VaultGatewayConfigError(randomUUID());
    }
    this.baseUrl = parsedBaseUrl.origin;
    this.apiKey = apiKey;
  }

  async fingerprint(): Promise<Pick<VaultCapabilityProfile, 'pluginId' | 'pluginVersion' | 'obsidianVersion'>> {
    const response = await this.request(new URL('/', this.baseUrl), 'application/json');
    const payload = await this.readBoundedJson(response);
    if (!isFingerprintPayload(payload)) {
      throw new VaultResponseShapeError(this.publicOperationId(response));
    }
    return {
      pluginId: payload.manifest.id,
      pluginVersion: payload.manifest.version,
      obsidianVersion: payload.versions.obsidian
    };
  }

  async listDirectory(path: string): Promise<ReadonlyArray<string>> {
    const response = await this.request(this.vaultEndpoint(path, true), 'application/json');
    const entries = await this.readBoundedJson(response);
    if (!isStringArray(entries)) {
      throw new VaultResponseShapeError(this.publicOperationId(response));
    }
    return Object.freeze([...entries]);
  }

  async readRaw(path: string): Promise<VersionedBytes> {
    const endpoint = this.vaultEndpoint(path);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const first = await this.request(endpoint, 'text/markdown');
      const firstBytes = await this.readBoundedBytes(first);
      const firstSha256 = sha256Bytes(firstBytes);
      const documentMap = await this.request(endpoint, 'application/vnd.olrapi.document-map+json');
      let upstreamVersion: string | undefined;
      try {
        this.assertDeclaredBodyWithinLimit(documentMap);
        upstreamVersion = documentMap.headers.get('etag') ?? undefined;
      } finally {
        this.cancelBody(documentMap);
      }
      const second = await this.request(endpoint, 'text/markdown');
      const secondBytes = await this.readBoundedBytes(second);
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
    return this.readBoundedText(response);
  }

  private async request(endpoint: URL, accept: string): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImplementation(endpoint, {
        method: 'GET',
        headers: {
          Accept: accept,
          Authorization: `Bearer ${this.apiKey}`
        }
      });
    } catch {
      throw new VaultGatewayTransportError(this.generatedOperationId());
    }
    if (!response.ok) {
      const upstreamStatus = response.status;
      this.cancelBody(response);
      throw new VaultGatewayError(upstreamStatus, this.publicOperationId(response));
    }
    return response;
  }

  private publicOperationId(response: Response): string {
    const received = response.headers.get('x-operation-id') ?? response.headers.get('x-request-id');
    if (this.isSafeOperationId(received)) {
      return received;
    }
    return this.generatedOperationId();
  }

  private generatedOperationId(): string {
    try {
      const generated = this.operationIdFactory();
      if (this.isSafeOperationId(generated)) {
        return generated;
      }
    } catch {
      // Fall through to an internal identifier without retaining the factory error.
    }
    return randomUUID();
  }

  private isSafeOperationId(value: unknown): value is string {
    return typeof value === 'string'
      && value.length <= 128
      && /^[a-z0-9._:-]+$/i.test(value)
      && !value.includes(this.apiKey);
  }

  private assertDeclaredBodyWithinLimit(response: Response): void {
    const contentLength = response.headers.get('content-length');
    if (contentLength === null || !/^\d+$/.test(contentLength)) {
      return;
    }
    if (Number(contentLength) > MAX_RESPONSE_BYTES) {
      throw new AppError('VAULT_RESPONSE_TOO_LARGE', 'VAULT_RESPONSE_TOO_LARGE', 413);
    }
  }

  private async readBoundedBytes(response: Response): Promise<Uint8Array> {
    try {
      this.assertDeclaredBodyWithinLimit(response);
    } catch (error) {
      this.cancelBody(response);
      throw error;
    }

    if (response.body === null) {
      return new Uint8Array();
    }

    let reader: ReadableStreamDefaultReader<Uint8Array>;
    try {
      reader = response.body.getReader();
    } catch {
      this.cancelBody(response);
      throw new VaultResponseReadError(this.publicOperationId(response));
    }

    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        if (result.value.byteLength > MAX_RESPONSE_BYTES - byteLength) {
          throw new ResponseBodyTooLargeError();
        }
        chunks.push(result.value);
        byteLength += result.value.byteLength;
      }

      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    } catch (error) {
      this.cancelReader(reader);
      if (error instanceof ResponseBodyTooLargeError) {
        throw new AppError('VAULT_RESPONSE_TOO_LARGE', 'VAULT_RESPONSE_TOO_LARGE', 413);
      }
      throw new VaultResponseReadError(this.publicOperationId(response));
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Reader cleanup is best-effort and must not replace the primary result or error.
      }
    }
  }

  private async readBoundedText(response: Response): Promise<string> {
    return new TextDecoder().decode(await this.readBoundedBytes(response));
  }

  private async readBoundedJson(response: Response): Promise<unknown> {
    const text = await this.readBoundedText(response);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new VaultResponseJsonError(this.publicOperationId(response));
    }
  }

  private cancelBody(response: Response): void {
    try {
      const cancellation = response.body?.cancel();
      cancellation?.catch(() => {});
    } catch {
      // Body release is best-effort and must not replace the primary gateway result or error.
    }
  }

  private cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
    try {
      reader.cancel().catch(() => {});
    } catch {
      // Reader release is best-effort and must not replace the primary result or error.
    }
  }

  private vaultEndpoint(path: string, directory = false): URL {
    const normalizedPath = directory ? path.replace(/\/+$/, '') : path;
    const segments = normalizedPath.split('/');
    if (
      normalizedPath.length === 0
      || segments.some((segment) => (
        segment.length === 0
        || segment.startsWith('.')
        || segment.includes('\\')
        || segment.includes('\0')
      ))
    ) {
      throw new AppError(ErrorCode.PathNotAllowed, 'PATH_NOT_ALLOWED');
    }
    const encodedPath = segments.map((segment) => encodeURIComponent(segment)).join('/');
    return new URL(`/vault/${encodedPath}${directory ? '/' : ''}`, this.baseUrl);
  }
}
