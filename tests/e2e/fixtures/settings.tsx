import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppRouter } from '../../../src/client/app/router.js';
import type { ReadConsoleApi, HealthSnapshot } from '../../../src/client/api/client.js';
import '../../../src/client/styles/tokens.css';
import '../../../src/client/styles/global.css';
import '../../../src/client/styles/shell.css';
import '../../../src/client/styles/extraction.css';

// Isolated visual fixture. All settings and document operations stay in memory.
const scenario = new URLSearchParams(location.search).get('scenario');
let configured = scenario !== 'unconfigured';
let failRead = scenario === 'error';
let failHealth = scenario === 'offline';
let failSave = scenario === 'save-error';
let failLocation = scenario === 'location-error';
let failOpen = scenario === 'location-error';
let credentialProblem = scenario === 'storage-error';
let verification: { status: 'verified' | 'failed'; checkedAt: string; message: string } | undefined;
const ok = <T,>(value: T) => ({ ok: true as const, value });
const modelSettings = () => ({ available: scenario !== 'unavailable', configured: configured && !credentialProblem, providerHost: 'api.deepseek.com' as const, model: 'deepseek-v4-flash' as const,
  ...(credentialProblem ? { problem: '已保存的密钥无法读取，请重新保存或移除。' } : {}), ...(verification ? { verification } : {}) });
const health = (): HealthSnapshot => ({
  status: 'ready', vaultSource: { status: 'ready', adapter: 'filesystem', displayName: '我的大脑 · 示例' },
  index: { status: 'ready', version: 47, refreshedAt: '2026-09-08T08:42:00.000Z' },
  model: configured ? { status: 'configured', providerHost: 'api.deepseek.com', name: 'deepseek-v4-flash' } : { status: 'unconfigured', providerHost: 'api.deepseek.com' },
  writeGate: { status: 'blocked', missing: ['ruleApproval', 'nativeWritePrimitives', 'capabilityProfile', 'recoveryKernel'], fingerprintMatches: false },
  schemaIssues: { status: 'available', count: scenario === 'empty' ? 0 : 21 }
});
window.xiaozhaoDesktop = {
  getAppVersion: async () => '0.1.0', chooseVaultDirectory: async () => ({ selected: false, reason: 'unchanged' }),
  getVaultInfo: async () => { if (failLocation) { failLocation = false; throw new Error('Fixture location unavailable'); } return { displayName: '我的大脑 · 示例', path: '/Users/example/Documents/个人知识管理/我的大脑 · 示例' }; },
  openVaultDirectory: async () => { if (failOpen) { failOpen = false; throw new Error('Fixture Finder unavailable'); } },
  revealDocument: async () => {}
};
const api = {
  getHealth: async () => {
    if (failHealth) { failHealth = false; return { ok: false as const, state: { status: 'disconnected' as const, message: '无法连接本地服务。' } }; }
    return ok(health());
  },
  getIndexVersion: async () => ok({ version: 47, status: 'ready' }),
  deepSeek: {
    get: async () => { if (failRead) { failRead = false; throw new Error('Fixture unavailable'); } return ok(modelSettings()); },
    setKey: async () => { if (failSave) { failSave = false; return { ok: false, state: { status: 'operation-error', message: '密钥设置未能保存，请重试。' } }; } configured = true; credentialProblem = false; verification = undefined; return ok(modelSettings()); },
    clearKey: async () => { configured = false; credentialProblem = false; verification = undefined; return ok(modelSettings()); },
    verifyConnection: async () => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      verification = { status: scenario === 'verification-failed' ? 'failed' : 'verified', checkedAt: new Date().toISOString(), message: scenario === 'verification-failed' ? '密钥验证失败，请检查 DeepSeek API Key 后重新保存。' : 'DeepSeek 已响应测试消息，当前连接可用。' };
      return ok(modelSettings());
    }
  },
  listDocumentIssues: async () => ok({ items: scenario === 'empty' ? [] : [
    { path: '01图书馆/来自个人/一份等待确认信息的资料.md', code: 'FRONTMATTER_INVALID', message: 'FRONTMATTER_OPENING_DELIMITER_MISSING' },
    { path: '02知识库/09学习/这是用于窄屏验收的很长很长的知识文件标题与完整路径.md', code: 'UNEXPECTED_TYPE', message: 'type' }
  ] }),
  getDocumentDetail: async (path: string) => ok({ path, title: '隔离资料', markdown: '# 原文示例\n\n这里展示只读内容。\n<script>此标签应只作为文本显示</script>', versionMarker: { rawSha256: 'a'.repeat(64) } }),
  trash: { list: async () => ok({ items: [] }) },
  intakeTrash: { list: async () => ok({ items: [] }) },
  listOperations: async () => ok({ items: [], counts: { all: 0, attention: 0, running: 0 }, issues: [] })
} as unknown as ReadConsoleApi;
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/settings']}><AppRouter api={api} /></MemoryRouter>);
