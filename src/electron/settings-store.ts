import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { assertStateRootOutsideVault, ensurePrivateDirectory } from '../server/db/permissions.js';
import { RULE_BUNDLE_SOURCE_PATHS } from '../server/rules/rule-bundle.js';
import type { NativeReadVaultPortFactory } from '../server/vault/NativeReadVaultPort.js';
import { copyDefaultVaultTemplate, resolveDefaultVaultTemplateRoot } from './vault-template.js';

export { copyDefaultVaultTemplate, resolveDefaultVaultTemplateRoot } from './vault-template.js';

const settingsSchema = z.object({
  vaultRoot: z.string().min(1).max(4096).refine((value) => isAbsolute(value) && !value.includes('\0'))
}).strict();
export type DesktopSettings = z.infer<typeof settingsSchema>;

function missing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

export async function loadDesktopSettings(input: { readonly userDataDir: string }): Promise<DesktopSettings | undefined> {
  const directory = join(input.userDataDir, 'config');
  try {
    const status = await lstat(directory);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('SETTINGS_UNSAFE');
    const file = await open(join(directory, 'app-config.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const status = await file.stat();
      if (!status.isFile() || status.nlink !== 1 || status.size > 16_384) throw new Error('SETTINGS_UNSAFE');
      return settingsSchema.parse(JSON.parse(await file.readFile('utf8')));
    } finally { await file.close(); }
  } catch (error) {
    if (missing(error)) return undefined;
    throw new Error('SETTINGS_UNAVAILABLE');
  }
}

export async function saveDesktopSettings(input: { readonly userDataDir: string; readonly config: DesktopSettings }): Promise<void> {
  const config = settingsSchema.parse(input.config);
  assertStateRootOutsideVault(input.userDataDir, config.vaultRoot);
  ensurePrivateDirectory(input.userDataDir);
  const directory = join(input.userDataDir, 'config');
  ensurePrivateDirectory(directory);
  const temporary = join(directory, `.app-config-${randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      await file.writeFile(`${JSON.stringify(config)}\n`);
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, join(directory, 'app-config.json'));
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await unlink(temporary).catch((error: unknown) => { if (!missing(error)) throw error; }); }
}

export async function createInitialVault(input: {
  readonly parentRoot: string;
  readonly userDataDir: string;
  readonly validate: (root: string) => Promise<DesktopSettings>;
}): Promise<DesktopSettings> {
  return copyDefaultVaultTemplate({
    parentRoot: input.parentRoot,
    userDataDir: input.userDataDir,
    validate: input.validate,
    templateRoot: resolveDefaultVaultTemplateRoot()
  });
}

export async function validateDesktopVault(input: {
  readonly vaultRoot: string;
  readonly userDataDir: string;
  readonly nativeReaderFactory: NativeReadVaultPortFactory;
}): Promise<DesktopSettings> {
  const config = settingsSchema.parse({ vaultRoot: input.vaultRoot });
  assertStateRootOutsideVault(input.userDataDir, config.vaultRoot);
  const reader = await input.nativeReaderFactory.create(config.vaultRoot);
  for (const path of ['00大脑规则', '01图书馆', '02知识库', '03大讲堂']) await reader.assertDirectory(path);
  for (const path of RULE_BUNDLE_SOURCE_PATHS) await reader.assertFile(path);
  return config;
}

interface VaultSelectionInput {
  readonly validate: (root: string) => Promise<DesktopSettings>;
  readonly chooseDirectory: () => Promise<string | undefined>;
  readonly showInvalidSelection: () => Promise<void | 'retry' | 'cancel'>;
}

export type InitialVaultChoice = 'create' | 'select' | 'cancel';

export async function selectValidatedVaultDirectory(input: VaultSelectionInput): Promise<DesktopSettings | undefined> {
  for (;;) {
    const selected = await input.chooseDirectory();
    if (selected === undefined) return undefined;
    try { return await input.validate(selected); }
    catch { if (await input.showInvalidSelection() === 'cancel') return undefined; }
  }
}

export async function resolveInitialVaultSettings(input: VaultSelectionInput & {
  readonly saved: DesktopSettings | undefined;
  readonly defaultRoot: string;
  readonly showInitialChoice?: () => Promise<InitialVaultChoice>;
  readonly createInitial?: () => Promise<DesktopSettings | undefined>;
}): Promise<DesktopSettings | undefined> {
  for (const candidate of [input.saved?.vaultRoot, input.defaultRoot]) {
    if (candidate === undefined) continue;
    try { return await input.validate(candidate); } catch { /* A stale location returns to selection. */ }
  }
  if (input.showInitialChoice !== undefined && input.createInitial !== undefined) {
    const choice = await input.showInitialChoice();
    if (choice === 'cancel') return undefined;
    if (choice === 'create') return input.createInitial();
  }
  return selectValidatedVaultDirectory(input);
}
