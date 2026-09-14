// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClientResult, ReadConsoleApi } from '../../src/client/api/client.js';
import type { SkillDetail, SkillsPage as SkillsPageData } from '../../src/shared/api/skills.js';
import { SkillsPage } from '../../src/client/pages/SkillsPage.js';

const skill = {
  id: 'a'.repeat(64),
  name: '公众号排版发布',
  description: '把文章排版成可发布的微信公众号 HTML。',
  revision: 'b'.repeat(64)
} as const;

const detail: SkillDetail = {
  ...skill,
  markdown: '# 发布流程\n\n先检查素材，再生成排版。\n\n<script>alert(1)</script>',
  references: ['README.md', 'templates/style.md']
};

const ok = <T,>(value: T): ApiClientResult<T> => ({ ok: true, value });
const failed = <T,>(message = 'Skill 服务暂时不可用。'): ApiClientResult<T> => ({
  ok: false,
  state: { status: 'disconnected', message }
});

const list = vi.fn<(...args: [AbortSignal?]) => Promise<ApiClientResult<SkillsPageData>>>();
const get = vi.fn<(...args: [string, AbortSignal?]) => Promise<ApiClientResult<SkillDetail>>>();

const runtime: {
  api: Pick<ReadConsoleApi, 'skills'>;
  health: { status: string; data: { index: { status: string } } };
  dataRevision: number;
  refreshHealth: () => Promise<void>;
} = {
  api: { skills: { list, get } },
  health: { status: 'ready', data: { index: { status: 'ready' } } },
  dataRevision: 0,
  refreshHealth: vi.fn(async () => undefined)
};

vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({
  useConsoleRuntime: () => runtime
}));

function renderPage() {
  return render(<SkillsPage />);
}

beforeEach(() => {
  runtime.api = { skills: { list, get } };
  list.mockResolvedValue(ok({ items: [skill] }));
  get.mockResolvedValue(ok(detail));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SkillsPage', () => {
  it('loads the local catalog and presents read-only skill summaries', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: '公众号排版发布' })).toBeVisible();
    expect(screen.getByText(skill.description)).toBeVisible();
    expect(screen.getByText(`版本 ${skill.revision.slice(0, 8)}`)).toBeVisible();
    expect(screen.getByRole('button', { name: '查看方法：公众号排版发布' })).toBeEnabled();
    expect(screen.getByText('只读目录')).toBeVisible();
    expect(screen.queryByRole('button', { name: /执行|编辑|保存/u })).not.toBeInTheDocument();
    expect(list).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it('opens a selected skill detail and renders its markdown and references', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: '查看方法：公众号排版发布' }));

    expect(await screen.findByRole('heading', { name: '公众号排版发布' })).toBeVisible();
    expect(screen.getByText('先检查素材，再生成排版。')).toBeVisible();
    expect(screen.queryByText('<script>alert(1)</script>')).not.toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeVisible();
    expect(screen.getByText('templates/style.md')).toBeVisible();
    expect(screen.getByRole('button', { name: '返回 Skill 库' })).toBeVisible();
    expect(get).toHaveBeenCalledWith(skill.id, expect.any(AbortSignal));
  });

  it('offers an explicit retry when the catalog cannot be read', async () => {
    const user = userEvent.setup();
    list.mockResolvedValueOnce(failed('本地 Skill 目录暂时无法读取。'));
    list.mockResolvedValueOnce(ok({ items: [skill] }));
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('本地 Skill 目录暂时无法读取。');
    const retry = screen.getByRole('button', { name: '重新读取 Skill 库' });
    await user.click(retry);
    expect(await screen.findByRole('heading', { name: '公众号排版发布' })).toBeVisible();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('turns the catalog unavailable response into a clear local-connection message', async () => {
    list.mockResolvedValueOnce({
      ok: false,
      code: 'SKILL_CATALOG_UNAVAILABLE',
      state: { status: 'operation-error', message: 'Skill catalog is unavailable.' }
    });
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('当前连接不提供 Skill 库。');
    expect(screen.getByText('请使用支持本地文件 Skill 的桌面连接。')).toBeVisible();
  });

  it('retries a detail read without changing the selected skill', async () => {
    const user = userEvent.setup();
    get.mockResolvedValueOnce(failed('本地 Skill 方法暂时无法读取。'));
    get.mockResolvedValueOnce(ok(detail));
    renderPage();

    await user.click(await screen.findByRole('button', { name: '查看方法：公众号排版发布' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('本地 Skill 方法暂时无法读取。');
    await user.click(screen.getByRole('button', { name: '重新读取 Skill 方法' }));
    expect(await screen.findByText('先检查素材，再生成排版。')).toBeVisible();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('explains where to add a skill when the catalog is empty', async () => {
    list.mockResolvedValue(ok({ items: [] }));
    renderPage();

    expect(await screen.findByText('在 .claude/skills 下添加 Skill 文件夹')).toBeVisible();
    expect(screen.getByText('当前还没有可浏览的 Skill。')).toBeVisible();
  });

  it('does not show an empty success state when a refresh fails after an empty read', async () => {
    const user = userEvent.setup();
    list.mockResolvedValueOnce(ok({ items: [] }));
    list.mockResolvedValueOnce(failed('刷新 Skill 目录失败。'));
    renderPage();

    expect(await screen.findByText('当前还没有可浏览的 Skill。')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '刷新 Skill 库' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('刷新 Skill 目录失败。');
    expect(screen.queryByText('当前还没有可浏览的 Skill。')).not.toBeInTheDocument();
  });

  it('reports a clear unavailable state when this connection has no skill API', async () => {
    runtime.api = {};
    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('当前连接不提供 Skill 库。');
    expect(screen.getByText('请使用支持本地文件 Skill 的桌面连接。')).toBeVisible();
  });
});
