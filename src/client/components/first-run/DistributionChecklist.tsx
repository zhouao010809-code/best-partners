import { useEffect, useState } from 'react';

type Status = 'checking' | 'connected' | 'unavailable' | 'failed';
type Bridge = {
  openClipperInstall?: () => Promise<void>;
  installClipperHost?: () => Promise<void>;
  getClipperStatus?: () => Promise<{ installed: boolean; connected: boolean; message?: string }>;
};

export function DistributionChecklist({ bridge = typeof window === 'undefined' ? undefined : window.xiaozhaoDesktop }: { bridge?: Bridge }) {
  const [status, setStatus] = useState<Status>('unavailable');
  const [message, setMessage] = useState('');
  const check = async () => {
    if (!bridge?.getClipperStatus) return;
    setStatus('checking');
    try { const result = await bridge.getClipperStatus(); setStatus(result.connected ? 'connected' : result.installed ? 'failed' : 'unavailable'); setMessage(result.message ?? ''); }
    catch { setStatus('failed'); setMessage('暂时无法检查连接，请稍后重试。'); }
  };
  useEffect(() => { void check(); }, [bridge]);
  const install = async () => {
    if (!bridge?.installClipperHost) return;
    setStatus('checking'); setMessage('');
    try { await bridge.installClipperHost(); setStatus('connected'); setMessage('安装完成，可以开始收藏网页。'); }
    catch { setStatus('failed'); setMessage('安装未完成，请按说明重试。'); }
  };
  return <section className="distribution-checklist" aria-label="首次分发设置">
    <h2>把资料送进大脑</h2><p>模板已创建。安装浏览器收藏插件后，可把网页资料直接送入收件箱。</p>
    <div><strong>安装浏览器收藏插件</strong>{bridge?.openClipperInstall && <button type="button" onClick={() => void bridge.openClipperInstall!()}>打开安装说明</button>}<button type="button" onClick={() => void install()} disabled={status === 'checking'}>{status === 'checking' ? '正在连接…' : '安装并配置'}</button></div>
    <p role={status === 'failed' ? 'alert' : 'status'}>{status === 'connected' ? '已连接，可以开始收藏网页。' : status === 'unavailable' ? '尚未连接。你也可以直接使用文件导入或粘贴文本。' : status === 'checking' ? '正在测试连接…' : message || '连接失败，可重试或继续使用备用入口。'}</p>
    <button type="button" onClick={() => void check()} disabled={status === 'checking'}>测试连接</button>
    <p>文件导入和粘贴文本入口始终可用，插件不是必需条件。</p>
  </section>;
}
