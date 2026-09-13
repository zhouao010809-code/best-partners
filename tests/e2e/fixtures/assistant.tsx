import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AppRouter } from '../../../src/client/app/router.js';
import type { ReadConsoleApi, HealthSnapshot } from '../../../src/client/api/client.js';
import type { AssistantConversation, AssistantSend } from '../../../src/shared/api/assistant.js';
import '../../../src/client/styles/tokens.css';
import '../../../src/client/styles/global.css';
import '../../../src/client/styles/shell.css';
import '../../../src/client/styles/extraction.css';

// All provider, chat and settings operations in this fixture stay in memory.
const scenario = new URLSearchParams(location.search).get('scenario');
const ok = <T,>(value: T) => ({ ok: true as const, value });
let ticks = 0;
let failed = scenario === 'error';
const reply = '我找到了两份值得一起看的资料，它们都在回答一个问题：**怎样让一个想法变得值得被读完？**\n\n第一份强调从具体场景切入，让读者认出自己遇到的问题。[S1]\n\n第二份更关注信息顺序：先给判断，再解释理由，最后留下可以试一次的行动。[S2]\n\n结合起来，你可以先用一句话写清“这个内容帮谁解决什么”，再检查每一段是否推进了这个问题。';
const conversations: AssistantConversation[] = [];
const archived: AssistantConversation = { id: '22314a4c-c450-441b-9398-ce85b8ffda20', title: '关于内容创作的方法', createdAt: '2026-09-08T08:00:00Z', updatedAt: '2026-09-08T08:05:00Z', status: 'idle', providerId: 'deepseek', model: 'deepseek-v4-pro', effort: 'high', scope: 'brain', messages: [{ id: 'u-old', role: 'user', text: '怎样把收藏的想法用到创作中？', sources: [], actions: [] }, { id: 'a-old', role: 'assistant', text: reply, model: 'deepseek-v4-pro', sources: [{ id: 'S1', title: '从具体问题开始创作', path: '02知识库/03内容/从具体问题开始创作.md' }, { id: 'S2', title: '好内容的信息顺序', path: '01图书馆/来自个人/好内容的信息顺序.md' }], actions: [{ id: 'review-1', type: 'review', label: '审阅提炼的知识候选', runId: '13a87459-252b-41f6-b1fb-c50dfc2cf2db' }] }] };
conversations.push(archived);
const health: HealthSnapshot = { status: 'ready', vaultSource: { status: 'ready', adapter: 'filesystem', displayName: '我的大脑 · 示例' }, index: { status: 'ready', version: 47, refreshedAt: '2026-09-09T08:00:00Z' }, model: { status: 'configured', providerHost: 'api.deepseek.com', name: 'deepseek-v4-pro' }, writeGate: { status: 'blocked', missing: ['ruleApproval', 'nativeWritePrimitives', 'capabilityProfile', 'recoveryKernel'], fingerprintMatches: false }, schemaIssues: { status: 'available', count: 0 } };
Object.defineProperty(window, 'xiaozhaoDesktop', { configurable: true, value: { getAppVersion: async () => '0.1.0', chooseVaultDirectory: async () => ({ selected: false, reason: 'unchanged' }), getVaultInfo: async () => ({ displayName: '我的大脑 · 示例', path: '/Users/example/Documents/我的大脑' }), openVaultDirectory: async () => {} } });
const api = {
  getHealth: async () => ok(health),
  deepSeek: { get: async () => ok({ available: true, configured: true, providerHost: 'api.deepseek.com', model: 'deepseek-v4-pro' }), setKey: async () => ok({ available: true, configured: true, providerHost: 'api.deepseek.com', model: 'deepseek-v4-pro' }), clearKey: async () => ok({ available: true, configured: false, providerHost: 'api.deepseek.com', model: 'deepseek-v4-pro' }) },
  listDocumentIssues: async () => ok({ items: [] }),
  listLibrary: async ({ title = '' }: { title?: string }) => ok({ items: [{ path: '01图书馆/来自个人/好内容的信息顺序.md', title: '好内容的信息顺序' }].filter(item => item.title.includes(title)) }),
  listKnowledge: async ({ search = '' }: { search?: string }) => ok({ items: [{ path: '02知识库/03内容/从具体问题开始创作.md', title: '从具体问题开始创作' }].filter(item => item.title.includes(search)) }),
  trash: { list: async () => ok({ items: [] }) }, intakeTrash: { list: async () => ok({ items: [] }) },
  assistant: {
    providers: async () => {
      if (failed) { failed = false; throw new Error('Fixture unavailable'); }
      return ok({ providers: [{ id: 'deepseek', name: 'DeepSeek', status: scenario === 'unconfigured' ? 'unconfigured' : 'ready', models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', reasoningEfforts: ['high', 'max'], recommended: true }, { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', reasoningEfforts: ['high', 'max'] }], defaultModel: 'deepseek-v4-pro', defaultEffort: 'max' }, { id: 'secondary-provider', name: '备用服务', status: scenario === 'unconfigured' ? 'unconfigured' : 'ready', models: [{ id: 'secondary-model-v1', name: '备用模型 V1', reasoningEfforts: ['low', 'medium', 'high', 'ultra'], recommended: true }], defaultModel: 'secondary-model-v1', defaultEffort: 'ultra' }] });
    },
    history: async () => ok({ conversations }),
    get: async (id: string) => {
      const item = conversations.find(value => value.id === id)!;
      if (item.status === 'running') {
        ticks += 1; const message = item.messages.at(-1)!;
        message.activity = ticks < 2 ? '正在查找相关知识…' : '正在整理回答…'; message.text = reply.slice(0, Math.max(0, (ticks - 2) * 45));
        if (ticks >= 10) { item.status = 'idle'; message.sources = archived.messages[1]!.sources; message.actions = archived.messages[1]!.actions; }
      }
      return ok(structuredClone(item));
    },
    send: async (input: AssistantSend) => {
      ticks = 0;
      let item = conversations.find(value => value.id === input.conversationId);
      if (!item) { item = { id: crypto.randomUUID(), title: input.message, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'running', providerId: input.providerId, model: input.model, effort: input.effort, scope: input.scope, messages: [] }; conversations.unshift(item); }
      item.status = 'running'; item.messages.push({ id: crypto.randomUUID(), role: 'user', text: input.message, sources: [], actions: [], scope: input.scope, ...(input.contextPath ? { contextPath: input.contextPath } : {}) }, { id: crypto.randomUUID(), role: 'assistant', text: '', sources: [], actions: [], model: input.model, activity: '正在思考…' });
      return ok(structuredClone(item));
    },
    stop: async (id: string) => { const item = conversations.find(value => value.id === id)!; item.status = 'stopped'; return ok(structuredClone(item)); },
    login: async () => ok({ message: '示例：请在浏览器完成服务登录。', authUrl: 'https://auth.example.com/' })
  }
} as unknown as ReadConsoleApi;
createRoot(document.getElementById('root')!).render(<MemoryRouter initialEntries={['/settings']}><AppRouter api={api} /></MemoryRouter>);
