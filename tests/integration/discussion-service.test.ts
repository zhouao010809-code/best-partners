import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { applyMigrations } from '../../src/server/db/migrate.js';
import { createDiscussionService } from '../../src/server/discussion/service.js';
import { CURRENT_VAULT_LAYOUT } from '../../src/shared/domain/vault-layout.js';
import type { ReadVaultGateway } from '../../src/server/vault/VaultGateway.js';
import type { AssistantAdapter } from '../../src/server/assistant/types.js';
import { parseFrontmatter } from '../../src/server/rules/frontmatter.js';
import { sha256Bytes } from '../../src/server/vault/raw-bytes.js';

it('discusses a selection, persists exact dialogue, confirms progress, merges the daily diary and links knowledge', async () => {
  const root = mkdtempSync(join(tmpdir(), 'discussion-workflow-'));
  const vaultRoot = join(root, 'vault');
  const stateRoot = join(root, 'state');
  const source = '01图书馆/01公域资料/网站/资料/资料.md';
  const directory = '03知识库/思考/对生活';
  const instant = new Date('2026-11-20T17:03:00Z');
  for (const path of [dirname(source), directory, '02日记本', '00大脑规则'])
    mkdirSync(join(vaultRoot, path), { recursive: true });
  mkdirSync(stateRoot);
  writeFileSync(join(vaultRoot, '00大脑规则/06知识库分类规则.md'), '### 1. 思考\n| 对生活 | 记录对生活的认识。 |');
  writeFileSync(
    join(vaultRoot, source),
    '---\n类型: 原始资料\n标题: 核对依据\n资料来源: 网站\n入馆时间: 2026-11-20-10:30\n探讨状态: 未探讨\n关联日记: []\n---\n\n正文原文\n'
  );
  const gateway: ReadVaultGateway = {
    layout: CURRENT_VAULT_LAYOUT,
    async listDirectory(path) {
      return readdirSync(join(vaultRoot, path), { withFileTypes: true }).map(
        (s) => s.name + (s.isDirectory() ? '/' : '')
      );
    },
    async readRaw(path) {
      const bytes = path.startsWith('00大脑规则/')
        ? Buffer.from('当前库规则 ' + path)
        : readFileSync(join(vaultRoot, path));
      return { path, bytes, rawSha256: sha256Bytes(bytes) };
    }
  };
  const calls: string[] = [];
  let fail = false;
  let includeKnowledge = true;
  const adapter: AssistantAdapter = {
    id: 'fixture',
    async describe() {
      return { id: 'fixture', name: 'Fixture', status: 'ready', defaultModel: 'fixture', models: [] };
    },
    async run(request) {
      expect(request.system).toContain('当前库规则');
      expect(request.signal).toBeInstanceOf(AbortSignal);
      const input = JSON.stringify(request.messages);
      calls.push(input);
      let text = '我想先听听你会怎样做。';
      if (request.system.includes('首次探讨的准备阶段')) text = '资料讲核对依据。可以开始吗？';
      if (request.system.includes('逐份判断')) {
        if (fail) throw Error('fixture provider offline');
        text = JSON.stringify({
          keywords: ['证据'],
          proposals: [{ path: source, status: '部分探讨完成', covered: '核对', remaining: '应用' }]
        });
      } else if (request.system.includes('现在整理这一天')) {
        text = JSON.stringify({
          body: '# 小兆日记｜2026-11-21\n\n我先核对依据。',
          keywords: ['证据'],
          materialPaths: [source],
          topics: includeKnowledge ? [{ topic: '核对依据', keywords: ['证据'] }] : []
        });
      } else if (request.system.includes('已有知识原文查重')) {
        text = JSON.stringify({
          knowledge: [
            {
              title: '核对依据',
              directory,
              coreContent: '先看依据。',
              body: '我先核对依据。',
              keywords: ['证据'],
              materialPaths: [source]
            }
          ]
        });
      }
      request.emit({ type: 'text', text });
    }
  };
  const db = new Database(join(stateRoot, 'local.sqlite'));
  applyMigrations(db);
  const config = {
    database: db,
    gateway,
    vaultRoot,
    stateRoot,
    adapter,
    refreshIndex: async () => true,
    now: () => instant
  };
  let service = createDiscussionService(config);
  try {
    const action = { type: 'start' as const, materialPaths: [source], requestId: randomUUID() };
    let session = await service.act(action);
    const { id } = session;
    expect(session.phase).toBe('prepared');
    expect((await service.act(action)).id).toBe(id);
    expect(calls).toHaveLength(1);
    await expect(service.act({ type: 'message', id, text: '提前' })).rejects.toThrow('先开始');
    await service.act({ type: 'begin', id });
    session = await service.act({ type: 'message', id, text: '我先核对依据。' });
    const oldRevision = session.updatedAt;
    session = await service.act({ type: 'pause', id, expectedUpdatedAt: oldRevision });
    expect(session.phase).toBe('paused');
    expect(session.proposals[0]?.status).toBe('部分探讨完成');
    expect(parseFrontmatter(readFileSync(join(vaultRoot, source))).data.探讨状态).toBe('未探讨');
    await expect(service.act({ type: 'resume', id, expectedUpdatedAt: oldRevision })).rejects.toThrow('已更新');
    await service.close();
    service = createDiscussionService(config);
    expect((await service.act({ type: 'open', id })).messages).toEqual(session.messages);
    session = await service.act({ type: 'confirm', id, progress: [{ path: source, status: '部分探讨完成' }] });
    expect(parseFrontmatter(readFileSync(join(vaultRoot, source))).data.探讨状态).toBe('部分探讨完成');
    expect(readFileSync(join(vaultRoot, session.chatPath!), 'utf8')).toContain('## 小兆\n\n我先核对依据。');
    await service.act({ type: 'resume', id });
    await service.act({ type: 'message', id, text: '我也会看适用条件。' });
    session = await service.act({ type: 'diary', id });
    expect(session.knowledgePaths).toHaveLength(1);
    expect(session.diaryMarkdown).toContain('我先核对依据');
    const diary = readFileSync(join(vaultRoot, session.diaryPath!), 'utf8');
    expect(diary).toContain('03知识库/思考/对生活/核对依据');
    const previousCalls = calls.length;
    expect((await service.act({ type: 'diary', id })).diaryPath).toBe(session.diaryPath);
    expect(calls).toHaveLength(previousCalls);
    await service.act({ type: 'message', id, text: '今天先到这里。' });
    fail = true;
    const ended = await service.act({ type: 'end', id });
    expect(ended.phase).toBe('ended');
    expect(ended.notice).toContain('聊天已保存');
    expect(ended.chatPath).not.toBe(session.chatPath);
    await service.act({ type: 'confirm', id, progress: [{ path: source, status: '全面探讨完成' }] });
    expect(parseFrontmatter(readFileSync(join(vaultRoot, source))).data.探讨状态).toBe('全面探讨完成');
    const next = await service.act({ type: 'start', materialPaths: [source] });
    expect(next.phase).toBe('active');
    expect(calls.at(-1)).toContain('我也会看适用条件');
    const direct = await service.act({ type: 'start', materialPaths: [], text: '我今天有点紧张。' });
    expect(direct.phase).toBe('active');
    includeKnowledge = false;
    expect((await service.act({ type: 'diary', id: direct.id })).knowledgePaths).toEqual([]);
  } finally {
    await service.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('continues a historical conversation without rewriting it and keeps its original words as reference after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'discussion-history-'));
  const vaultRoot = join(root, 'vault'),
    stateRoot = join(root, 'state');
  const directory = '02日记本/2026/2026-10/2026-10-19';
  const path = directory + '/聊天记录｜2026-10-19_10：00-10：08.md';
  const unlinked = directory + '/聊天记录｜2026-10-19_16：00-16：15.md';
  const missingSource = '01图书馆/01公域资料/网站/已回收.md';
  const original = [
    '---',
    '类型: 聊天记录',
    '开始时间: "2026-10-19-10:00"',
    '结束时间: "2026-10-19-10:08"',
    '关联资料: ["[[' + missingSource.slice(0, -3) + ']]"]',
    '关联日记: []',
    '关键词: ["试课"]',
    '接续记录: []',
    '---',
    '',
    '## 小兆',
    '',
    '上次我想聊试课时的反应。',
    '',
    '## AI',
    '',
    '你当时观察到了什么？',
    ''
  ].join('\n');
  mkdirSync(join(vaultRoot, directory), { recursive: true });
  mkdirSync(stateRoot);
  writeFileSync(join(vaultRoot, path), original);
  writeFileSync(join(vaultRoot, unlinked), original.replace(/关联资料: .+/, '关联资料: []'));
  const gateway: ReadVaultGateway = {
    layout: CURRENT_VAULT_LAYOUT,
    async listDirectory() {
      return [];
    },
    async readRaw(file) {
      const bytes = file.startsWith('00大脑规则/') ? Buffer.from('库内规则') : readFileSync(join(vaultRoot, file));
      return { path: file, bytes, rawSha256: sha256Bytes(bytes) };
    }
  };
  const contexts: unknown[] = [];
  const adapter: AssistantAdapter = {
    id: 'history-fixture',
    async describe() {
      return { id: this.id, name: 'test', status: 'ready', models: [], defaultModel: 'test' };
    },
    async run(input) {
      contexts.push(input.messages);
      input.emit({
        type: 'text',
        text: input.system.includes('proposals') ? '{"keywords":[],"proposals":[]}' : '这次想从哪个问题继续？'
      });
    }
  };
  const db = new Database(':memory:');
  applyMigrations(db);
  const config = { database: db, vaultRoot, stateRoot, gateway, adapter, refreshIndex: async () => true };
  let service = createDiscussionService(config);
  try {
    expect(service.history().map((row) => row.path)).toEqual(expect.arrayContaining([path, unlinked]));
    expect(service.history()[0]).not.toHaveProperty('body');
    expect(service.readHistory(path).body).toContain('上次我想聊试课');
    expect(contexts).toHaveLength(0);
    const action = { type: 'continueChat' as const, chatPath: path, requestId: randomUUID() };
    const session = await service.act(action);
    expect(session.phase).toBe('active');
    expect(session.materialPaths).toEqual([]);
    expect(session.notice).toContain('未载入');
    expect(session.messages).toEqual([{ role: 'assistant', text: '这次想从哪个问题继续？' }]);
    expect(JSON.stringify(contexts.at(-1))).toContain('上次我想聊试课');
    expect((await service.act(action)).id).toBe(session.id);
    expect(contexts).toHaveLength(1);
    await service.close();
    service = createDiscussionService(config);
    await service.act({ type: 'message', id: session.id, text: '今天再说说观察到的第二件事。' });
    expect(JSON.stringify(contexts.at(-1))).toContain('上次我想聊试课时的反应。');
    const paused = await service.act({ type: 'pause', id: session.id });
    const note = readFileSync(join(vaultRoot, paused.chatPath!), 'utf8');
    expect(note).toContain(path.slice(0, -3));
    expect(note).toContain('今天再说说观察到的第二件事。');
    expect(note).not.toContain('上次我想聊试课时的反应。');
    expect(service.history().some((row) => row.path === paused.chatPath)).toBe(false);
    expect(readFileSync(join(vaultRoot, path), 'utf8')).toBe(original);
    const plain = await service.act({ type: 'continueChat', chatPath: unlinked });
    expect(plain.notice).toBeUndefined();
    expect(plain.materialPaths).toEqual([]);
  } finally {
    await service.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
