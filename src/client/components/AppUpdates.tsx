import { useEffect, useRef, useState } from 'react';
import type { UpdateSnapshot } from '../../shared/desktop/update.js';

type Action = 'check' | 'download' | 'cancel' | 'install' | 'open';
type ActionError = { action: Action; message: string };

function displayTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '时间不可用' : new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
}

export function AppUpdates() {
  const desktop = window.xiaozhaoDesktop;
  const [snapshot, setSnapshot] = useState<UpdateSnapshot>({ transfer: { status: 'idle' }, automaticInstall: false });
  const [pending, setPending] = useState<readonly Action[]>([]);
  const pendingActions = useRef(new Set<Action>());
  const [actionError, setActionError] = useState<ActionError>();
  const [readError, setReadError] = useState(false);
  const mounted = useRef(false);
  const eventRevision = useRef(0);

  useEffect(() => {
    mounted.current = true;
    let active = true;
    let receivedEvent = false;
    const unsubscribe = desktop?.onUpdateState?.((value) => {
      if (!active) return;
      receivedEvent = true;
      eventRevision.current += 1;
      setSnapshot(value);
      setReadError(false);
    });
    void desktop?.getUpdateState?.().then((value) => {
      if (active && !receivedEvent) setSnapshot(value);
    }).catch(() => {
      if (active && !receivedEvent) setReadError(true);
    });
    return () => { active = false; mounted.current = false; unsubscribe?.(); };
  }, [desktop]);

  async function run(action: Action, operation: () => Promise<void>, failure: string) {
    if (pendingActions.current.has(action)) return;
    pendingActions.current.add(action);
    setPending([...pendingActions.current]);
    setActionError(undefined);
    try { await operation(); }
    catch { if (mounted.current) setActionError({ action, message: failure }); }
    finally {
      pendingActions.current.delete(action);
      if (mounted.current) setPending([...pendingActions.current]);
    }
  }

  function checkUpdates() {
    if (!desktop?.checkForUpdates) return;
    const revision = eventRevision.current;
    void run('check', async () => {
      const result = await desktop.checkForUpdates!();
      if (mounted.current && eventRevision.current === revision) setSnapshot((value) => ({ ...value, result }));
      if (mounted.current) setReadError(false);
    }, '暂时无法检查应用更新，请稍后重试。');
  }

  function openLink(url: string) {
    void run('open', async () => {
      if (desktop?.openUpdateDownload) await desktop.openUpdateDownload(url);
      else window.open(url, '_blank', 'noopener,noreferrer');
    }, '未能打开下载页面，请重试或使用 Release 页面地址。');
  }

  const { transfer } = snapshot;
  const update = snapshot.result?.status === 'available' ? snapshot.result : undefined;
  const automatic = Boolean(snapshot.automaticInstall && update?.automaticUpdateUrl);
  const canDownload = Boolean((update?.download || automatic) && desktop?.downloadUpdate && desktop?.installUpdate && desktop?.getUpdateState && desktop?.onUpdateState);
  const checking = pending.includes('check');
  const checkFailed = snapshot.result?.status === 'error' || actionError?.action === 'check';
  const downloading = transfer.status === 'downloading';
  const installing = transfer.status === 'installing';
  const ready = transfer.status === 'ready';
  const automaticReady = ready && transfer.mode === 'automatic' && automatic;
  const errorMessage = actionError?.message ?? (transfer.status === 'error' ? transfer.message : undefined);
  const progress = downloading && transfer.totalBytes !== undefined && transfer.totalBytes > 0
    && transfer.receivedBytes !== undefined && Number.isFinite(transfer.totalBytes) && Number.isFinite(transfer.receivedBytes)
    ? Math.min(100, Math.max(0, Math.floor(transfer.receivedBytes / transfer.totalBytes * 100))) : undefined;

  return <section className="settings-section settings-card settings-updates" aria-label="应用更新">
    <header className="settings-section__heading">
      <div><h2>应用更新</h2><p>检查新版本并选择何时更新</p></div>
    </header>
    <div className="settings-section__body">
      {desktop?.checkForUpdates ? <>
        <div className="settings-updates__actions">
          <button type="button" className="settings-button" disabled={checking || downloading || installing || pending.includes('download') || pending.includes('install')} onClick={checkUpdates}>
            {checking ? '正在检查…' : checkFailed ? '重试检查' : '检查应用更新'}
          </button>
        </div>
        {checking && <p className="settings-feedback" role="status">正在检查应用更新…</p>}
        {!checking && snapshot.result?.status === 'up-to-date' && <p className="settings-feedback" role="status">已是最新版本</p>}
        {!checking && checkFailed && <p className="settings-feedback settings-feedback--error" role="alert">暂时无法检查应用更新，请稍后重试。</p>}
        {readError && <p className="settings-feedback settings-feedback--error" role="alert">未能读取更新状态，请重新检查应用更新。</p>}
        {update && <div className="settings-updates__result">
          <p className="settings-updates__version" role="status">发现新版本 {update.version}</p>
          <p className="settings-updates__meta">当前版本 {update.currentVersion}{update.publishedAt ? ` · 发布于 ${displayTime(update.publishedAt)}` : ''}</p>
          <p className="settings-updates__notes">{update.notes}</p>
          {canDownload && <p className="settings-updates__meta">{automatic
            ? '下载完成后，重启应用即可完成更新。' : '下载完成后打开安装包，按提示替换应用。'}</p>}
          {downloading && <div>
            <p className="settings-feedback" role="status">{progress === undefined ? '正在下载更新…' : `正在下载更新 · ${progress}%`}</p>
            <progress aria-label="更新下载进度" max={100} {...(progress === undefined ? {} : { value: progress })} />
          </div>}
          {ready && <p className="settings-feedback" role="status">更新已下载，版本 {transfer.version}</p>}
          {installing && <p className="settings-feedback" role="status">正在重启并安装更新…</p>}
          <div className="settings-updates__actions">
            {downloading ? (transfer.mode === 'installer' && desktop.cancelUpdate && <button type="button" className="settings-button" disabled={pending.includes('cancel')} onClick={() => void run('cancel', () => desktop.cancelUpdate!(), '未能取消下载，请重试。')}>
              {pending.includes('cancel') ? '正在取消…' : '取消下载'}
            </button>) : ready ? (desktop.installUpdate && <button type="button" className="settings-button settings-button--primary" disabled={pending.includes('install')} onClick={() => void run('install', () => desktop.installUpdate!(), automaticReady ? '未能重启安装更新，请重试。' : '未能打开安装包，请重试。')}>
              {pending.includes('install') ? (automaticReady ? '正在重启…' : '正在打开…') : automaticReady ? '重启并更新' : '打开安装包'}
            </button>) : !installing && (canDownload ? <button type="button" className="settings-button settings-button--primary" disabled={checking || pending.includes('download')} onClick={() => void run('download', () => desktop.downloadUpdate!(), '下载未完成，请重试。')}>
              {pending.includes('download') ? '准备下载…' : transfer.status === 'error' || actionError?.action === 'download' ? '重试下载' : '下载更新'}
            </button> : <button type="button" className="settings-button settings-button--primary" disabled={pending.includes('open')} onClick={() => openLink(update.assetUrl)}>打开下载页面</button>)}
            {update.releaseUrl && <button type="button" className="settings-button settings-button--quiet" disabled={pending.includes('open')} onClick={() => openLink(update.releaseUrl)}>查看 Release 页面</button>}
          </div>
          {errorMessage && actionError?.action !== 'check' && <p className="settings-feedback settings-feedback--error" role="alert">{errorMessage}</p>}
        </div>}
      </> : <p className="settings-feedback" role="status">桌面版可用，浏览器预览不会检查应用更新。</p>}
    </div>
  </section>;
}
