import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

export interface AppConfig {
  readonly appHost: string;
  readonly appPort: number;
  readonly appDataDir: string;
  readonly vaultRealRoot: string;
  readonly obsidianApiUrl: string;
  readonly obsidianApiKey: string;
  readonly modelBaseUrl: string;
  readonly modelName?: string;
  readonly modelApiKey?: string;
  readonly writeEnabled: boolean;
}

const environmentSchema = z.object({
  APP_HOST: z.string().refine((value) => value === '127.0.0.1'),
  APP_PORT: z.string().refine((value) => /^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65535)
    .transform(Number),
  APP_DATA_DIR: z.string().min(1),
  VAULT_REAL_ROOT: z.string().min(1),
  OBSIDIAN_API_URL: z.string().refine(isHttpsUrl),
  OBSIDIAN_API_KEY: z.string().min(1),
  MODEL_BASE_URL: z.string().refine(isHttpsUrl),
  MODEL_NAME: z.string().default(''),
  MODEL_API_KEY: z.string().default(''),
  WRITE_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true')
}).superRefine((value, context) => {
  if (value.MODEL_NAME.length > 0 && value.MODEL_API_KEY.length === 0) {
    context.addIssue({
      code: 'custom',
      message: 'MODEL_API_KEY is required when MODEL_NAME is configured',
      path: ['MODEL_API_KEY']
    });
  }
});

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function canonicalPath(value: string, field: 'APP_DATA_DIR' | 'VAULT_REAL_ROOT'): string {
  const absolutePath = resolve(value);
  try {
    return realpathSync(absolutePath);
  } catch (error: unknown) {
    if (isMissingPath(error)) {
      return absolutePath;
    }
    throw new Error(`Invalid configuration: ${field}`);
  }
}

function isMissingPath(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isSameOrContainedBy(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return pathFromParent === ''
    || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..' && !isAbsolute(pathFromParent));
}

function configurationErrorFields(error: z.ZodError): string {
  return [...new Set(error.issues.map((issue) => String(issue.path[0] ?? 'configuration')))].join(', ');
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = environmentSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${configurationErrorFields(parsed.error)}`);
  }

  const appDataDir = canonicalPath(parsed.data.APP_DATA_DIR, 'APP_DATA_DIR');
  const vaultRealRoot = canonicalPath(parsed.data.VAULT_REAL_ROOT, 'VAULT_REAL_ROOT');
  if (isSameOrContainedBy(vaultRealRoot, appDataDir)) {
    throw new Error('Invalid configuration: APP_DATA_DIR');
  }
  if (isSameOrContainedBy(appDataDir, vaultRealRoot)) {
    throw new Error('Invalid configuration: VAULT_REAL_ROOT');
  }

  return {
    appHost: parsed.data.APP_HOST,
    appPort: parsed.data.APP_PORT,
    appDataDir,
    vaultRealRoot,
    obsidianApiUrl: parsed.data.OBSIDIAN_API_URL,
    obsidianApiKey: parsed.data.OBSIDIAN_API_KEY,
    modelBaseUrl: parsed.data.MODEL_BASE_URL,
    ...(parsed.data.MODEL_NAME.length > 0 ? { modelName: parsed.data.MODEL_NAME } : {}),
    ...(parsed.data.MODEL_API_KEY.length > 0 ? { modelApiKey: parsed.data.MODEL_API_KEY } : {}),
    writeEnabled: parsed.data.WRITE_ENABLED
  };
}
