import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { assertStateRootOutsideVault } from '../server/db/permissions.js';
import type { DesktopSettings } from './settings-store.js';

const manifestSchema = z.object({
  version: z.literal('1.0.0'),
  files: z.array(z.object({
    path: z.string().min(1).max(4096),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u)
  }).strict()).min(1)
}).strict();

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function assertRelativePath(path: string): void {
  if (path.includes('\0') || isAbsolute(path)) throw new Error('INITIAL_VAULT_TEMPLATE_INVALID');
  if (path.split(/[\\/]/u).includes('..')) {
    throw new Error('INITIAL_VAULT_TEMPLATE_INVALID');
  }
}

function pathWithin(root: string, path: string): string {
  assertRelativePath(path);
  const resolved = resolve(root, path);
  const fromRoot = relative(root, resolved);
  if (fromRoot === '..' || fromRoot.startsWith('..' + '\\') || fromRoot.startsWith('../') || isAbsolute(fromRoot)) {
    throw new Error('INITIAL_VAULT_TEMPLATE_INVALID');
  }
  return resolved;
}

async function assertRealDirectory(path: string, code: string): Promise<void> {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error(code);
  const status = await lstat(path).catch(() => undefined);
  if (status === undefined || !status.isDirectory() || status.isSymbolicLink()) throw new Error(code);
  if (await realpath(path) !== path) throw new Error(code);
}

async function listTemplateFiles(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    const relativePath = relative(root, path);
    if (entry.isSymbolicLink()) throw new Error('INITIAL_VAULT_TEMPLATE_INVALID');
    if (entry.isDirectory()) files.push(...await listTemplateFiles(root, path));
    else if (entry.isFile()) files.push(relativePath);
    else throw new Error('INITIAL_VAULT_TEMPLATE_INVALID');
  }
  return files.sort();
}

async function sha256(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return createHash('sha256').update(await file.readFile()).digest('hex'); }
  finally { await file.close(); }
}

async function readAndValidateManifest(root: string): Promise<ReadonlyArray<{ path: string; sha256: string }>> {
  const manifestPath = pathWithin(root, 'template-manifest.json');
  const manifestStatus = await lstat(manifestPath).catch(() => undefined);
  if (manifestStatus === undefined || !manifestStatus.isFile() || manifestStatus.isSymbolicLink()) {
    throw new Error('INITIAL_VAULT_TEMPLATE_MISSING');
  }
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  const listed = manifest.files.map((entry) => {
    assertRelativePath(entry.path);
    return entry.path;
  });
  if (new Set(listed).size !== listed.length || listed.includes('template-manifest.json')) {
    throw new Error('INITIAL_VAULT_TEMPLATE_INVALID');
  }
  const actual = (await listTemplateFiles(root)).filter((path) => path !== 'template-manifest.json');
  if (actual.length !== listed.length || actual.some((path, index) => path !== [...listed].sort()[index])) {
    throw new Error('INITIAL_VAULT_TEMPLATE_INVALID');
  }
  for (const entry of manifest.files) {
    const filePath = pathWithin(root, entry.path);
    const status = await lstat(filePath);
    if (!status.isFile() || status.isSymbolicLink() || await sha256(filePath) !== entry.sha256) {
      throw new Error('INITIAL_VAULT_TEMPLATE_INVALID');
    }
  }
  return manifest.files;
}

async function copyTree(source: string, destination: string): Promise<void> {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error('INITIAL_VAULT_TEMPLATE_INVALID');
    if (entry.isDirectory()) {
      await mkdir(destinationPath, { mode: 0o700 });
      await chmod(destinationPath, 0o700);
      await copyTree(sourcePath, destinationPath);
      continue;
    }
    if (!entry.isFile()) throw new Error('INITIAL_VAULT_TEMPLATE_INVALID');
    const sourceFile = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const destinationFile = await open(
        destinationPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        await destinationFile.writeFile(await sourceFile.readFile());
        await destinationFile.sync();
      } finally { await destinationFile.close(); }
    } finally { await sourceFile.close(); }
  }
}

export function resolveDefaultVaultTemplateRoot(input: {
  readonly packaged?: boolean;
  readonly resourcesPath?: string;
} = {}): string {
  const packaged = input.packaged ?? (
    process.env.NODE_ENV === 'production'
    || (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp === false
  );
  if (packaged) {
    const resourcesPath = input.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    if (resourcesPath === undefined || !isAbsolute(resourcesPath) || resourcesPath.includes('\0')) {
      throw new Error('INITIAL_VAULT_TEMPLATE_MISSING');
    }
    return join(resourcesPath, 'templates/default-vault');
  }
  return resolve(import.meta.dirname, '../../templates/default-vault');
}

export async function copyDefaultVaultTemplate(input: {
  readonly parentRoot: string;
  readonly userDataDir: string;
  readonly validate: (root: string) => Promise<DesktopSettings>;
  readonly templateRoot: string;
}): Promise<DesktopSettings> {
  await assertRealDirectory(input.parentRoot, 'INITIAL_VAULT_PARENT_INVALID');
  const parentRoot = input.parentRoot;
  const vaultRoot = join(parentRoot, '我的大脑');
  assertStateRootOutsideVault(input.userDataDir, vaultRoot);
  try {
    await lstat(vaultRoot);
    throw new Error('INITIAL_VAULT_EXISTS');
  } catch (error) {
    if (error instanceof Error && error.message === 'INITIAL_VAULT_EXISTS') throw error;
    if (!isMissing(error)) throw new Error('INITIAL_VAULT_EXISTS');
  }

  const templateRoot = input.templateRoot;
  await assertRealDirectory(templateRoot, 'INITIAL_VAULT_TEMPLATE_MISSING');
  await readAndValidateManifest(templateRoot);
  let temporary: string | undefined;
  let publishedIdentity: { dev: number; ino: number } | undefined;
  try {
    temporary = await mkdtemp(join(parentRoot, '.我的大脑-'));
    await chmod(temporary, 0o700);
    await copyTree(templateRoot, temporary);
    // Validate the copied bytes before publishing, then repeat the check after the rename.
    await readAndValidateManifest(temporary);
    await rename(temporary, vaultRoot);
    temporary = undefined;
    const published = await lstat(vaultRoot);
    if (!published.isDirectory() || published.isSymbolicLink()) throw new Error('INITIAL_VAULT_TEMPLATE_INVALID');
    publishedIdentity = { dev: published.dev, ino: published.ino };
    await readAndValidateManifest(vaultRoot);
    return await input.validate(vaultRoot);
  } catch (error) {
    if (temporary !== undefined) await rm(temporary, { recursive: true, force: true }).catch(() => {});
    if (publishedIdentity !== undefined) {
      const current = await lstat(vaultRoot).catch(() => undefined);
      if (current?.isDirectory() && !current.isSymbolicLink()
        && current.dev === publishedIdentity.dev && current.ino === publishedIdentity.ino) {
        await rm(vaultRoot, { recursive: true, force: true }).catch(() => {});
      }
    }
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST' || (error as NodeJS.ErrnoException)?.code === 'ENOTEMPTY') {
      throw new Error('INITIAL_VAULT_EXISTS');
    }
    throw error;
  }
}
