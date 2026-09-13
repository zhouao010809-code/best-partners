import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DeepSeekSettings } from '../../src/client/components/DeepSeekSettings.js';

const ok = <T,>(value: T) => ({ ok: true as const, value });
const settings = { available: true, configured: true, providerHost: 'api.deepseek.com', model: 'deepseek-v4-flash' } as const;
const deepSeek = { get: vi.fn(), setKey: vi.fn(), clearKey: vi.fn(), verifyConnection: vi.fn() };
const refreshHealth = vi.fn();
vi.mock('../../src/client/app/ConsoleRuntime.js', () => ({ useConsoleRuntime: () => ({ api: { deepSeek }, refreshHealth }) }));

beforeEach(() => {
  deepSeek.get.mockResolvedValue(ok(settings));
  deepSeek.setKey.mockResolvedValue(ok(settings));
  deepSeek.clearKey.mockResolvedValue(ok({ ...settings, configured: false }));
  deepSeek.verifyConnection.mockResolvedValue(ok({ ...settings, verification: { status: 'verified', checkedAt: '2026-09-09T02:00:00Z', message: 'DeepSeek 已响应测试消息。' } }));
  refreshHealth.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it.each(['rejected', 'cancelled', 'failed'] as const)('recovers from a %s settings read through an explicit retry', async (failure) => {
  if (failure === 'rejected') deepSeek.get.mockRejectedValueOnce(new TypeError('offline'));
  if (failure === 'cancelled') deepSeek.get.mockResolvedValueOnce({ ok: false, cancelled: true });
  if (failure === 'failed') deepSeek.get.mockResolvedValueOnce({ ok: false, state: { status: 'disconnected', message: '无法读取设置。' } });
  const user = userEvent.setup();
  render(<DeepSeekSettings />);
  expect(await screen.findByRole('alert')).toBeVisible();
  expect(screen.getByText('不可用')).toBeVisible();
  expect(screen.queryByText('未配置')).not.toBeInTheDocument();
  expect(screen.queryByText('正在读取模型设置…')).not.toBeInTheDocument();
  expect(deepSeek.get).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: '重新读取模型设置' }));
  expect(await screen.findByLabelText('DeepSeek API Key')).toBeVisible();
  expect(screen.getByText('待验证')).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(deepSeek.get).toHaveBeenCalledTimes(2);
});

it('labels unavailable storage accurately and offers a reload without enabling key changes', async () => {
  deepSeek.get.mockResolvedValue(ok({ ...settings, available: false, configured: false, problem: '安全存储不可用。' }));
  render(<DeepSeekSettings />);
  expect(await screen.findByText('安全存储不可用。')).toBeVisible();
  expect(screen.getByText('不可用')).toBeVisible();
  expect(screen.queryByText('未配置')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('DeepSeek API Key')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重新读取模型设置' })).toBeEnabled();
});

it('masks the current input during save and clears it only after a successful trimmed save', async () => {
  let resolveSave!: (value: ReturnType<typeof ok<typeof settings>>) => void;
  deepSeek.setKey.mockImplementationOnce(() => new Promise((resolve) => { resolveSave = resolve; }));
  const user = userEvent.setup();
  render(<DeepSeekSettings />);
  const input = await screen.findByLabelText('DeepSeek API Key');
  expect(input).toHaveAttribute('type', 'password');
  expect(input).toHaveValue('');
  expect(screen.getByRole('button', { name: '显示本次输入的密钥' })).toBeDisabled();
  await user.type(input, '  sk-example-only  ');
  await user.click(screen.getByRole('button', { name: '显示本次输入的密钥' }));
  expect(input).toHaveAttribute('type', 'text');
  expect(screen.getByRole('button', { name: '隐藏本次输入的密钥' })).toHaveAttribute('aria-pressed', 'true');
  await user.dblClick(screen.getByRole('button', { name: '保存密钥' }));
  expect(deepSeek.setKey).toHaveBeenCalledExactlyOnceWith('sk-example-only');
  expect(input).toHaveValue('  sk-example-only  ');
  expect(input).toHaveAttribute('type', 'password');
  expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled();
  await act(async () => { resolveSave(ok(settings)); });
  expect(input).toHaveValue('');
  expect(await screen.findByText(/已保存在本机.*尚未验证连接/u)).toBeVisible();
  expect(screen.getByRole('button', { name: '显示本次输入的密钥' })).toBeDisabled();
  expect(deepSeek.verifyConnection).not.toHaveBeenCalled();
});

it('preserves a failed save for retry without exposing it or automatically testing the connection', async () => {
  deepSeek.setKey.mockRejectedValueOnce(new Error('offline'));
  const user = userEvent.setup();
  render(<DeepSeekSettings />);
  const input = await screen.findByLabelText('DeepSeek API Key');
  await user.type(input, 'sk-unsaved-retry');
  await user.click(screen.getByRole('button', { name: '显示本次输入的密钥' }));
  await user.click(screen.getByRole('button', { name: '保存密钥' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('未能保存');
  expect(input).toHaveValue('sk-unsaved-retry');
  expect(input).toHaveAttribute('type', 'password');
  await user.click(screen.getByRole('button', { name: '保存密钥' }));
  await waitFor(() => expect(input).toHaveValue(''));
  expect(deepSeek.setKey).toHaveBeenCalledTimes(2);
  expect(deepSeek.verifyConnection).not.toHaveBeenCalled();
});

it('distinguishes unreadable saved credentials from an unconfigured model and allows recovery', async () => {
  deepSeek.get.mockResolvedValue(ok({ ...settings, configured: false, problem: '已保存的密钥无法读取，请重新保存或移除。' }));
  render(<DeepSeekSettings />);
  expect(await screen.findByRole('alert')).toHaveTextContent('已保存的密钥无法读取');
  expect(screen.getByText('读取异常')).toBeVisible();
  expect(screen.queryByText('未配置')).not.toBeInTheDocument();
  expect(screen.getByLabelText('DeepSeek API Key')).toBeEnabled();
  expect(screen.getByRole('button', { name: '移除密钥' })).toBeEnabled();
  expect(screen.getByRole('button', { name: '验证连接' })).toBeDisabled();
});

it('only verifies explicitly, prevents concurrent verification and invalidates the visible result while editing', async () => {
  let resolveVerification!: (value: unknown) => void;
  deepSeek.verifyConnection.mockImplementationOnce(() => new Promise((resolve) => { resolveVerification = resolve; }));
  const user = userEvent.setup();
  render(<DeepSeekSettings />);
  const input = await screen.findByLabelText('DeepSeek API Key');
  expect(deepSeek.verifyConnection).not.toHaveBeenCalled();
  expect(screen.getByText(/固定测试消息/u)).toBeVisible();
  await user.dblClick(screen.getByRole('button', { name: '验证连接' }));
  expect(deepSeek.verifyConnection).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: '正在验证…' })).toBeDisabled();
  await act(async () => { resolveVerification(ok({ ...settings, verification: { status: 'verified', checkedAt: '2026-09-09T02:00:00Z', message: 'DeepSeek 已响应测试消息。' } })); });
  expect(screen.getByText('验证成功')).toBeVisible();
  expect(screen.getByText('DeepSeek 已响应测试消息。')).toBeVisible();
  await user.type(input, 'sk-new-unsaved');
  expect(screen.getByText('有未保存更改')).toBeVisible();
  expect(screen.queryByText('验证成功')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: '验证连接' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '保存密钥' }));
  expect(await screen.findByText('待验证')).toBeVisible();
  expect(deepSeek.verifyConnection).toHaveBeenCalledTimes(1);
});

it('shows a failed connection check with an explicit retry instead of claiming the model is ready', async () => {
  deepSeek.verifyConnection.mockResolvedValueOnce(ok({ ...settings, verification: { status: 'failed', checkedAt: '2026-09-09T02:00:00Z', message: '密钥验证失败，请重新保存有效密钥。' } }));
  const user = userEvent.setup();
  render(<DeepSeekSettings />);
  await user.click(await screen.findByRole('button', { name: '验证连接' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('密钥验证失败');
  expect(screen.getByText('验证失败')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '验证连接' }));
  expect(await screen.findByText('验证成功')).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('does not keep a green result when a new verification request fails to reach the local service', async () => {
  deepSeek.get.mockResolvedValue(ok({ ...settings, verification: { status: 'verified', checkedAt: '2026-09-09T02:00:00Z', message: '此前验证成功。' } }));
  deepSeek.verifyConnection.mockRejectedValueOnce(new Error('local service offline'));
  const user = userEvent.setup();
  render(<DeepSeekSettings />);
  expect(await screen.findByText('验证成功')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '验证连接' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('验证未完成');
  expect(screen.queryByText('验证成功')).not.toBeInTheDocument();
  expect(screen.queryByText('此前验证成功。')).not.toBeInTheDocument();
});

it('keeps removal deliberate and identifies removal, rather than saving, while it is pending', async () => {
  let resolveClear!: (value: ReturnType<typeof ok<{ available: true; configured: false; providerHost: 'api.deepseek.com'; model: 'deepseek-v4-flash' }>>) => void;
  deepSeek.clearKey.mockImplementationOnce(() => new Promise((resolve) => { resolveClear = resolve; }));
  const user = userEvent.setup();
  render(<DeepSeekSettings />);
  const input = await screen.findByLabelText('DeepSeek API Key');
  await user.type(input, 'sk-unsaved-example');
  await user.click(screen.getByRole('button', { name: '显示本次输入的密钥' }));
  await user.click(screen.getByRole('button', { name: '移除密钥' }));
  expect(deepSeek.clearKey).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '保留密钥' }));
  expect(screen.queryByRole('button', { name: '确认移除密钥' })).not.toBeInTheDocument();
  expect(deepSeek.clearKey).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: '移除密钥' }));
  await user.click(screen.getByRole('button', { name: '确认移除密钥' }));
  expect(screen.getByRole('button', { name: '正在移除…' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: '正在保存…' })).not.toBeInTheDocument();
  expect(input).toHaveValue('sk-unsaved-example');
  expect(input).toHaveAttribute('type', 'password');
  await act(async () => { resolveClear(ok({ ...settings, configured: false })); });
  expect(input).toHaveValue('');
  expect(await screen.findByText('密钥已从本机移除。已保存的候选不会删除。')).toBeVisible();
  expect(screen.getByText('未配置')).toBeVisible();
  expect(deepSeek.clearKey).toHaveBeenCalledTimes(1);
});

it('aborts the read when the settings component unmounts', async () => {
  let signal: AbortSignal | undefined;
  deepSeek.get.mockImplementationOnce((value: AbortSignal) => { signal = value; return new Promise(() => {}); });
  const view = render(<DeepSeekSettings />);
  await waitFor(() => expect(signal).toBeInstanceOf(AbortSignal));
  view.unmount();
  expect(signal?.aborted).toBe(true);
});
