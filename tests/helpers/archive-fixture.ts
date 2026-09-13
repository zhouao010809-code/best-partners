import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const SENTINEL = '.xiaozhao-archive-test.json';
const BYTES = '{"purpose":"archive-test-v1"}\n';
export const archiveSource = '01图书馆/小兆clipper/资料包';
export const archiveTarget = '01图书馆/来自个人/2026-09/20260905｜个人｜资料包';
export const archiveOperationId = 'e52917bc-a9df-482f-aae8-8c4b6da4301d';

export function createArchiveFixture() {
  const temporaryRoot = realpathSync(tmpdir());
  const root = mkdtempSync(join(temporaryRoot, 'xiaozhao-archive-test-'));
  chmodSync(root, 0o700);
  writeFileSync(join(root, SENTINEL), BYTES, { mode: 0o600, flag: 'wx' });
  for (const path of ['.archive-recovery', archiveSource, '01图书馆/来自个人/2026-09', `${archiveSource}/附件/空文件夹`]) {
    mkdirSync(join(root, path), { mode: 0o700, recursive: true });
  }
  const original = Buffer.from('\uFEFF---\r\n类型: 原始资料\r\n---\r\n原文必须原样保留\r\n![附件](附件/原图.bin)\r\n');
  writeFileSync(join(root, archiveSource, '原文.md'), original, { mode: 0o600, flag: 'wx' });
  writeFileSync(join(root, archiveSource, '附件/原图.bin'), Buffer.from([0, 255, 1, 13, 10]), { mode: 0o600, flag: 'wx' });
  writeFileSync(join(root, archiveSource, '.原始信息'), Buffer.from('隐藏信息'), { mode: 0o600, flag: 'wx' });
  return { root, original, cleanup() {
    if (dirname(root) !== temporaryRoot || !basename(root).startsWith('xiaozhao-archive-test-')
      || !lstatSync(root).isDirectory() || realpathSync(root) !== root
      || readFileSync(join(root, SENTINEL), 'utf8') !== BYTES) throw new Error('UNSAFE_ARCHIVE_FIXTURE_CLEANUP');
    rmSync(root, { recursive: true });
  } };
}
