import { useEffect, useState } from 'react';
import { BookOpen, RefreshCw } from 'lucide-react';

type Status = 'checking' | 'connected' | 'unavailable' | 'failed';
type Bridge = {
  openClipperInstall?: () => Promise<void>;
  installClipperHost?: () => Promise<void>;
  getClipperStatus?: () => Promise<{ installed: boolean; connected: boolean; message?: string }>;
};

export function DistributionChecklist({ bridge = typeof window === 'undefined' ? undefined : window.xiaozhaoDesktop }: { bridge?: Bridge }) {
  const [status, setStatus] = useState<Status>('unavailable');
  const [message, setMessage] = useState('');
  const [guideError, setGuideError] = useState(false);
  const check = async () => {
    if (!bridge?.getClipperStatus) return;
    setStatus('checking'); setMessage('');
    try { const result = await bridge.getClipperStatus(); setStatus(result.connected ? 'connected' : result.installed ? 'failed' : 'unavailable'); setMessage(result.message ?? ''); }
    catch { setStatus('failed'); setMessage('暂时无法检查配置，请稍后重试。'); }
  };
  useEffect(() => { void check(); }, [bridge]);
  const install = async () => {
    if (!bridge?.installClipperHost) return;
    setStatus('checking'); setMessage('');
    try { await bridge.installClipperHost(); setStatus('connected'); }
    catch { setStatus('failed'); setMessage('配置未完成，请按安装说明重试。'); }
  };
  const openGuide = async () => {
    setGuideError(false);
    try { await bridge?.openClipperInstall?.(); }
    catch { setGuideError(true); }
  };
  return <section id="browser-clipper" className="settings-section settings-card settings-clipper" aria-labelledby="settings-clipper-heading">
    <header className="settings-section__heading">
      <div><h2 id="settings-clipper-heading">浏览器收藏</h2><p>将 Chrome 或 Edge 中的网页保存到收件箱</p></div>
      <span className={`settings-chip settings-chip--${status === 'connected' ? 'green' : status === 'failed' ? 'amber' : 'silver'}`} role="status">
        <i aria-hidden="true" />{status === 'connected' ? '本机已配置' : status === 'checking' ? '正在检查' : status === 'failed' ? '配置待确认' : '未配置'}
      </span>
    </header>
    <div className="settings-section__body">
      <p className="settings-clipper__note">{status === 'connected'
        ? '在浏览器收藏一篇网页，确认收件箱收到，即可开始使用。'
        : '先按安装说明添加浏览器插件，再配置它与当前大脑的连接。'}</p>
      <div className="settings-clipper__actions">
        {bridge?.openClipperInstall && <button className="settings-button" type="button" onClick={() => void openGuide()}><BookOpen aria-hidden="true" />打开安装说明</button>}
        {bridge?.installClipperHost && <button className="settings-button" type="button" onClick={() => void install()} disabled={status === 'checking'}>{status === 'connected' ? '重新配置' : '配置连接'}</button>}
        {bridge?.getClipperStatus && <button className="settings-button settings-button--quiet" type="button" onClick={() => void check()} disabled={status === 'checking'}><RefreshCw aria-hidden="true" />检查配置</button>}
      </div>
      <p className="settings-clipper__optional">浏览器插件需单独安装，文件导入和粘贴文本不受影响。</p>
      {status === 'failed' && <p className="settings-feedback settings-feedback--error" role="alert">{message || '当前大脑的连接配置待确认，请重新配置。'}</p>}
      {guideError && <p className="settings-feedback settings-feedback--error" role="alert">未能打开安装说明，请重试。</p>}
    </div>
  </section>;
}
