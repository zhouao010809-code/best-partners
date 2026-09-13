import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { assertStateRootOutsideVault, ensurePrivateDirectory } from '../server/db/permissions.js';
import { RULE_BUNDLE_SOURCE_PATHS } from '../server/rules/rule-bundle.js';
import { RULE_APPROVAL_SOURCE_PATHS } from '../shared/domain/rule-approval.js';
import type { NativeReadVaultPortFactory } from '../server/vault/NativeReadVaultPort.js';

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

const STARTER_VAULT_DIRECTORIES = ['00大脑规则', '01图书馆', '02知识库', '03大讲堂'] as const;
const STARTER_RULE_TEXT: Readonly<Record<string, string>> = Object.freeze({
  '00_大脑规范.md': '# 00 大脑规范 · 初始规则\n\n这是由最佳拍档创建的初始规则文件。请按你的工作方式补充；在确认规则前，应用只生成候选和预览，不会自动写入正式知识。\n',
  '01_总路由规则.md': '# 01 总路由规则 · 初始规则\n\n这是由最佳拍档创建的初始规则文件。请按你的工作方式补充；在确认规则前，应用只生成候选和预览，不会自动写入正式知识。\n',
  '02_图书馆入馆规则.md': '# 02 图书馆入馆规则 · 初始规则\n\n这是由最佳拍档创建的初始规则文件。请按你的工作方式补充；在确认规则前，应用只生成候选和预览，不会自动写入正式知识。\n',
  '03_知识库提炼与入库规则.md': '# 03 知识库提炼与入库规则 · 初始规则\n\n这是由最佳拍档创建的初始规则文件。请按你的工作方式补充；在确认规则前，应用只生成候选和预览，不会自动写入正式知识。\n',
  '05_链接命名与治理规则.md': '# 05 链接命名与治理规则 · 初始规则\n\n这是由最佳拍档创建的初始规则文件。请按你的工作方式补充；在确认规则前，应用只生成候选和预览，不会自动写入正式知识。\n'
});

export async function createInitialVault(input: {
  readonly parentRoot: string;
  readonly userDataDir: string;
  readonly validate: (root: string) => Promise<DesktopSettings>;
}): Promise<DesktopSettings> {
  if (!isAbsolute(input.parentRoot) || input.parentRoot.includes('\0')) throw new Error('INITIAL_VAULT_PARENT_INVALID');
  const parentStatus = await lstat(input.parentRoot).catch(() => undefined);
  if (parentStatus === undefined || !parentStatus.isDirectory() || parentStatus.isSymbolicLink()) {
    throw new Error('INITIAL_VAULT_PARENT_INVALID');
  }
  if (await realpath(input.parentRoot) !== input.parentRoot) throw new Error('INITIAL_VAULT_PARENT_INVALID');

  const vaultRoot = join(input.parentRoot, '我的大脑');
  assertStateRootOutsideVault(input.userDataDir, vaultRoot);
  try {
    await lstat(vaultRoot);
    throw new Error('INITIAL_VAULT_EXISTS');
  } catch (error) {
    if (error instanceof Error && error.message === 'INITIAL_VAULT_EXISTS') throw error;
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw new Error('INITIAL_VAULT_EXISTS');
  }

  let created = false;
  try {
    await mkdir(vaultRoot, { mode: 0o700 });
    created = true;
    for (const directory of STARTER_VAULT_DIRECTORIES) await mkdir(join(vaultRoot, directory), { mode: 0o700 });
    for (const sourcePath of RULE_APPROVAL_SOURCE_PATHS) {
      const filePath = join(vaultRoot, sourcePath);
      const fileName = filePath.slice(join(vaultRoot, '00大脑规则/').length);
      const text = STARTER_RULE_TEXT[fileName];
      if (text === undefined) throw new Error('INITIAL_VAULT_TEMPLATE_MISSING');
      await writeFile(filePath, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    }
    return await input.validate(vaultRoot);
  } catch (error) {
    if (created) await rm(vaultRoot, { recursive: true, force: true });
    throw error;
  }
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
