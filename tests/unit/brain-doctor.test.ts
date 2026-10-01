import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { resolveSourceLink, runBrainDoctor } from '../../scripts/brain-doctor.js';
import { RULE_APPROVAL_SOURCE_PATHS } from '../../src/shared/domain/rule-approval.js';
import { createPersonalBackup } from '../../src/server/operations/personal-backup.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'brain-doctor-')); roots.push(root);
  await Promise.all(['00大脑规则', '01图书馆', '02知识库', '03大讲堂'].map((name) => mkdir(join(root, name))));
  await Promise.all(RULE_APPROVAL_SOURCE_PATHS.map((path) => writeFile(join(root, path), '# rules\n')));
  return root;
}
function knowledge(links: string[]): string {
  return `---\n类型: 知识笔记\n来源类型: AI提炼\n使用状态: AI总结\n知识类型: 方法\n所属主题: []\n关键词: [测试]\n来源资料: ${JSON.stringify(links)}\n适用场景: [测试]\n核心结论: 结论\n关键要点: [要点]\n使用边界: 边界\n---\n正文\n`;
}

async function backupFixture(corruptDatabase = false) {
  const vaultRoot = await realpath(await fixture());
  const temporary = await realpath(tmpdir());
  const userDataRoot = await mkdtemp(join(temporary, 'brain-doctor-backup-state-'));
  const destinationRoot = await mkdtemp(join(temporary, 'brain-doctor-snapshots-'));
  roots.push(userDataRoot, destinationRoot);
  const identity = await stat(vaultRoot, { bigint: true });
  const key = createHash('sha256').update(JSON.stringify([vaultRoot, String(identity.dev), String(identity.ino)])).digest('hex');
  const stateRoot = join(userDataRoot, 'vaults', key);
  for (const path of [join(userDataRoot, 'config'), join(stateRoot, 'backups'), join(stateRoot, 'recovery')]) await mkdir(path, { recursive: true });
  await writeFile(join(userDataRoot, 'config/app-config.json'), JSON.stringify({ vaultRoot }));
  await writeFile(join(vaultRoot, '01图书馆/material.md'), '# Synthetic original\n');
  const databasePath = join(stateRoot, 'state.sqlite3');
  if (corruptDatabase) await writeFile(databasePath, 'corrupt SQLite fixture');
  else {
    const database = new Database(databasePath);
    try { database.exec('CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes VALUES(1,\'synthetic state\');'); }
    finally { database.close(); }
  }
  const result = await createPersonalBackup({ vaultRoot, userDataRoot, destinationRoot, cold: true });
  return { vaultRoot, userDataRoot, databasePath, snapshotRoot: result.snapshotRoot };
}

describe('read-only brain doctor', () => {
  it('reports snapshot and SQLite success while leaving application recovery unverified', async () => {
    const f = await backupFixture();
    const report = await runBrainDoctor({ vaultRoot: f.vaultRoot, userDataRoot: f.userDataRoot, snapshotRoot: f.snapshotRoot });
    expect(report.snapshot).toMatchObject({ snapshotIntegrity: 'passed', sqliteIntegrity: 'passed', applicationRestore: 'unverified', requiresIdentityRebind: true });
    expect(report.snapshot?.databases).toHaveLength(1);
  });

  it('reports only SQLite failure after the complete snapshot and copied tree have passed', async () => {
    const f = await backupFixture(true);
    const manifestPath = join(f.snapshotRoot, 'manifest.json');
    const sourceBefore = await readFile(f.databasePath); const manifestBefore = await readFile(manifestPath);
    const report = await runBrainDoctor({ vaultRoot: f.vaultRoot, userDataRoot: f.userDataRoot, snapshotRoot: f.snapshotRoot });
    expect(report.snapshot).toEqual({ snapshotIntegrity: 'passed', sqliteIntegrity: 'failed', applicationRestore: 'unverified', requiresIdentityRebind: true });
    expect(report.issues).toContainEqual({ code: 'PERSONAL_BACKUP_SQLITE_INTEGRITY_FAILED', severity: 'error' });
    expect(await readFile(f.databasePath)).toEqual(sourceBefore);
    expect(await readFile(manifestPath)).toEqual(manifestBefore);
  });

  it.each(['changed-bytes', 'missing-snapshot'] as const)('reports %s snapshot failure without claiming SQLite was checked', async kind => {
    const f = await backupFixture();
    const snapshotRoot = kind === 'missing-snapshot' ? join(f.snapshotRoot, 'absent') : f.snapshotRoot;
    if (kind === 'changed-bytes') await writeFile(join(snapshotRoot, 'vault/01图书馆/material.md'), 'tampered fixture');
    const report = await runBrainDoctor({ vaultRoot: f.vaultRoot, snapshotRoot });
    expect(report.snapshot).toEqual({ snapshotIntegrity: 'failed', sqliteIntegrity: 'unverified', applicationRestore: 'unverified', requiresIdentityRebind: true });
    expect(report.issues).toContainEqual({ code: kind === 'changed-bytes' ? 'PERSONAL_BACKUP_MISMATCH' : 'PERSONAL_BACKUP_SNAPSHOT_INVALID', severity: 'error' });
    expect(await readFile(join(f.vaultRoot, '01图书馆/material.md'), 'utf8')).toBe('# Synthetic original\n');
  });

  it('prefers an explicit vault path over a coincidental nested suffix', () => {
    expect(resolveSourceLink('01图书馆/a/same', ['01图书馆/a/same.md', '01图书馆/nested/01图书馆/a/same.md'])).toEqual(['01图书馆/a/same.md']);
  });

  it('reports a knowledge self-reference as an invalid original source chain', async () => {
    const root = await fixture();
    await writeFile(join(root, '02知识库/self.md'), knowledge(['[[self]]']));
    const report = await runBrainDoctor({ vaultRoot: root });
    expect(report.issues).toContainEqual({ code: 'SOURCE_LINK_NOT_LIBRARY', severity: 'warning', path: '02知识库/self.md' });
  });

  it('looks up the same bigint string cache key as the filesystem gateway', async () => {
    const root = await fixture(); const userData = await mkdtemp(join(tmpdir(), 'brain-doctor-state-')); roots.push(userData);
    const canonical = await realpath(root); const identity = await stat(canonical, { bigint: true });
    const key = createHash('sha256').update(JSON.stringify([canonical, String(identity.dev), String(identity.ino)])).digest('hex');
    await mkdir(join(userData, 'vaults', key), { recursive: true }); await writeFile(join(userData, 'vaults', key, 'state.sqlite3'), 'placeholder');
    const report = await runBrainDoctor({ vaultRoot: root, userDataRoot: userData });
    expect(report.state).toEqual({ expectedCacheKey: key, present: true, cacheDirectories: 1 });
  });

  it('keeps untyped library notes as warnings and never rewrites bytes', async () => {
    const root = await fixture();
    const path = join(root, '01图书馆/raw.md'); const bytes = Buffer.from('# 原文\r\n'); await writeFile(path, bytes);
    const report = await runBrainDoctor({ vaultRoot: root });
    expect(report.lint?.summary).toMatchObject({ warnings: 1, errors: 0 });
    expect(report.issues.some((issue) => issue.code === 'UNCLASSIFIED_MARKDOWN' && issue.severity === 'warning')).toBe(true);
    expect(report.summary.errors).toBe(0);
    expect(await readFile(path)).toEqual(bytes);
  });

  it('distinguishes unique suffix, missing title and ambiguous title links', async () => {
    const root = await fixture();
    await mkdir(join(root, '01图书馆/a')); await mkdir(join(root, '01图书馆/b'));
    await writeFile(join(root, '01图书馆/a/same.md'), '# a');
    await writeFile(join(root, '01图书馆/b/same.md'), '# b');
    await writeFile(join(root, '02知识库/k.md'), knowledge(['[[a/same|别名]]', '[[missing#heading]]', '[[same]]']));
    const report = await runBrainDoctor({ vaultRoot: root });
    expect(report.sourceLinks.map((link) => [link.target, link.status])).toEqual([
      ['a/same', 'unique'], ['missing', 'missing'], ['same', 'ambiguous']
    ]);
    expect(report.sourceLinks[0]?.candidates).toEqual(['01图书馆/a/same.md']);
    expect(report.sourceLinks[2]?.candidates).toHaveLength(2);
  });

  it('reports missing rules and required directories as errors without throwing', async () => {
    const root = await fixture();
    await rm(join(root, RULE_APPROVAL_SOURCE_PATHS[0]));
    await rm(join(root, '03大讲堂'), { recursive: true });
    const report = await runBrainDoctor({ vaultRoot: root });
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'RULE_FILE_MISSING', severity: 'error' }),
      expect.objectContaining({ code: 'REQUIRED_DIRECTORY_INVALID', severity: 'error' })
    ]));
  });

  it('rejects an outside required section and ignores nested symlinks and dependencies', async () => {
    const root = await fixture(); const outside = await fixture();
    await writeFile(join(outside, 'private.md'), '# outside');
    await symlink(join(outside, 'private.md'), join(root, '01图书馆/link.md'));
    await mkdir(join(root, '01图书馆/node_modules')); await writeFile(join(root, '01图书馆/node_modules/ignored.md'), '---\nbroken');
    let report = await runBrainDoctor({ vaultRoot: root });
    expect(report.lint?.summary.files).toBe(0);
    expect(report.issues.some((issue) => issue.code === 'SYMLINK_SKIPPED')).toBe(true);
    await rm(join(root, '02知识库'), { recursive: true });
    await symlink(outside, join(root, '02知识库'), 'dir');
    report = await runBrainDoctor({ vaultRoot: root });
    expect(report.issues).toContainEqual(expect.objectContaining({ code: 'REQUIRED_DIRECTORY_INVALID', severity: 'error' }));
    expect(report.lint).toBeUndefined();
  });
});
