import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { PublicApiError } from '../../shared/api/errors.js';
import { assertStateRootOutsideVault, ensurePrivateDirectory, secureExistingPrivateFile } from '../db/permissions.js';

export function conflict(message: string): never {
  throw new PublicApiError('DISCUSSION_WRITE_CONFLICT', message, 409);
}
export const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const missing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';
export type Change = { path: string; before: string | null; original: string | null; after: string | null; stage: string };
export type SessionFile = { path: string; day: string; startedAt: string; bodyHash: string; ended: boolean };
type Prepared<R> = { changes: Change[]; result: R; session?: { id: string; value: SessionFile }; moved?: { from: string; to: string } };

function validRelative(path: string) {
  if (path.length > 2048 || path.split('/').some(s => !s || s === '.' || s === '..' || s.startsWith('.') || /[\\\u0000-\u001f]/u.test(s))) {
    conflict('文件路径无效。');
  }
}

function readRegular(path: string): Buffer | null {
  let fd: number;
  try { fd = openSync(path, constants.O_NOFOLLOW | constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) { if (missing(error)) return null; throw error; }
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > 32 * 1024 * 1024) conflict('笔记类型或大小不适合本次保存。');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd), current = lstatSync(path);
    if (after.ctimeMs !== before.ctimeMs || after.dev !== current.dev || after.ino !== current.ino) conflict('笔记正在其他位置修改，请重试。');
    return bytes;
  } finally { closeSync(fd); }
}

export class DiscussionFiles {
  readonly root: string;
  private rootId: { dev: number; ino: number };
  private state: string;

  constructor(root: string, stateDirectory: string) {
    this.root = realpathSync(root);
    this.rootId = lstatSync(this.root);
    assertStateRootOutsideVault(stateDirectory, this.root);
    ensurePrivateDirectory(stateDirectory);
    this.state = join(stateDirectory, 'discussion-writing.sqlite');
  }

  directory(relative: string, create = false): string {
    validRelative(relative);
    const identity = lstatSync(this.root);
    if (identity.isSymbolicLink() || identity.ino !== this.rootId.ino || identity.dev !== this.rootId.dev) conflict('绑定的大脑目录已发生变化。');
    let current = this.root;
    for (const part of relative.split('/')) {
      current = join(current, part);
      let stat = lstatSync(current, { throwIfNoEntry: false });
      if (!stat && create) {
        mkdirSync(current, { mode: 0o700 });
        stat = lstatSync(current);
      }
      if (!stat) throw Object.assign(new Error('目录尚不存在。'), { code: 'ENOENT' });
      if (!stat.isDirectory() || stat.isSymbolicLink()) conflict('目录包含无法安全访问的链接。');
    }
    return current;
  }

  children(relative: string) {
    try { return readdirSync(this.directory(relative), {withFileTypes: true}); }
    catch (error) { if (missing(error)) return []; throw error; }
  }

  read(relative: string): Buffer | null {
    validRelative(relative);
    try { return readRegular(join(this.directory(dirname(relative)), basename(relative))); }
    catch (error) { if (missing(error)) return null; throw error; }
  }

  stage(changes: Change[], path: string, before: Buffer | null, after: Buffer | null) {
    if (before && after && before.equals(after)) return;
    if (!before && !after) return;
    if (changes.some(c => c.path === path)) conflict('本次保存出现了重复目标文件。');
    changes.push({ path, before: before ? digest(before) : null, original: before?.toString('base64') ?? null, after: after?.toString('base64') ?? null, stage: randomUUID() });
  }

  private apply(c: Change) {
    if (!/^(?:01图书馆\/(?:01公域资料|02个人资料)\/|02日记本\/|03知识库\/)/u.test(c.path) || !c.path.endsWith('.md')) conflict('文件不在本次探讨的写入范围内。');
    const parent = this.directory(dirname(c.path), true);
    const target = join(parent, basename(c.path));
    const old = join(parent, '.discussion-' + c.stage + '.old');
    const next = c.after === null ? null : Buffer.from(c.after, 'base64');
    const actual = readRegular(target);
    const backup = readRegular(old);
    if (backup && digest(backup) !== c.before) conflict('目标出现了外部修改，已保留原文件版本。');
    if (actual && next && actual.equals(next) || actual === null && next === null) {
      if (backup) unlinkSync(old);
      return;
    }
    if (actual && digest(actual) !== c.before || !actual && c.before && !backup) conflict('笔记已在其他位置修改，请重新读取后再保存。');
    if (actual && backup) conflict('目标笔记出现了并发修改，两个版本均保留。');
    if (actual) {
      renameSync(target, old);
      const moved = readRegular(old);
      if (!moved || digest(moved) !== c.before) {
        try { linkSync(old, target); unlinkSync(old); } catch { /* Preserve both versions on collision. */ }
        conflict('笔记刚刚发生变化，请重新读取后再保存。');
      }
    }
    if (next) {
      try {
        const scratch = join(parent, '.discussion-' + randomUUID() + '.tmp');
        const fd = openSync(scratch, 'wx', 0o600);
        try {
          writeFileSync(fd, next);
          fsyncSync(fd);
          this.directory(dirname(c.path));
          linkSync(scratch, target);
        } finally { closeSync(fd); unlinkSync(scratch); }
      } catch (error) {
        // Keep the original readable if a full disk or I/O error prevents publication.
        if (c.before && !lstatSync(target, {throwIfNoEntry: false})) {
          try { linkSync(old, target); unlinkSync(old); } catch { /* Never overwrite a competing writer. */ }
        }
        throw error;
      }
    }
    const parentFd = openSync(parent, constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_RDONLY);
    try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    if (c.before) unlinkSync(old);
  }

  latestChatPath(path: string) {
    if (this.read(path)) return path;
    const db = new Database(this.state, { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare('SELECT target FROM discussion_renames WHERE source=?').get(path) as { target: string } | undefined;
      return row?.target ?? path;
    } finally { db.close(); }
  }

  run<R>(key: string, fingerprint: string, prepare: (session: (id: string) => SessionFile | undefined) => Prepared<R>): R {
    if (!secureExistingPrivateFile(this.state)) {
      try { closeSync(openSync(this.state, 'wx', 0o600)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      secureExistingPrivateFile(this.state);
    }
    const db = new Database(this.state);
    try {
      db.exec('CREATE TABLE IF NOT EXISTS discussion_plans (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, plan TEXT NOT NULL, done INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS discussion_files (id TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS discussion_renames (source TEXT PRIMARY KEY, target TEXT NOT NULL)');
      const receipt = () => db.prepare('SELECT fingerprint, plan, done FROM discussion_plans WHERE id=?').get(key) as { fingerprint: string; plan: string; done: number } | undefined;
      db.transaction(() => {
        const row = receipt();
        if (row) {
          if (row.done === -1) conflict('此前版本已经过期，请重新读取并整理。');
          if (row.fingerprint !== fingerprint) conflict('同一保存操作的内容已经变化，请重新保存。');
          return;
        }
        const pending = db.prepare('SELECT plan FROM discussion_plans WHERE done=0').all() as {plan: string}[];
        const plan = prepare(id => {
          const known = db.prepare('SELECT value FROM discussion_files WHERE id=?').get(id) as { value: string } | undefined;
          return known && JSON.parse(known.value) as SessionFile;
        });
        const targets = new Set(plan.changes.map(c => c.path));
        if (pending.some(p => (JSON.parse(p.plan) as Prepared<unknown>).changes.some(c => targets.has(c.path)))) conflict('同一笔记有尚未完成的保存，请先重试此前的操作。');
        db.prepare('INSERT INTO discussion_plans VALUES (?,?,?,0)').run(key, fingerprint, JSON.stringify(plan));
      }).immediate();
      // Each file has its own durable progress marker. The plan keeps original
      // bytes until every backlink is in place, including across a restart.
      try {
        for (;;) {
          const step = db.transaction(() => {
            const row = receipt()!;
            const plan = JSON.parse(row.plan) as Prepared<R> & { applied?: number };
            if (row.done === -1) conflict('此前版本已经过期，请重新读取并整理。');
            if (row.done === 1) return { complete: true as const, value: plan.result };
            const index = plan.applied ?? 0;
            const change = plan.changes[index];
            if (change) {
              this.apply(change);
              plan.applied = index + 1;
              db.prepare('UPDATE discussion_plans SET plan=? WHERE id=?').run(JSON.stringify(plan), key);
              return { complete: false as const };
            }
            if (plan.moved) db.prepare('INSERT OR REPLACE INTO discussion_renames VALUES (?,?)').run(plan.moved.from, plan.moved.to);
            if (plan.session) db.prepare('INSERT OR REPLACE INTO discussion_files VALUES (?,?)').run(plan.session.id, JSON.stringify(plan.session.value));
            db.prepare('UPDATE discussion_plans SET done=1, plan=? WHERE id=?').run(JSON.stringify({ result: plan.result }), key);
            return { complete: true as const, value: plan.result };
          }).immediate();
          if (step.complete) return step.value;
        }
      } catch (error) {
        if (error instanceof PublicApiError || (error as NodeJS.ErrnoException).code === 'EEXIST') {
          db.transaction(() => {
            const row = receipt()!;
            if (row.done !== 0) return;
            const plan = JSON.parse(row.plan) as Prepared<R> & { applied?: number };
            // Revert only our writes that still match byte for byte. Edits made
            // by another program survive, and the old snapshots stay in the journal.
            for (const c of plan.changes.slice(0, plan.applied ?? 0).reverse()) {
              const current = this.read(c.path);
              if (current?.toString('base64') !== (c.after ?? undefined)) continue;
              this.apply({ path: c.path, stage: randomUUID(), before: current ? digest(current) : null,
                after: c.original, original: c.after });
            }
            db.prepare('UPDATE discussion_plans SET done=-1 WHERE id=?').run(key);
          }).immediate();
          conflict('笔记在保存中发生变化，已保留外部修改；请重新读取后整理。');
        }
        throw error;
      }
    } finally { db.close(); }
  }
}
