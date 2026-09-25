import { useEffect, useId, useRef, useState } from 'react';
import { Eye, EyeOff, LockKeyhole } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useConsoleRuntime } from '../app/ConsoleRuntime.js';
import { MODEL_SETTINGS_UPDATED_EVENT } from '../modelSettingsEvents.js';
import type { DeepSeekSettings as Settings } from '../../shared/api/extraction.js';

export function DeepSeekSettings() {
  const { api, refreshHealth } = useConsoleRuntime();
  const { hash } = useLocation();
  const service = api.deepSeek;
  const section = useRef<HTMLElement>(null);
  const keyInputId = useId();
  const [settings, setSettings] = useState<Settings>();
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [key, setKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'success' | 'error'; message: string }>();
  const [busy, setBusy] = useState<'saving' | 'clearing' | 'checking' | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [revision, setRevision] = useState(0);
  const lifetime = useRef<AbortController | undefined>(undefined);
  const pending = useRef(false);

  useEffect(() => {
    if (hash === '#ai-model-settings' && loadState !== 'loading') section.current?.scrollIntoView?.({ block: 'start' });
  }, [hash, loadState]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    setSettings(undefined);
    setLoadState('loading');
    setFeedback(undefined);

    async function readSettings() {
      if (!service) return;
      try {
        const result = await service.get(controller.signal);
        if (controller.signal.aborted) return;
        if (result.ok) {
          setSettings(result.value);
          setLoadState('ready');
          if (revision > 0 && result.value.available && !result.value.problem) {
            window.dispatchEvent(new Event(MODEL_SETTINGS_UPDATED_EVENT));
          }
        } else {
          setLoadState('error');
          setFeedback({ tone: 'error', message: 'state' in result
            ? result.state.message ?? '模型设置暂时不可用，请重试。'
            : '模型设置读取已取消，请重新读取。' });
        }
      } catch {
        if (controller.signal.aborted) return;
        setLoadState('error');
        setFeedback({ tone: 'error', message: '模型设置暂时不可用，请重试。' });
      }
    }

    void readSettings();
    return () => controller.abort();
  }, [service, revision]);

  async function update(clear: boolean) {
    const signal = lifetime.current?.signal;
    const enteredKey = key.trim();
    if (!service || !settings?.available || pending.current || signal?.aborted || (!clear && enteredKey === '')) return;
    pending.current = true;
    setBusy(clear ? 'clearing' : 'saving');
    setFeedback(undefined);
    setShowKey(false);
    const failureMessage = clear ? '密钥未能移除，请重试。' : '密钥设置未能保存，请重试。';
    try {
      const result = await (clear ? service.clearKey() : service.setKey(enteredKey));
      // The mutation outlives this page; mounted consumers must still refresh.
      if (result.ok) window.dispatchEvent(new Event(MODEL_SETTINGS_UPDATED_EVENT));
      if (signal?.aborted) return;
      if (result.ok) {
        setSettings(result.value);
        setKey('');
        setConfirmClear(false);
        setFeedback({ tone: 'success', message: clear
          ? '密钥已从本机移除。已保存的候选不会删除。'
          : '密钥已保存在本机，尚未验证连接。点击“验证连接”确认是否可用。' });
        void Promise.resolve(refreshHealth()).catch(() => {});
      } else {
        setFeedback({ tone: 'error', message: 'state' in result ? result.state.message ?? failureMessage : failureMessage });
      }
    } catch {
      if (!signal?.aborted) setFeedback({ tone: 'error', message: failureMessage });
    } finally {
      pending.current = false;
      if (!signal?.aborted) setBusy(null);
    }
  }

  async function verifyConnection() {
    const signal = lifetime.current?.signal;
    if (!service?.verifyConnection || !settings?.configured || !settings.available || settings.problem
      || key !== '' || pending.current || signal?.aborted) return;
    pending.current = true;
    setBusy('checking');
    setSettings((current) => {
      if (!current) return current;
      const next = { ...current };
      delete next.verification;
      return next;
    });
    setFeedback(undefined);
    setConfirmClear(false);
    try {
      const result = await service.verifyConnection();
      if (signal?.aborted) return;
      if (result.ok) {
        setSettings(result.value);
        if (!result.value.verification) setFeedback({ tone: 'error', message: '密钥配置已变化，请重新验证当前连接。' });
      } else {
        setFeedback({ tone: 'error', message: 'state' in result
          ? result.state.message ?? '验证未完成，请检查网络后重试。'
          : '验证已取消，可重新验证连接。' });
      }
    } catch {
      if (!signal?.aborted) setFeedback({ tone: 'error', message: '验证未完成，请检查网络后重试。' });
    } finally {
      pending.current = false;
      if (!signal?.aborted) setBusy(null);
    }
  }

  const unavailable = !service || loadState === 'error' || (loadState === 'ready' && !settings?.available);
  const credentialProblem = settings?.available ? settings.problem : undefined;
  const verification = key === '' && busy === null && !credentialProblem ? settings?.verification : undefined;
  const status = unavailable ? '不可用' : loadState === 'loading' ? '读取中' : credentialProblem ? '读取异常'
    : busy === 'checking' ? '验证中' : busy === 'saving' ? '保存中' : busy === 'clearing' ? '移除中'
      : key !== '' ? '有未保存更改' : verification?.status === 'verified' ? '验证成功'
        : verification?.status === 'failed' ? '验证失败' : settings?.configured ? '待验证' : '未配置';
  const statusColor = unavailable || credentialProblem || verification?.status === 'failed' ? 'amber'
    : verification?.status === 'verified' ? 'green' : 'silver';
  const canVerify = Boolean(service?.verifyConnection && settings?.available && settings.configured && !credentialProblem && key === '' && busy === null);

  return (
    <section ref={section} id="ai-model-settings" className="deepseek-settings settings-section settings-card" aria-label="DeepSeek 设置">
      <header className="settings-section__heading">
        <div><h2>AI 模型</h2><p>用于问问、资料提炼与知识候选生成</p></div>
        <span className={`settings-chip settings-chip--${statusColor}`}>{status}</span>
      </header>
      <div className="settings-section__body">
        {!service ? <p className="settings-feedback" role="status">请打开最新版桌面 App 配置模型。</p>
          : loadState === 'loading' ? <p className="settings-feedback" role="status">正在读取模型设置…</p>
          : <>
            {settings && <dl className="settings-model-meta">
              <div><dt>服务商</dt><dd>{settings.providerHost}</dd></div>
              <div><dt>模型</dt><dd>{settings.model}</dd></div>
            </dl>}
            {settings?.available ? <>
              {credentialProblem && <p className="settings-feedback settings-feedback--error" role="alert">{credentialProblem}</p>}
              <div className="settings-verification">
                <div className="settings-verification__result">
                  <p role={verification?.status === 'failed' ? 'alert' : 'status'}>{busy === 'checking' ? '正在确认 DeepSeek 能否响应…'
                    : key !== '' ? '先保存新密钥，再验证连接。'
                      : verification?.message ?? (settings.configured && !credentialProblem ? '密钥已保存，连接尚未验证。' : '保存有效密钥后，即可验证连接。')}</p>
                  {verification && <small>最近验证于 <time dateTime={verification.checkedAt}>{new Date(verification.checkedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></small>}
                </div>
                <button className={`settings-button${canVerify ? ' settings-button--primary' : ''}`} type="button" disabled={!canVerify} onClick={() => void verifyConnection()}>{busy === 'checking' ? '正在验证…' : '验证连接'}</button>
              </div>
              <p className="settings-verification__note">点击验证会向 DeepSeek 发送一条固定测试消息，不含你的资料，可能产生少量 API 费用。</p>
              {!service.verifyConnection && <p className="settings-verification__note">更新桌面 App 后可使用连接验证。</p>}
              <form className="settings-key-form" onSubmit={(event) => { event.preventDefault(); void update(false); }}>
                <div className="settings-key-field"><label htmlFor={keyInputId}>DeepSeek API Key</label>
                  <span className="settings-key-input">
                    <input id={keyInputId} type={showKey ? 'text' : 'password'} value={key} onChange={(event) => setKey(event.target.value)} autoComplete="off" spellCheck={false}
                      maxLength={512} placeholder={settings.configured ? '输入新密钥可替换当前密钥' : '在这里粘贴你的 API Key'} disabled={busy !== null} />
                    <button className="settings-key-visibility settings-icon-button" type="button" disabled={busy !== null || key === ''} aria-label={showKey ? '隐藏本次输入的密钥' : '显示本次输入的密钥'}
                      title={showKey ? '隐藏本次输入的密钥' : '显示本次输入的密钥'} aria-pressed={showKey} onClick={() => setShowKey((value) => !value)}>
                      {showKey ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                    </button>
                  </span>
                </div>
                <div className="settings-key-actions">
                  {(settings.configured || credentialProblem) && <button className="settings-button settings-button--quiet" type="button" disabled={busy !== null} onClick={() => setConfirmClear(true)}>移除密钥</button>}
                  <button className="settings-button settings-button--primary" type="submit" disabled={busy !== null || key.trim() === ''}>{busy === 'saving' ? '正在保存…' : '保存密钥'}</button>
                </div>
              </form>
              <p className="settings-key-note"><LockKeyhole aria-hidden="true" /><span>密钥加密保存在本机。保存密钥不会发送测试消息或提炼资料。</span></p>
              {confirmClear && <div className="settings-key-confirm">
                <p>移除后将暂停新的问问与提炼，已有候选仍保留。</p>
                <div className="settings-key-actions">
                  <button className="settings-button" type="button" disabled={busy !== null} onClick={() => void update(true)}>{busy === 'clearing' ? '正在移除…' : '确认移除密钥'}</button>
                  <button className="settings-button" type="button" disabled={busy !== null} onClick={() => setConfirmClear(false)}>保留密钥</button>
                </div>
              </div>}
            </> : settings && <p className="settings-feedback settings-feedback--error" role="status">{settings.problem || '本机安全密钥存储不可用，请在桌面 App 中重试。'}</p>}
            {feedback && <p className={`settings-feedback${feedback.tone === 'error' ? ' settings-feedback--error' : ''}`} role={feedback.tone === 'error' ? 'alert' : 'status'}>{feedback.message}</p>}
            {(unavailable || credentialProblem) && <button type="button" className="settings-button" disabled={busy !== null} onClick={() => setRevision((value) => value + 1)}>重新读取模型设置</button>}
          </>}
      </div>
    </section>
  );
}
