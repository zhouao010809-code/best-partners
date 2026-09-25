import { readdir, stat } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLIENT_ENTRY_MAX_BYTES = 900 * 1024;

export class ClientBundleBudgetError extends Error {
  readonly code = 'CLIENT_BUNDLE_BUDGET_EXCEEDED';
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(bytes: number, maxBytes: number) {
    super(`Client entry is ${bytes} bytes, above the ${maxBytes}-byte budget.`);
    this.name = 'ClientBundleBudgetError';
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

type ClientBundleBudgetReport = {
  readonly entry: string;
  readonly bytes: number;
  readonly maxBytes: number;
};

async function findEntry(distRoot: string): Promise<string> {
  const candidates: string[] = [];

  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /^index-[^/]+\.js$/u.test(basename(entry.name))) candidates.push(path);
    }
  }

  await visit(distRoot);
  if (candidates.length !== 1 || candidates[0] === undefined) {
    throw new Error(`CLIENT_ENTRY_NOT_UNIQUE:${candidates.length}`);
  }
  return candidates[0];
}

export async function assertClientBundleBudget(
  distRoot: string,
  maxBytes = CLIENT_ENTRY_MAX_BYTES
): Promise<ClientBundleBudgetReport> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('maxBytes must be a positive safe integer');
  const root = resolve(distRoot);
  const entry = await findEntry(root);
  const bytes = (await stat(entry)).size;
  if (bytes > maxBytes) throw new ClientBundleBudgetError(bytes, maxBytes);
  return { entry: relative(root, entry).split('/').join('/'), bytes, maxBytes };
}

async function main(): Promise<void> {
  const distRoot = process.argv[2] ?? 'dist/client';
  const report = await assertClientBundleBudget(distRoot);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
