import { LocalRest51Gateway } from '../../src/server/vault/LocalRest51Gateway.js';

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const LIBRARY_PREFIX = '01图书馆/来自其他/__xiaozhao_contract__';
const KNOWLEDGE_PREFIX = '02知识库/99其他/__xiaozhao_contract__';

export type ContractEnvironment = {
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly testVaultRoot: string;
  readonly formalVaultRoot: string;
  readonly sourceRoot: string;
  readonly appDataRoot: string;
};

export function contractSandboxRoots(runId: string): {
  readonly library: string;
  readonly knowledge: string;
} {
  if (!ULID_PATTERN.test(runId)) {
    throw new Error('CONTRACT_RUN_ID_INVALID');
  }
  return {
    library: `${LIBRARY_PREFIX}/${runId}`,
    knowledge: `${KNOWLEDGE_PREFIX}/${runId}`
  };
}

export function assertSandboxVaultPath(path: string, runId: string): string {
  const roots = contractSandboxRoots(runId);
  if (
    path.includes('\\')
    || path.includes('\0')
    || path.split('/').some((segment) => segment === '.' || segment === '..')
    || (!path.startsWith(`${roots.library}/`) && !path.startsWith(`${roots.knowledge}/`))
  ) {
    throw new Error('CONTRACT_PATH_NOT_ALLOWED');
  }
  return path;
}

export function loadContractEnvironment(env: NodeJS.ProcessEnv): ContractEnvironment | undefined {
  const values = {
    apiUrl: env.OBSIDIAN_API_URL,
    apiKey: env.OBSIDIAN_API_KEY,
    testVaultRoot: env.CONTRACT_TEST_VAULT_ROOT,
    formalVaultRoot: env.VAULT_REAL_ROOT,
    sourceRoot: env.CONTRACT_SOURCE_ROOT,
    appDataRoot: env.APP_DATA_DIR
  };
  if (Object.values(values).some((value) => typeof value !== 'string' || value.length === 0)) {
    return undefined;
  }
  return values as ContractEnvironment;
}

export function requireContractEnvironment(env: NodeJS.ProcessEnv): ContractEnvironment {
  const environment = loadContractEnvironment(env);
  if (environment === undefined) {
    throw new Error('CONTRACT_CONTEXT_MISSING');
  }
  return environment;
}

export function createContractGateway(environment: ContractEnvironment): LocalRest51Gateway {
  return new LocalRest51Gateway(environment.apiUrl, environment.apiKey, fetch);
}

function vaultEndpoint(baseUrl: string, path: string): URL {
  const encoded = encodeVaultPath(path);
  return new URL(`/vault/${encoded}`, baseUrl);
}

function encodeVaultPath(path: string): string {
  return path.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

export class ContractRestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImplementation: typeof fetch = fetch
  ) {}

  async patch(path: string, version: string, content: string): Promise<number> {
    return this.request(path, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': version
      },
      body: JSON.stringify({
        operation: 'replace',
        targetType: 'heading',
        target: [],
        scope: 'content',
        content,
        ifMatch: version
      })
    });
  }

  async copy(sourcePath: string, destinationPath: string): Promise<number> {
    return this.request(sourcePath, {
      method: 'COPY',
      headers: {
        Destination: encodeVaultPath(destinationPath),
        'Allow-Overwrite': 'false'
      }
    });
  }

  async put(path: string, bytes: Uint8Array, rejectIfContentPreexists = false): Promise<number> {
    return this.request(path, {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/markdown',
        ...(rejectIfContentPreexists ? { 'Reject-If-Content-Preexists': 'true' } : {})
      },
      body: Uint8Array.from(bytes).buffer
    });
  }

  async trash(path: string, version?: string): Promise<number> {
    const endpoint = vaultEndpoint(this.baseUrl, path);
    endpoint.searchParams.set('permanent', 'false');
    return this.fetchStatus(endpoint, {
      method: 'DELETE',
      ...(version === undefined ? {} : { headers: { 'If-Match': version } })
    });
  }

  private async request(path: string, init: RequestInit): Promise<number> {
    return this.fetchStatus(vaultEndpoint(this.baseUrl, path), init);
  }

  private async fetchStatus(endpoint: URL, init: RequestInit): Promise<number> {
    const response = await this.fetchImplementation(endpoint, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
        ...init.headers
      }
    });
    try {
      void response.body?.cancel().catch(() => {});
    } catch {
      // Contract assertions use only status facts; body release is best-effort.
    }
    return response.status;
  }
}
